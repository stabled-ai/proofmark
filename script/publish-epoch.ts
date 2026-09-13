/**
 * Publishes an epoch roster (Mode B) and proves it landed.
 *
 * Mode A carries one mark at a time: an individual proof that subject X was issued at source
 * block N. It proves issuance and says nothing about a revocation nobody submitted.
 * Mode B publishes the whole active set as one sorted-key Merkle root. Membership is the mark;
 * absence from that asserted set can be proved, but its reason cannot. It does not establish a
 * legal sanction or guarantee publisher completeness, which remains an explicit trust assumption.
 *
 * The tree itself is `pipeline/roster.ts` and its Solidity twin `src/lib/RosterProof.sol`. This
 * script does not reimplement either; it imports the TypeScript side and then asks the deployed
 * contracts whether they agree.
 *
 * Usage (repository root):
 *
 *     npx tsx script/publish-epoch.ts             # same as --dry-run
 *     npx tsx script/publish-epoch.ts --dry-run   # build the roster, print the plan, send nothing
 *     npx tsx script/publish-epoch.ts --publish    # one epoch transaction; never grants roles
 *     npx tsx script/publish-epoch.ts --resume-publication # recover stored source tx; no new epoch
 *     npx tsx script/publish-epoch.ts --check-publication # original journal source/carry/current check; no private key
 *     npx tsx script/publish-epoch.ts --cancel-unsigned-publication # explicit local unsigned cancellation
 *     npx tsx script/publish-epoch.ts --check      # view calls only: is the on-chain root ours, do the proofs verify
 *     npx tsx script/publish-epoch.ts --help
 *
 * Publication lifecycle modes (--publish, --resume-publication, --cancel-unsigned-publication)
 * load .env and the dedicated key/journal. Other modes run with no key. New sends require a fresh v3 sanctions snapshot and compatible epoch-v2
 * contracts; public RPC defaults do not imply the historical deployment is compatible.
 *
 * This script keeps publication standalone. The historical ASC v1 cannot safely process mixed
 * receipts; ASC v2 processes every trusted lifecycle log atomically. Do not infer that the old
 * deployment supports batching merely because the working-tree implementation now does.
 */
import { ethers } from 'ethers';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRoster, inclusionProof, nonInclusionProof, leafIndexOf, rosterLeaf,
  verifyInclusion, verifyNonInclusion,
  type RosterEntry, type RosterTree,
} from '../pipeline/roster.js';
import { ROSTER_REGISTRY_ABI, ROSTER_SELECTORS, requireRosterV2 } from '../pipeline/roster-format.js';
import {
  buildSourceRoster, assertSourceSnapshot, type SnapshotReceipt, type SourceSnapshotManifest,
} from '../pipeline/roster-source.js';
import { SourceCheckpointStore } from '../pipeline/roster-source-checkpoint.js';
import { loadLists } from '../aml/loader.js';
import type { ListProvenance } from '../aml/provenance.js';
import { boundedEpochParams, EPOCH_SOURCE_ABI, requireEpochV2 } from '../pipeline/epoch.js';
import { ROSTER_AUTH_ABI, requireRosterAuthorization, rosterApprovalData, readRootApprovals, type RosterApprovalMessage } from '../pipeline/roster-authorization.js';
import { EpochPublicationJournal, PublicationJournalError, type PublicationEntry, type PublicationConfirmation } from '../pipeline/epoch-publication-journal.js';
import { PUBLICATION_ABI, advancePublication, evmPublicationTransport, reobservePublication, type PublicationTransport } from '../pipeline/epoch-publication-delivery.js';
import { sourceEpochRecord, writeEpochRecord } from '../pipeline/epoch-record.js';
import { writeVaultEnvelope } from '../pipeline/vault-atomic.js';
import { captureEpochHub, assertEpochHub, type EpochHubObservation } from '../pipeline/epoch-observation.js';
import { expectedDemoIssuer, checkEpochPolicies } from '../pipeline/epoch-policy.js';
import { epochRuntimePins, checkEpochRuntimes } from '../pipeline/epoch-runtime.js';
import { observeEpochCarry, requireCurrentPublishedEpoch } from '../pipeline/epoch-carry.js';
import { finalizeRosterBundleReplicas, stageRosterBundleReplicas, type PrepublicationRosterRecord, type StagedRosterBundleReplicas } from '../pipeline/roster-bundle-availability.js';
import type { RosterBundle, RosterScope } from '../pipeline/roster-bundle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const deployment = JSON.parse(readFileSync(join(REPO, 'deployments', 'cc3-testnet.json'), 'utf8')) as {
  contracts: { ComplianceSource: string; ProofmarkASC: string; ProofmarkRegistry: string };
  sourceDeployment?: { transactionHash: string };
};

// ── Address book. The checked-in deployment is the default; shell env can override it. ──

let SOURCE_ADDRESS   = process.env.SOURCE_CONTRACT_ADDRESS ?? deployment.contracts.ComplianceSource;
let ASC_ADDRESS      = process.env.ASC_CONTRACT_ADDRESS ?? deployment.contracts.ProofmarkASC;
let REGISTRY_ADDRESS = process.env.REGISTRY_CONTRACT_ADDRESS ?? deployment.contracts.ProofmarkRegistry;

const DEFAULT_SOURCE_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEFAULT_SOURCE_HEADER_RPC = 'https://rpc.sepolia.org';
const DEFAULT_HUB_RPC    = 'https://rpc.cc3-testnet.creditcoin.network';

/** The current demo holder: passes frozen sandbox policy 2, fails production policy 1. */
const DEMO_SUBJECT = '0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2';
/** Never issued to: the fail-closed non-membership demonstration for the current deployment. */
const NEVER_ISSUED = '0x00000000000000000000000000000000DeaDBeef';

const POLICY_PILOT = 2n;        // KR sandbox pilot, requireAll 0x10024, regime 2
const POLICY_PRODUCTION = 1n;   // KR production, requireAll 0x10024, regime 1

// ── ABIs. Hand-written fragments, so the script runs without `forge build`. ──


const SOURCE_ABI = [
  'function lastEpoch() view returns (uint32)',
  'function owner() view returns (address)',
  'function isEpochPublisher(address) view returns (bool)',
  'function isIssuer(address) view returns (bool)',
  ...EPOCH_SOURCE_ABI,
  ...ROSTER_AUTH_ABI,
];

const ASC_ABI = [
  'function sourceContract() view returns (address)',
  'function expectedChainKey() view returns (uint64)',
  'function ROSTER_AUTH_VERSION() view returns (uint256)',
  'function epochIssuerApproved(uint32,address) view returns (bool)',
  'function EPOCH_SCHEMA_VERSION() view returns (uint256)',
  'function epochListVersion() view returns (uint32)',
  'function epochSourceCutoff() view returns (uint40)',
  'function epochPublishedAt() view returns (uint40)',
  'function epochSnapshotId() view returns (bytes32)',
  'function tombstone(address) view returns (bool)',
  'function latestEpoch() view returns (uint32)',
  'function epochValidUntil() view returns (uint40)',
  'function epochRoots(uint32) view returns (bytes32)',
  'function isRosterFresh() view returns (bool)',
  'function getMark(address) view returns (tuple(uint8 status, uint8 origin, uint8 kind, uint8 assurance, uint16 regime, uint16 jurisdiction, uint32 methods, uint40 issuedAt, uint40 expiry, uint32 epoch, bytes32 claimsRoot, bytes32 evidenceHash, address issuer))',
];

const REGISTRY_ABI = [...ROSTER_REGISTRY_ABI, 'function ASC() view returns (address)'];

// ── Small helpers ──

const num = (name: string, dflt: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`environment variable ${name} must be a non-negative integer, got ${v}`);
  return n;
};

const say  = (s = '') => console.log(s);
const ok   = (s: string) => console.log(`  ok ${s}`);
const bad  = (s: string) => console.error(`  x  ${s}`);
const step = (s: string) => console.log(`\n${s}`);

const mmss = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');
const short = (h: string) => `${h.slice(0, 10)}…`;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Retry an RPC read.
 *
 * The default public Sepolia endpoint is load balanced across backends that do not agree with each
 * other, and some answers arrive as transport errors ("could not coalesce error"). Reads are free
 * and idempotent, so retrying one is strictly better than failing the run. Nothing that writes
 * goes through here.
 */
async function retry<T>(label: string, fn: () => Promise<T>, attempts = num('RPC_ATTEMPTS', 5)): Promise<T> {
  let last: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      if (i < attempts) await sleep(400 * i);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${last?.shortMessage ?? last?.message ?? last}`);
}

// ── 1. Roster construction ─────────────────────────────────────────────────────

interface Excluded { subject: string; reason: string }
interface Roster {
  tree: RosterTree; excluded: Excluded[]; scannedFrom: number; scannedTo: number; startMethod: string;
  sourceSnapshot: SourceSnapshotManifest;
}

/** Source lifecycle, not the hub's possibly delayed view, defines the cutoff set. */
async function buildFromChain(src: ethers.JsonRpcProvider, headers: ethers.JsonRpcProvider, hub: ethers.JsonRpcProvider, cutoffBlock?: number, cutoffHash?: string, hubBlockNumber?: number): Promise<Roster> {
  if (process.env.SOURCE_FROM_BLOCK) throw new Error('SOURCE_FROM_BLOCK is not a completeness anchor; supply verified SOURCE_DEPLOYMENT_TX');
  const deploymentTx = process.env.SOURCE_DEPLOYMENT_TX ||
    (SOURCE_ADDRESS.toLowerCase() === deployment.contracts.ComplianceSource.toLowerCase() ? deployment.sourceDeployment?.transactionHash : undefined);
  if (!deploymentTx) throw new Error('SOURCE_DEPLOYMENT_TX or matching deployment.sourceDeployment.transactionHash is required; no historical floor fallback');
  const hubBlock = await hub.getBlock(hubBlockNumber ?? 'latest');
  if (!hubBlock?.hash) throw new Error('hub binding block unavailable');
  if (hubBlockNumber !== undefined && hubBlock.number !== hubBlockNumber) throw new Error('hub binding block number mismatch');
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);
  const [sourceAddress, chainKey] = await Promise.all([
    asc.sourceContract({ blockTag: hubBlock.number }), asc.expectedChainKey({ blockTag: hubBlock.number }),
  ]);
  if (sourceAddress.toLowerCase() !== SOURCE_ADDRESS.toLowerCase() || chainKey !== 1n ||
      (await hub.getBlock(hubBlock.number))?.hash !== hubBlock.hash) throw new Error('ASC source binding changed or mismatched');
  const checkpointPath = process.env.SOURCE_SNAPSHOT_CHECKPOINT_PATH, checkpointKey = process.env.SOURCE_SNAPSHOT_CHECKPOINT_KEY;
  if (Boolean(checkpointPath) !== Boolean(checkpointKey)) throw new Error('SOURCE_SNAPSHOT_CHECKPOINT_PATH and SOURCE_SNAPSHOT_CHECKPOINT_KEY must be configured together');
  const store = checkpointPath && checkpointKey ? new SourceCheckpointStore(checkpointPath, checkpointKey,
    { chainId: 11155111n, source: SOURCE_ADDRESS, deploymentTx }) : undefined;
  let snapshot: Awaited<ReturnType<typeof buildSourceRoster>>;
  try {
    const saved = store?.load();
    const checkpoint = saved && (cutoffBlock === undefined || saved.blockNumber < cutoffBlock) ? saved : undefined;
    snapshot = await buildSourceRoster(src, { source: SOURCE_ADDRESS, chainId: 11155111n, deploymentTx,
      confirmations: num('SOURCE_CONFIRMATIONS', 12), headerReader: headers, checkpoint, cutoffBlock, expectedCutoffHash: cutoffHash,
      checkpointSink: store && (!saved || cutoffBlock === undefined || cutoffBlock > saved.blockNumber)
        ? value => store.save(value) : undefined,
      logChunk: num('SOURCE_SCAN_CHUNK', 100), maxBlocks: num('SOURCE_SNAPSHOT_MAX_BLOCKS', 20_000),
      maxReceipts: num('SOURCE_SNAPSHOT_MAX_RECEIPTS', 200_000),
      receiptConcurrency: num('SOURCE_RECEIPT_CONCURRENCY', 6), receiptRetries: num('SOURCE_RECEIPT_RETRIES', 3) });
  } finally { store?.close(); }
  const m = snapshot.manifest;
  say(`  source snapshot blocks ${m.deploymentBlock}..${m.cutoffBlock}, ${m.receipts} receipts, ${m.sourceLogs} source logs`);
  say(`  cutoff hash ${m.cutoffBlockHash}; transcript ${m.blocksDigest}`);
  return { ...snapshot, scannedFrom: m.deploymentBlock, scannedTo: m.cutoffBlock,
    startMethod: 'verified source deployment transaction', sourceSnapshot: m };
}

function printRoster(r: Roster): void {
  const { tree } = r;
  step(`Roster — ${tree.entries.length} active mark(s), ${tree.leaves.length} leaves including both sentinels`);
  tree.entries.forEach((e, i) => {
    say(`  in   ${e.subject}  leaf ${leafIndexOf(i)}  attrs ${e.attrs}`);
  });
  for (const x of r.excluded) say(`  out  ${x.subject}  excluded: ${x.reason}`);
  say(`  root ${tree.root}`);
}

/** Proves the tree we are about to publish against the same code the contract mirrors. */
function selfCheck(tree: RosterTree): void {
  step('Self-check against pipeline/roster.ts');
  let inclusionOk = true;
  tree.entries.forEach((e, i) => {
    const idx = leafIndexOf(i);
    if (!verifyInclusion(tree.root, rosterLeaf(e), inclusionProof(tree, idx))) {
      inclusionOk = false;
      bad(`inclusion failed for ${e.subject} at leaf ${idx}`);
    }
  });
  if (!inclusionOk) throw new Error('EPOCH_VERIFICATION_FAILED');
  say('  self-check inclusion: ok');

  let nonInclusionOk = true;
  for (const target of [NEVER_ISSUED]) {
    try {
      if (!verifyNonInclusion(tree.root, target, nonInclusionProof(tree, target))) {
        nonInclusionOk = false;
        bad(`non-inclusion failed for ${target}`);
      }
    } catch (e: any) {
      nonInclusionOk = false;
      bad(`non-inclusion proof unavailable for ${target}: ${e?.message ?? e}`);
    }
  }
  if (!nonInclusionOk) throw new Error('EPOCH_VERIFICATION_FAILED');
  say('  self-check non-inclusion: ok');
}

// ── 2. Epoch parameters ────────────────────────────────────────────────────────

interface EpochParams { listVersion: number; validDays: number; validUntil: number; sourceCutoff: number; snapshotId: string; provenance: ListProvenance }

async function epochParams(src: ethers.JsonRpcProvider, roster: Roster, frozen?: ApprovalBundle): Promise<EpochParams> {
  if (process.env.EPOCH_LIST_VERSION || process.env.EPOCH_VALID_DAYS) throw new Error('legacy epoch overrides are unsupported; use a fresh snapshot and EPOCH_VALID_HOURS <=24');
  const [block, lists] = await Promise.all([src.getBlock(roster.scannedTo), loadLists(join(REPO, 'data/raw'), 'epoch')]);
  if (!block) throw new Error('source cutoff block unavailable');
  if (block.hash !== roster.sourceSnapshot.cutoffBlockHash || block.timestamp !== roster.sourceSnapshot.cutoffTimestamp) throw new Error('source cutoff changed after snapshot replay');
  if (frozen && (block.hash !== frozen.sourceCutoffBlockHash || block.timestamp !== frozen.value.sourceCutoff)) throw new Error('signed source cutoff changed; rebuild and obtain new approvals');
  const hours = frozen ? String((frozen.value.validUntil - frozen.value.sourceCutoff) / 3600) : process.env.EPOCH_VALID_HOURS ?? '24';
  return { ...boundedEpochParams(block.timestamp, lists.provenance, Date.now(), hours), provenance: lists.provenance };
}

interface ApprovalBundle { version: number; digest: string; sourceCutoffBlock: number; sourceCutoffBlockHash: string; sourceSnapshot: SourceSnapshotManifest; value: RosterApprovalMessage; approvals: unknown[] }
function approvalBundle(): ApprovalBundle | undefined {
  const path = process.env.EPOCH_APPROVALS_FILE;
  if (!path) return;
  if (statSync(path).size > 256 * 1024) throw new Error('approval file exceeds 256 KiB');
  const b = JSON.parse(readFileSync(path, 'utf8')) as ApprovalBundle;
  if (b.version !== 1 || !Number.isSafeInteger(b.sourceCutoffBlock) || b.sourceCutoffBlock <= 0 || !ethers.isHexString(b.sourceCutoffBlockHash, 32) ||
    rosterApprovalData(11155111n, SOURCE_ADDRESS, b.value).digest.toLowerCase() !== b.digest?.toLowerCase()) throw new Error('invalid approval plan or source/chain binding');
  return b;
}

/**
 * The freshness trade-off, stated with the numbers of this run.
 *
 * Both positive and negative current-roster proofs use the source-cutoff lifetime.
 * Relaying an old event cannot restart that lifetime. Completeness remains a publisher assertion.
 */
function freshnessNote(p: EpochParams): string[] {
  return [
    `  source cutoff ${p.sourceCutoff} (${iso(p.sourceCutoff)}), snapshot ${p.snapshotId}`,
    `  validUntil ${p.validUntil} (${iso(p.validUntil)}), ${p.validDays} days from SOURCE CUTOFF, never hub arrival`,
    '  Maximum duration 24 hours; publish within one hour of cutoff. This is not a regulatory SLA.',
    '  Snapshot binding does not prove every roster member was rescreened or that the set is complete.',
    '  Once validUntil passes, ASC.isRosterFresh() is false and verifyWithRoster fails closed for',
    '  every subject. An expired roster verifies nobody.',
  ];
}

// ── 3. Verdicts against the deployed contracts ─────────────────────────────────

interface Verdict { label: string; expected: boolean; actual: boolean }

const [SEL_VERIFY_WITH_ROSTER, SEL_PROVE_NOT_IN_ROSTER] = ROSTER_SELECTORS;

/**
 * Does the deployed registry actually carry the proof-mode entry points.
 *
 * Asked before calling them, because a contract without a function answers a call to it by
 * reverting with no data, and "execution reverted" is indistinguishable from a proof that failed.
 * Reporting a missing deployment as a failed verdict would be the worst possible answer here.
 * The selector is searched for in the runtime code, which is where solc's dispatch table puts it.
 */
async function registryHasProofMode(hub: ethers.JsonRpcProvider, blockNumber: number): Promise<boolean> {
  const code = (await retry('registry getCode', () => hub.getCode(REGISTRY_ADDRESS, blockNumber))).toLowerCase();
  return code.includes(SEL_VERIFY_WITH_ROSTER) && code.includes(SEL_PROVE_NOT_IN_ROSTER);
}

/**
 * The same inclusion and non-inclusion proofs, verified against the root read from chain, by
 * `pipeline/roster.ts`.
 *
 * This is NOT a contract verdict and is never recorded as one. It is what can still be shown when
 * the deployed registry has no proof-mode path: the published root is the tree we built, and the
 * membership and adjacency proofs check out against it. `test/RosterProof.t.sol` pins
 * `src/lib/RosterProof.sol` to this implementation with vectors the TypeScript side produced, so
 * the two agree — but agreeing in tests is not the same as a deployed contract answering.
 */
function offChainVerdicts(tree: RosterTree, onChainRoot: string): Verdict[] {
  const i = tree.entries.findIndex((e) => e.subject.toLowerCase() === DEMO_SUBJECT.toLowerCase());
  const out: Verdict[] = [];
  if (i >= 0) {
    out.push({
      label: `inclusion of ${short(DEMO_SUBJECT)} under the on-chain root`,
      expected: true,
      actual: verifyInclusion(onChainRoot, rosterLeaf(tree.entries[i]), inclusionProof(tree, leafIndexOf(i))),
    });
  }
  for (const [target, what] of [[NEVER_ISSUED, 'never issued']] as const) {
    let actual = false;
    try {
      actual = verifyNonInclusion(onChainRoot, target, nonInclusionProof(tree, target));
    } catch { actual = false; }
    out.push({ label: `non-inclusion of ${short(target)} (${what}) under the on-chain root`, expected: true, actual });
  }
  return out;
}

async function rosterVerdicts(hub: ethers.JsonRpcProvider, tree: RosterTree, blockNumber: number): Promise<Verdict[]> {
  const reg = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, hub);
  const at = { blockTag: blockNumber };
  const out: Verdict[] = [];

  const i = tree.entries.findIndex((e) => e.subject.toLowerCase() === DEMO_SUBJECT.toLowerCase());
  if (i < 0) {
    bad(`${DEMO_SUBJECT} is not in the roster, so the membership verdicts cannot be produced`);
    throw new Error('EPOCH_VERIFICATION_FAILED');
  }
  const e = tree.entries[i];
  const mark = { attrs: e.attrs, claimsRoot: e.claimsRoot, evidenceHash: e.evidenceHash, issuer: e.issuer };
  const inc = inclusionProof(tree, leafIndexOf(i));

  out.push({
    label: `verifyWithRoster(${short(DEMO_SUBJECT)}, policy ${POLICY_PILOT} KR pilot)`,
    expected: true,
    actual: await retry('verifyWithRoster(policy 2)', () => reg.verifyWithRoster(DEMO_SUBJECT, POLICY_PILOT, mark, inc, at)),
  });
  out.push({
    label: `verifyWithRoster(${short(DEMO_SUBJECT)}, policy ${POLICY_PRODUCTION} KR VASP production)`,
    expected: false,
    actual: await retry('verifyWithRoster(policy 1)', () => reg.verifyWithRoster(DEMO_SUBJECT, POLICY_PRODUCTION, mark, inc, at)),
  });

  for (const [target, what] of [[NEVER_ISSUED, 'never issued']] as const) {
    const p = nonInclusionProof(tree, target);
    const arg = {
      left: p.left, leftKey: p.leftKey, leftMark: p.leftMark,
      right: p.right, rightKey: p.rightKey, rightMark: p.rightMark,
    };
    out.push({
      label: `proveNotInRoster(${short(target)}, ${what})`,
      expected: true,
      actual: await retry(`proveNotInRoster(${target})`, () => reg.proveNotInRoster(target, arg, at)),
    });
  }
  return out;
}

function printVerdicts(vs: Verdict[]): boolean {
  step('Registry verdicts (eth_call, no state written)');
  let allMatch = true;
  for (const v of vs) {
    const match = v.expected === v.actual;
    if (!match) allMatch = false;
    say(`  ${match ? 'ok ' : 'x  '}${v.label}\n       expected ${v.expected}  actual ${v.actual}`);
  }
  return allMatch;
}

// ── 4. Recording ──────────────────────────────────────────────────────────────

interface Record {
  sourcePublicationObservation?: PublicationConfirmation;
  hubCarry?: NonNullable<Awaited<ReturnType<typeof observeEpochCarry>>>;
  runtimeObservation?: Awaited<ReturnType<typeof checkEpochRuntimes>>;
  policyObservation?: Awaited<ReturnType<typeof checkEpochPolicies>>;
  hubObservation?: EpochHubObservation;
  sourceSnapshot?: SourceSnapshotManifest;
  rosterAuthVersion?: number;
  approvedIssuers?: string[];
  epochSchemaVersion?: number;
  sourceCutoff?: number;
  publishedAt?: number;
  snapshotId?: string;
  rosterFormatVersion?: number;
  epoch: number;
  root: string;
  listVersion: number;
  validUntil: number;
  validUntilIso?: string;
  validDays?: number;
  entryCount: number;
  entries: RosterEntry[];
  excluded?: Excluded[];
  setEpochPublisherTx?: string | null;
  publishEpochTx?: string;
  sepoliaBlock?: number;
  sepoliaConfirmedAt?: string;
  cc3AcceptedAt?: string;
  propagationSeconds?: number;
  propagationMethod?: string;
  checks?: { label: string; expected: boolean; actual: boolean }[];
  /** Proofs verified by pipeline/roster.ts against the on-chain root. Never a contract verdict. */
  offChainChecks?: { label: string; expected: boolean; actual: boolean }[];
  registryProofMode?: boolean;
  checkedAt?: string;
  proofAvailability?: { version: 1; seedHash: string; contentHash: string; replicaCount: number; prepublicationBound: boolean };
}

const recordPath = (epoch: number) => join(process.env.EPOCH_RECORD_DIR || join(REPO, 'deployments'), `epoch-v2-${SOURCE_ADDRESS.toLowerCase()}-${ASC_ADDRESS.toLowerCase()}-${epoch}.json`);

function proofReplicaDirectories(): string[] {
  if (process.env.EPOCH_BUNDLE_DISCLOSURE_ACK !== 'wallet-linkable-roster-approved') {
    throw new PublicationJournalError('PUBLICATION_ROSTER_DISCLOSURE_APPROVAL_REQUIRED');
  }
  let paths: unknown;
  try { paths = JSON.parse(process.env.EPOCH_BUNDLE_REPLICA_DIRS ?? ''); }
  catch { throw new PublicationJournalError('PUBLICATION_ROSTER_REPLICAS_REQUIRED'); }
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
    throw new PublicationJournalError('PUBLICATION_ROSTER_REPLICAS_REQUIRED');
  }
  return paths;
}

function replicaScope(): RosterScope {
  return { sourceChainId: 11155111, sourceChainKey: 1, hubChainId: 102031,
    source: SOURCE_ADDRESS, asc: ASC_ADDRESS, registry: REGISTRY_ADDRESS };
}

function stagePublicationAvailability(record: PrepublicationRosterRecord): StagedRosterBundleReplicas {
  try { return stageRosterBundleReplicas(record, replicaScope(), proofReplicaDirectories()); }
  catch (error) {
    if (error instanceof PublicationJournalError) throw error;
    throw new PublicationJournalError(`PUBLICATION_ROSTER_REPLICAS_UNAVAILABLE: ${(error as Error).message}`);
  }
}

function publicationBundleRecord(rec: Record): Omit<RosterBundle, 'bundleVersion' | 'scope'> {
  if (rec.rosterFormatVersion !== 2 || rec.epochSchemaVersion !== 2 || rec.rosterAuthVersion !== 1 ||
      rec.sourceCutoff === undefined || rec.publishedAt === undefined || rec.snapshotId === undefined || !rec.approvedIssuers) {
    throw new PublicationJournalError('PUBLICATION_ROSTER_RECORD_INCOMPLETE');
  }
  return { rosterFormatVersion: 2, epochSchemaVersion: 2, rosterAuthVersion: 1,
    epoch: rec.epoch, root: rec.root, listVersion: rec.listVersion, sourceCutoff: rec.sourceCutoff,
    publishedAt: rec.publishedAt, validUntil: rec.validUntil, snapshotId: rec.snapshotId,
    approvedIssuers: rec.approvedIssuers, entries: rec.entries };
}

function finalizePublicationAvailability(staged: StagedRosterBundleReplicas, publishedAt: number, prepublicationBound: boolean): NonNullable<Record['proofAvailability']> {
  try {
    const finalized = finalizeRosterBundleReplicas(staged, publishedAt);
    return { version: 1, seedHash: finalized.seedHash, contentHash: finalized.contentHash,
      replicaCount: finalized.replicaCount, prepublicationBound };
  } catch (error) {
    throw new PublicationJournalError(`PUBLICATION_ROSTER_REPLICAS_UNAVAILABLE: ${(error as Error).message}`);
  }
}

function retainedProofAvailability(rec: Record): Record['proofAvailability'] {
  try {
    const prior = JSON.parse(readFileSync(recordPath(rec.epoch), 'utf8')) as Record;
    const value = prior.proofAvailability;
    if (prior.root !== rec.root || prior.sourceCutoff !== rec.sourceCutoff || prior.snapshotId !== rec.snapshotId ||
        !value || value.version !== 1 || value.replicaCount < 2 || typeof value.prepublicationBound !== 'boolean' || !/^[0-9a-f]{64}$/.test(value.seedHash) ||
        !/^[0-9a-f]{64}$/.test(value.contentHash)) throw new Error('invalid retained proof availability');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PublicationJournalError('PUBLICATION_ROSTER_EVIDENCE_UNAVAILABLE');
  }
}

/** Complete current evidence only; previous hub observations are never implicitly merged. */
function writeRecord(patch: Record): string {
  const p = recordPath(patch.epoch);
  writeEpochRecord(p, patch);
  return p;
}

/**
 * The README snippet, built only from what this run measured.
 *
 * Nothing here is a template with a number pencilled in: if propagation was not measured, the
 * propagation row is not written. The repo's other measured numbers are not restated.
 */
function writeSnippet(rec: Record): string {
  const p = recordPath(rec.epoch).replace(/\.json$/, '.md');
  const L: string[] = [];
  const prop = rec.propagationSeconds !== undefined ? mmss(rec.propagationSeconds) : null;

  L.push(`# Epoch ${rec.epoch} — measured README snippets`);
  L.push('');
  L.push(`Generated by \`script/publish-epoch.ts\`${rec.checkedAt ? ` (checks ${rec.checkedAt})` : ''}. Source publication facts can precede this invocation. Only propagation explicitly measured in this invocation is included. These RPC observations are not independent deployment or submission approval.`);
  L.push('');
  L.push('## Section 8 — replaces the bullet "Epoch rosters (Mode B) are built but not published on chain."');
  L.push('');

  const b: string[] = [];
  b.push(`- **Epoch rosters (Mode B) are live: epoch ${rec.epoch} is published on chain.** `);
  b.push(`The active set of ${rec.entryCount} mark${rec.entryCount === 1 ? '' : 's'} is one sorted-key Merkle root, \`${rec.root}\`, published through \`ComplianceSource\` on Sepolia (\`${rec.publishEpochTx}\`) and accepted by \`ProofmarkASC\` on CC3`);
  if (prop) b.push(` ${prop} later (one run)`);
  b.push('. ');
  if (rec.checks?.length) {
    const v = (i: number) => String(rec.checks![i].actual);
    b.push(`Against that root the registry answers \`verifyWithRoster\` ${v(0)} under policy 2 and ${v(1)} under policy 1 for the same mark, and \`proveNotInRoster\` ${v(2)} for an address never issued to. The same adjacency proof is how a future subject removed from a roster is proven absent. `);
  } else if (rec.registryProofMode === false) {
    // Say what did not run. A missing deployment is not a passing check with a caveat.
    const off = rec.offChainChecks ?? [];
    const allOff = off.length > 0 && off.every((c) => c.expected === c.actual);
    b.push(`What is **not** exercised on chain: the registry's proof-mode entry points. The deployed \`ProofmarkRegistry\` at \`${REGISTRY_ADDRESS}\` is an earlier build whose runtime code contains neither \`verifyWithRoster\` nor \`proveNotInRoster\`, so those verdicts did not run and are not claimed here. `);
    if (allOff) {
      b.push(`The published root was verified against \`pipeline/roster.ts\` — inclusion for the mark and non-membership for an address never issued to, both against the root read back from CC3 — and \`test/RosterProof.t.sol\` pins \`src/lib/RosterProof.sol\` to that implementation, but agreeing in tests is not a deployed contract answering. `);
    }
    b.push('Cache mode is unaffected: `isVerified` on the deployed registry answers exactly as before. ');
  }
  b.push(`The roster carries \`validUntil ${rec.validUntil}\` (${rec.validUntilIso ? `${rec.validUntilIso}, ` : ''}a demo parameter; production cadence would be daily), after which \`ASC.isRosterFresh()\` is false and \`verifyWithRoster\` fails closed for every subject. `);
  b.push('Marks issued before the epoch keep `origin = Direct`; the roster is the set, not a rewrite of their provenance.');
  L.push(b.join(''));
  L.push('');
  L.push('## Section 6 — one row for the cross-chain propagation table');
  L.push('');
  if (prop) {
    L.push('| Step | Value |');
    L.push('|---|---|');
    L.push(`| Epoch publish to \`latestEpoch\` on CC3 | ${prop}, one run |`);
    L.push('');
    L.push(`Measured ${rec.propagationMethod ?? 'from the publish confirmation to the epoch flip'}: ${rec.sepoliaConfirmedAt} to ${rec.cc3AcceptedAt}.`);
  } else {
    L.push('_Not written: this run did not measure propagation (no publish transaction in it)._');
  }
  L.push('');
  writeVaultEnvelope(p, `${L.join('\n')}\n`);
  return p;
}

// ── 5. Modes ──────────────────────────────────────────────────────────────────

function usage(): void {
  say(`Publish an epoch roster (Mode B) and prove it landed.

  npx tsx script/publish-epoch.ts [--dry-run | --publish | --resume-publication | --check-publication | --cancel-unsigned-publication | --check | --help]

  --dry-run   default. Rebuild the active set from chain, print the roster, the root and the
              planned calls, self-check the tree. Reads no key and sends nothing.
  --publish   Persist intent and signed bytes before sending with an authorized publisher. Then poll
              ProofmarkASC.latestEpoch() on CC3 until the worker has carried the event across
              and record the observed propagation time.
  --check     View calls only. Rebuild the roster, compare it with the on-chain root, then ask the
              deployed ProofmarkRegistry for membership and non-membership verdicts.
  --resume-publication  Reconcile the journal's latest non-abandoned entry, never calculate a new epoch.
              Confirmed source recovery writes its evidence and exits 2: CC3 is NOT_CHECKED.
  --check-publication  Shell config only, no dotenv/private key. Observe the latest non-abandoned
              journal entry's original source receipt, exact hub carry and current policy verdicts.
              Never signs/sends/updates journal bytes; holds its local lease and writes derived evidence.
  --cancel-unsigned-publication  Cancel only an unresolved never-signed plan; no RPC or transaction.
  --help      This text. Select exactly one mode.

Environment (fresh snapshot for new sends; v2 deployments and dedicated journal for publication/resume):

  SOURCE_CHAIN_RPC_URL   default ${DEFAULT_SOURCE_RPC}
  SOURCE_HEADER_RPC_URL  default ${DEFAULT_SOURCE_HEADER_RPC}; must be a different independently operated endpoint
  CREDITCOIN_RPC_URL     default ${DEFAULT_HUB_RPC}
  SOURCE_DEPLOYMENT_TX   verified direct CREATE transaction; otherwise matching deployment manifest
  SOURCE_CONFIRMATIONS   default 12; cutoff also must be at/below finalized
  SOURCE_SCAN_CHUNK      default 100, maximum 1000. Receipt/getLogs comparison window
  SOURCE_RECEIPT_CONCURRENCY default 6, maximum 16. Parallel individual receipt requests; never JSON-RPC batching
  SOURCE_RECEIPT_RETRIES default 3, maximum 10. Bounded retries for transient receipt RPC failures
  SOURCE_CUTOFF_BLOCK    optional --dry-run finalized cutoff; requires exact SOURCE_CUTOFF_HASH
  SOURCE_CUTOFF_HASH     optional --dry-run block hash paired with SOURCE_CUTOFF_BLOCK
  SOURCE_SNAPSHOT_MAX_BLOCKS    default 20000. Per-run scan budget; without checkpoint, full history
  SOURCE_SNAPSHOT_MAX_RECEIPTS  default 200000. Per-run receipt budget; without checkpoint, full history
  SOURCE_SNAPSHOT_CHECKPOINT_PATH optional encrypted incremental replay checkpoint
  SOURCE_SNAPSHOT_CHECKPOINT_KEY  independent secret, at least 32 characters; required with checkpoint path
  EPOCH_VALID_HOURS      default 24, at most 24. Lifetime from source cutoff, not hub arrival
  SANCTIONS_MAX_AGE_HOURS shared freshness setting; epoch publication further caps list age at 24h
  EPOCH_POLL_SECONDS     default 15. Interval while waiting for CC3 to accept the epoch
  EPOCH_TIMEOUT_MINUTES  default 30. How long to wait before reporting the wait failed
  EPOCH_HUB_CONFIRMATIONS default 6. Required depth of the exact matching hub acceptance receipt
  EPOCH_HUB_FROM_BLOCK   --check-publication: required inclusive hub scan start, at/before acceptance.
                        At most 20000 blocks through current head; no inferred/truncated floor.
  RPC_ATTEMPTS           default 5. Retries per RPC read; public endpoints answer inconsistently
  EPOCH_PUBLISHER_ADDRESS  dry-run signing plan; required journal scope for --check-publication
  EPOCH_APPROVALS_FILE     --publish: signed JSON plan produced by --dry-run (at most 256 KiB)
  EPOCH_PUBLISHER_PRIVATE_KEY  publish/resume/cancel only. Dedicated signer; no deployer-key fallback
  EPOCH_PUBLICATION_JOURNAL_PATH  required shared persistent path; never use a new path to evade pending state
  EPOCH_PUBLICATION_JOURNAL_KEY   required independent high-entropy secret, at least 32 characters
  EPOCH_SOURCE_WAIT_SECONDS      default 30, 1..300; timeout preserves raw/nonce and requires resume
  EPOCH_RECORD_DIR               optional local evidence directory; defaults to deployments/
  EPOCH_BUNDLE_REPLICA_DIRS      --publish/resume JSON array of at least two approved durable directories
  EPOCH_BUNDLE_DISCLOSURE_ACK    exact value wallet-linkable-roster-approved; required before seed export
  DEMO_EXPECTED_ISSUER           required for --check, --check-publication and --publish; approved nonzero
                                issuer for exact frozen demo policies 1/2 (no on-chain inference)
  DEMO_SOURCE_CODEHASH           reviewed nonzero runtime keccak256 pins required for --publish,
  DEMO_ASC_CODEHASH              --resume-publication, --check-publication and --check. Never copy the checked RPC's
  DEMO_REGISTRY_CODEHASH         code hash into these settings to make verification pass.

The roster replays every source issue/revoke/deny through a finalized cutoff, independently of
hub relay delay. Full block receipts are reconstructed into the header receiptsRoot, getLogs must
agree, and a separate finalized-header RPC must report the same blocks. SOURCE_FROM_BLOCK and
historical floor fallback are unsupported.`);
}

/**
 * One request per call, never a JSON-RPC batch. Batching is what turns one flaky backend answer
 * into a whole failed sweep, and neither public endpoint here is reliable enough to batch against.
 */
function providers(): { src: ethers.JsonRpcProvider; headers: ethers.JsonRpcProvider; hub: ethers.JsonRpcProvider } {
  const opts = { batchMaxCount: 1, cacheTimeout: -1 } as const;
  const connection = (url: string) => { const request = new ethers.FetchRequest(url); request.timeout = 15_000; return request; };
  const sourceUrl = process.env.SOURCE_CHAIN_RPC_URL || DEFAULT_SOURCE_RPC;
  const headerUrl = process.env.SOURCE_HEADER_RPC_URL || DEFAULT_SOURCE_HEADER_RPC;
  if (new URL(sourceUrl).href === new URL(headerUrl).href) throw new Error('SOURCE_HEADER_RPC_URL must differ from SOURCE_CHAIN_RPC_URL');
  const src = new ethers.JsonRpcProvider(connection(sourceUrl), 11_155_111, opts) as ethers.JsonRpcProvider & {
    getBlockReceipts(height: number): Promise<readonly SnapshotReceipt[]>;
  };
  src.getBlockReceipts = async (height: number) => {
    const raw = await src.send('eth_getBlockReceipts', [ethers.toQuantity(height)]);
    if (!Array.isArray(raw)) throw new Error('invalid eth_getBlockReceipts response');
    const number = (value: unknown) => typeof value === 'number' ? value
      : typeof value === 'string' && ethers.isHexString(value) ? Number(BigInt(value)) : Number.NaN;
    return raw.map((receipt: any) => ({
      hash: receipt.transactionHash,
      blockNumber: number(receipt.blockNumber),
      blockHash: receipt.blockHash,
      index: number(receipt.transactionIndex),
      status: receipt.status == null ? null : number(receipt.status),
      contractAddress: receipt.contractAddress,
      logs: Array.isArray(receipt.logs) ? receipt.logs.map((log: any) => ({
        address: log.address,
        blockNumber: number(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: number(log.transactionIndex),
        index: number(log.logIndex),
        topics: log.topics,
        data: log.data,
        removed: log.removed,
      })) : receipt.logs,
      cumulativeGasUsed: BigInt(receipt.cumulativeGasUsed),
      logsBloom: receipt.logsBloom,
      type: number(receipt.type),
      root: receipt.root,
    }));
  };
  return {
    src,
    headers: new ethers.JsonRpcProvider(connection(headerUrl), 11_155_111, opts),
    hub: new ethers.JsonRpcProvider(connection(process.env.CREDITCOIN_RPC_URL || DEFAULT_HUB_RPC), 102_031, opts),
  };
}

async function dryRun(): Promise<void> {
  const { src, headers, hub } = providers();
  await requireRosterV2(hub, REGISTRY_ADDRESS);
  step('Building the roster from chain state');
  const cutoffBlock = process.env.SOURCE_CUTOFF_BLOCK ? num('SOURCE_CUTOFF_BLOCK', -1) : undefined;
  const cutoffHash = process.env.SOURCE_CUTOFF_HASH;
  if ((cutoffBlock === undefined) !== (cutoffHash === undefined)) {
    throw new Error('SOURCE_CUTOFF_BLOCK and SOURCE_CUTOFF_HASH must be configured together');
  }
  const r = await buildFromChain(src, headers, hub, cutoffBlock, cutoffHash);
  printRoster(r);
  selfCheck(r.tree);

  const source = new ethers.Contract(SOURCE_ADDRESS, SOURCE_ABI, src);
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);
  await requireEpochV2(() => source.EPOCH_SCHEMA_VERSION(), () => asc.EPOCH_SCHEMA_VERSION());
  await requireRosterAuthorization(() => source.ROSTER_AUTH_VERSION(), () => asc.ROSTER_AUTH_VERSION());
  const [lastEpoch, latestEpoch] = await Promise.all([
    retry('lastEpoch()', () => source.lastEpoch()),
    retry('latestEpoch()', () => asc.latestEpoch()),
  ]);
  const epoch = Number(lastEpoch) + 1;
  const p = await epochParams(src, r);

  step('Planned calls');
  say(`  source lastEpoch ${Number(lastEpoch)} on Sepolia, ASC latestEpoch ${Number(latestEpoch)} on CC3, so this would publish epoch ${epoch}`);
  say('  Publisher must already be authorized. This script never grants roles.');
  say(`  publishEpoch[ForIssuers](${epoch}, ${r.tree.root}, ${p.listVersion}, ${p.validUntil}, ${p.sourceCutoff}, ${p.snapshotId}[, approvals])`);
  for (const line of freshnessNote(p)) say(line);
  const publisher = process.env.EPOCH_PUBLISHER_ADDRESS;
  if (publisher) {
    const typed = rosterApprovalData(11155111n, SOURCE_ADDRESS, { epoch, root: r.tree.root, listVersion: p.listVersion,
      validUntil: p.validUntil, sourceCutoff: p.sourceCutoff, snapshotId: p.snapshotId, publisher });
    if ((await source.rosterApprovalDigest(epoch, r.tree.root, p.listVersion, p.validUntil, p.sourceCutoff, p.snapshotId, publisher)).toLowerCase() !== typed.digest.toLowerCase()) throw new Error('source and local approval digest disagree');
    const block = await src.getBlock(r.scannedTo);
    if (!block?.hash || block.timestamp !== p.sourceCutoff) throw new Error('source cutoff changed while preparing approval plan');
    step('Issuer signing plan — independently review the roster and snapshot before signing');
    const plan = { version: 1, sourceCutoffBlock: r.scannedTo, sourceCutoffBlockHash: block.hash, sourceSnapshot: r.sourceSnapshot,
      ...typed, requiredIssuers: [...new Set(r.tree.entries.map(e => e.issuer.toLowerCase()))], entries: r.tree.entries, approvals: [] };
    const serializedPlan = JSON.stringify(plan, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
    say(serializedPlan);
    const planPath = process.env.EPOCH_APPROVAL_PLAN_PATH;
    if (planPath) {
      writeFileSync(planPath, `${serializedPlan}\n`, { flag: 'wx', mode: 0o600 });
      say(`  Approval plan written with exclusive create: ${planPath}`);
    }
    say('  Save only the JSON object, add {issuer, signature} approvals, and supply EPOCH_APPROVALS_FILE. Never edit signed fields.');
  } else say('  Set EPOCH_PUBLISHER_ADDRESS to print a publisher-bound EIP-712 signing plan.');

  step('dry run — no transaction sent');
}

async function publish(mode: 'publish' | 'resume' | 'cancel' = 'publish'): Promise<void> {
  await import('dotenv/config'); // Only explicit publication lifecycle modes load keys/config.
  SOURCE_ADDRESS = process.env.SOURCE_CONTRACT_ADDRESS ?? deployment.contracts.ComplianceSource;
  ASC_ADDRESS = process.env.ASC_CONTRACT_ADDRESS ?? deployment.contracts.ProofmarkASC;
  REGISTRY_ADDRESS = process.env.REGISTRY_CONTRACT_ADDRESS ?? deployment.contracts.ProofmarkRegistry;
  if (mode === 'publish') expectedDemoIssuer(process.env.DEMO_EXPECTED_ISSUER);
  const { src, headers, hub } = providers();
  let journal: EpochPublicationJournal | undefined;
  try {
  const key = process.env.EPOCH_PUBLISHER_PRIVATE_KEY;
  const path = process.env.EPOCH_PUBLICATION_JOURNAL_PATH, secret = process.env.EPOCH_PUBLICATION_JOURNAL_KEY;
  if (!key || !path || !secret) throw new PublicationJournalError('PUBLICATION_JOURNAL_AND_DEDICATED_KEY_REQUIRED');
  const wallet = new ethers.Wallet(key, src);
  const expectedPublisher = process.env.EPOCH_PUBLISHER_ADDRESS;
  if (!expectedPublisher || !ethers.isAddress(expectedPublisher) || expectedPublisher === ethers.ZeroAddress
    || expectedPublisher.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new PublicationJournalError('PUBLICATION_SIGNER_ROLE_MISMATCH');
  }
  journal = new EpochPublicationJournal(path, secret, { chainId: 11155111, source: SOURCE_ADDRESS, publisher: wallet.address });
  if (mode === 'cancel') {
    const pending = journal.snapshot().find(e => !e.confirmation && !e.abandonment);
    if (!pending) throw new PublicationJournalError('PUBLICATION_NOT_FOUND');
    journal.abandonUnsigned(pending.id, Date.now());
    say('Unsigned publication plan cancelled; no transaction sent.'); return;
  }
  // Validate actual dotenv-selected destinations before any signing or broadcast.
  await checkEpochRuntimes(src, hub, { source: SOURCE_ADDRESS, asc: ASC_ADDRESS, registry: REGISTRY_ADDRESS }, epochRuntimePins(process.env));
  await requireRosterV2(hub, REGISTRY_ADDRESS);
  const sourceRead = new ethers.Contract(SOURCE_ADDRESS, SOURCE_ABI, src);
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);
  await requireEpochV2(() => sourceRead.EPOCH_SCHEMA_VERSION(), () => asc.EPOCH_SCHEMA_VERSION());
  await requireRosterAuthorization(() => sourceRead.ROSTER_AUTH_VERSION(), () => asc.ROSTER_AUTH_VERSION());
  if (mode === 'resume') return await resumePublication(journal, src, headers, hub, wallet);
  const existing = journal.snapshot().filter(e => !e.abandonment);
  if (existing.some(e => !e.confirmation)) throw new PublicationJournalError('PUBLICATION_PENDING_RESUME_REQUIRED');
  // Even a historical confirmation must still be canonical before a new nonce/epoch is planned.
  if (existing.length) await advancePublication(journal, existing.at(-1)!.id, publicationTransport(journal, src, headers, hub, wallet));
  await publishFresh(journal, src, headers, hub, wallet);
  } finally { try { journal?.close(); } finally { src.destroy(); headers.destroy(); hub.destroy(); } }
}

function publicationTransport(journal: EpochPublicationJournal, src: ethers.JsonRpcProvider, headers: ethers.JsonRpcProvider,
  hub: ethers.JsonRpcProvider, wallet: ethers.Wallet, roster?: Roster): PublicationTransport {
  let checkedRoster = roster;
  return evmPublicationTransport(src, wallet, journal, num('SOURCE_CONFIRMATIONS', 12), async entry => {
    await checkEpochRuntimes(src, hub, { source: SOURCE_ADDRESS, asc: ASC_ADDRESS, registry: REGISTRY_ADDRESS }, epochRuntimePins(process.env));
    const call = PUBLICATION_ABI.parseTransaction({ data: entry.intent.calldata })!;
    checkedRoster ??= await buildFromChain(src, headers, hub, entry.intent.sourceCutoff.blockNumber, entry.intent.sourceCutoff.blockHash);
    if (checkedRoster.tree.root !== call.args.root) throw new PublicationJournalError('PUBLICATION_ROSTER_CHANGED');
    const lists = await loadLists(join(REPO, 'data/raw'), 'epoch');
    const p = boundedEpochParams(Number(call.args.sourceCutoff), lists.provenance, Date.now(), String(Number(call.args.validUntil - call.args.sourceCutoff) / 3600));
    if (p.validUntil !== Number(call.args.validUntil) || p.snapshotId !== call.args.snapshotId || p.listVersion !== Number(call.args.listVersion)) throw new PublicationJournalError('PUBLICATION_SNAPSHOT_CHANGED');
    const approved: string[] = call.name === 'publishEpoch' ? [journal.scope.publisher] : call.args.approvals.map((a: { issuer: string }) => a.issuer.toLowerCase());
    if (checkedRoster.tree.entries.some(e => !approved.includes(e.issuer.toLowerCase()))) throw new PublicationJournalError('PUBLICATION_ISSUER_NOT_APPROVED');
  });
}

async function settlePublication(journal: EpochPublicationJournal, entry: PublicationEntry, transport: PublicationTransport) {
  const seconds = num('EPOCH_SOURCE_WAIT_SECONDS', 30);
  if (seconds < 1 || seconds > 300) throw new PublicationJournalError('PUBLICATION_WAIT_INVALID');
  const deadline = Date.now() + seconds * 1000;
  do {
    const result = await advancePublication(journal, entry.id, transport);
    if (result.state === 'confirmed') return result.confirmation;
    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new PublicationJournalError('PUBLICATION_PENDING_RESUME_REQUIRED');
}

async function resumePublication(journal: EpochPublicationJournal, src: ethers.JsonRpcProvider, headers: ethers.JsonRpcProvider,
  hub: ethers.JsonRpcProvider, wallet: ethers.Wallet): Promise<void> {
  const entry = journal.snapshot().filter(e => !e.abandonment).at(-1);
  if (!entry) throw new PublicationJournalError('PUBLICATION_NOT_FOUND');
  const confirmation = await settlePublication(journal, entry, publicationTransport(journal, src, headers, hub, wallet));
  const rec = await recoveredSourceRecord(journal, entry, confirmation, src, headers, hub);
  const staged = stagePublicationAvailability(publicationBundleRecord(rec));
  if (entry.intent.availability && (entry.intent.availability.seedHash !== staged.seedHash ||
      entry.intent.availability.replicaCount !== staged.replicaCount)) throw new PublicationJournalError('PUBLICATION_ROSTER_REPLICAS_CHANGED');
  rec.proofAvailability = finalizePublicationAvailability(staged, rec.publishedAt!, Boolean(entry.intent.availability));
  writeRecord(rec);
  say(`Source publication recovered: ${confirmation.transactionHash}. CC3 materialization NOT_CHECKED; run --check-publication for original carry verification.`);
  process.exitCode = 2; // Source recovery alone is not complete cross-chain publication verification.
}

async function recoveredSourceRecord(journal: EpochPublicationJournal, entry: PublicationEntry,
  confirmation: PublicationConfirmation, src: ethers.JsonRpcProvider, headers: ethers.JsonRpcProvider,
  hub: ethers.JsonRpcProvider): Promise<Record> {
  if (confirmation.status !== 1) throw new PublicationJournalError('PUBLICATION_SOURCE_REVERTED');
  const call = PUBLICATION_ABI.parseTransaction({ data: entry.intent.calldata })!;
  // Reconstruct the exact historical cutoff, not a fresh next epoch or a new approval file.
  const r = await buildFromChain(src, headers, hub, entry.intent.sourceCutoff.blockNumber, entry.intent.sourceCutoff.blockHash);
  if (r.tree.root !== call.args.root) throw new PublicationJournalError('PUBLICATION_ROSTER_CHANGED');
  const block = await src.getBlock(confirmation.blockNumber);
  if (block?.hash !== confirmation.blockHash || block.number !== confirmation.blockNumber) throw new PublicationJournalError('PUBLICATION_CONFIRMATION_CHANGED');
  const approvedIssuers: string[] = call.name === 'publishEpoch' ? [journal.scope.publisher] : call.args.approvals.map((a: { issuer: string }) => a.issuer);
  return { sourceSnapshot: r.sourceSnapshot, rosterAuthVersion: 1, approvedIssuers, epochSchemaVersion: 2,
    sourceCutoff: Number(call.args.sourceCutoff), snapshotId: call.args.snapshotId, publishedAt: block.timestamp,
    rosterFormatVersion: r.tree.formatVersion, epoch: Number(call.args.epoch), root: r.tree.root,
    listVersion: Number(call.args.listVersion), validUntil: Number(call.args.validUntil), validUntilIso: iso(Number(call.args.validUntil)),
    validDays: Number(call.args.validUntil - call.args.sourceCutoff) / 86400,
    entryCount: r.tree.entries.length, entries: r.tree.entries, excluded: r.excluded,
    setEpochPublisherTx: null, publishEpochTx: confirmation.transactionHash, sepoliaBlock: confirmation.blockNumber, sepoliaConfirmedAt: iso(block.timestamp) };
}

/** Read-only on both chains and on journal bytes. Only the local lease and derived evidence change. */
async function checkPublication(): Promise<void> {
  // Intentionally no dotenv import: shell config only, and no private-key lookup.
  const publisher = expectedDemoIssuer(process.env.EPOCH_PUBLISHER_ADDRESS);
  expectedDemoIssuer(process.env.DEMO_EXPECTED_ISSUER);
  const pins = epochRuntimePins(process.env);
  const path = process.env.EPOCH_PUBLICATION_JOURNAL_PATH, secret = process.env.EPOCH_PUBLICATION_JOURNAL_KEY;
  if (!path || !secret) throw new PublicationJournalError('PUBLICATION_JOURNAL_CONFIG');
  const fromBlock = num('EPOCH_HUB_FROM_BLOCK', -1), confirmations = num('EPOCH_HUB_CONFIRMATIONS', 6);
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || !Number.isSafeInteger(confirmations) || confirmations < 1)
    throw new PublicationJournalError('EPOCH_CARRY_CONFIG_INVALID');
  const { src, headers, hub } = providers();
  let journal: EpochPublicationJournal | undefined;
  try {
    journal = new EpochPublicationJournal(path, secret, { chainId: 11155111, source: SOURCE_ADDRESS, publisher });
    const entry = journal.snapshot().filter(e => !e.abandonment).at(-1);
    if (!entry) throw new PublicationJournalError('PUBLICATION_NOT_FOUND');
    await checkEpochRuntimes(src, hub, { source: SOURCE_ADDRESS, asc: ASC_ADDRESS, registry: REGISTRY_ADDRESS }, pins);
    const transport = evmPublicationTransport(src, new ethers.VoidSigner(publisher, src), journal,
      num('SOURCE_CONFIRMATIONS', 12), async () => { throw new PublicationJournalError('PUBLICATION_READ_ONLY'); });
    // Never advancePublication: even an unsigned or absent transaction must remain untouched.
    const observation = await transport.observe(entry);
    if (observation.state !== 'confirmed') throw new PublicationJournalError('PUBLICATION_SOURCE_NOT_CONFIRMED');
    const confirmation = observation.confirmation, prior = entry.confirmation;
    if (prior && (prior.transactionHash !== confirmation.transactionHash || prior.blockHash !== confirmation.blockHash
      || prior.blockNumber !== confirmation.blockNumber || prior.status !== confirmation.status))
      throw new PublicationJournalError('PUBLICATION_CONFIRMATION_CHANGED');
    const rec = await recoveredSourceRecord(journal, entry, confirmation, src, headers, hub);
    rec.proofAvailability = retainedProofAvailability(rec);
    const receipt = await src.getTransactionReceipt(confirmation.transactionHash);
    if (!receipt || receipt.status !== 1 || receipt.blockHash !== confirmation.blockHash || receipt.blockNumber !== confirmation.blockNumber)
      throw new PublicationJournalError('PUBLICATION_CONFIRMATION_CHANGED');
    const carry = await observeEpochCarry(hub, { asc: ASC_ADDRESS, epoch: rec.epoch, root: rec.root, validUntil: rec.validUntil,
      sourceCutoff: rec.sourceCutoff!, publishedAt: rec.publishedAt!, listVersion: rec.listVersion, snapshotId: rec.snapshotId!,
      sourceBlock: receipt.blockNumber, sourceTxIndex: receipt.index }, fromBlock, confirmations);
    if (!carry) throw new PublicationJournalError('PUBLICATION_HUB_NOT_CONFIRMED');
    await check({ ...rec, hubCarry: carry, cc3AcceptedAt: iso(carry.timestamp), propagationSeconds: carry.timestamp - rec.publishedAt!,
      propagationMethod: 'source block timestamp to exact matched CC3 acceptance receipt block timestamp' },
      () => reobservePublication(transport, entry, confirmation));
    say('Original publication verified; no transaction signed or sent, journal bytes unchanged.');
  } finally { try { journal?.close(); } finally { src.destroy(); headers.destroy(); hub.destroy(); } }
}

async function publishFresh(journal: EpochPublicationJournal, src: ethers.JsonRpcProvider, headers: ethers.JsonRpcProvider,
  hub: ethers.JsonRpcProvider, wallet: ethers.Wallet): Promise<void> {
  const signer = wallet.address;
  const hubConfirmations = num('EPOCH_HUB_CONFIRMATIONS', 6);
  if (!Number.isSafeInteger(hubConfirmations) || hubConfirmations < 1) throw new PublicationJournalError('EPOCH_CARRY_CONFIG_INVALID');
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);
  const frozen = approvalBundle();

  step('Building the roster from chain state');
  const r = await buildFromChain(src, headers, hub, frozen?.sourceCutoffBlock, frozen?.sourceCutoffBlockHash);
  if (frozen) assertSourceSnapshot(frozen.sourceSnapshot, r.sourceSnapshot);
  printRoster(r);
  selfCheck(r.tree);

  const source = new ethers.Contract(SOURCE_ADDRESS, SOURCE_ABI, wallet);
  const [lastEpoch, owner, alreadyPublisher, balance] = await Promise.all([
    retry('lastEpoch()', () => source.lastEpoch()),
    retry('owner()', () => source.owner()),
    retry('isEpochPublisher()', () => source.isEpochPublisher(signer)),
    retry('getBalance()', () => src.getBalance(signer)),
  ]);
  const epoch = Number(lastEpoch) + 1;
  const p = await epochParams(src, r, frozen);

  step('Signer');
  say(`  address        ${signer}`);
  say(`  Sepolia ETH    ${ethers.formatEther(balance)}`);
  say(`  source owner   ${owner}`);
  say(`  epoch publisher ${alreadyPublisher}`);

  if (!alreadyPublisher) throw new Error('signer is not an epoch publisher; role administration is a separate authorized operation');
  const typed = rosterApprovalData(11155111n, SOURCE_ADDRESS, { epoch, root: r.tree.root, listVersion: p.listVersion,
    validUntil: p.validUntil, sourceCutoff: p.sourceCutoff, snapshotId: p.snapshotId, publisher: signer });
  const args = [epoch, r.tree.root, p.listVersion, p.validUntil, p.sourceCutoff, p.snapshotId] as const;
  if ((await source.rosterApprovalDigest(...args, signer)).toLowerCase() !== typed.digest.toLowerCase()) throw new Error('source and local approval digest disagree');
  const issuers = [...new Set(r.tree.entries.map(e => e.issuer.toLowerCase()))];
  const approvals = frozen ? readRootApprovals(frozen, typed.digest, issuers) : undefined;
  if (!approvals && (!(await source.isIssuer(signer)) || issuers.some(issuer => issuer !== signer.toLowerCase()))) {
    throw new Error('implicit approval only covers the publisher as issuer; all other roster issuers must approve this exact plan via EPOCH_APPROVALS_FILE');
  }
  if (approvals) await source.publishEpochForIssuers.staticCall(...args, approvals);
  else await source.publishEpoch.staticCall(...args);
  const approvedIssuers = approvals?.map(a => a.issuer) ?? [signer];
  say(`  approval digest ${typed.digest}; issuers ${approvedIssuers.join(', ')}`);

  step(`Publishing epoch ${epoch} (authorization(s) and epoch in one source receipt)`);
  say(`  root        ${r.tree.root}`);
  say(`  listVersion ${p.listVersion}`);
  for (const line of freshnessNote(p)) say(line);

  const cc3BlockBefore = await retry('CC3 getBlockNumber', () => hub.getBlockNumber());
  boundedEpochParams(p.sourceCutoff, p.provenance, Date.now(), String((p.validUntil - p.sourceCutoff) / 3600));
  const cutoffNow = await src.getBlock(r.scannedTo);
  if (!cutoffNow || cutoffNow.timestamp !== p.sourceCutoff || cutoffNow.hash !== r.sourceSnapshot.cutoffBlockHash) throw new Error('source cutoff changed before publication');
  const stagedAvailability = stagePublicationAvailability({ rosterAuthVersion: 1, approvedIssuers,
    epochSchemaVersion: 2, sourceCutoff: p.sourceCutoff, snapshotId: p.snapshotId, rosterFormatVersion: r.tree.formatVersion,
    epoch, root: r.tree.root, listVersion: p.listVersion, validUntil: p.validUntil,
    entries: r.tree.entries });
  const calldata = PUBLICATION_ABI.encodeFunctionData(approvals ? 'publishEpochForIssuers' : 'publishEpoch', approvals ? [...args, approvals] : args);
  const intent = journal.begin({ calldata, sourceCutoff: { blockNumber: r.scannedTo, blockHash: r.sourceSnapshot.cutoffBlockHash },
    availability: { version: 1, seedHash: stagedAvailability.seedHash, replicaCount: stagedAvailability.replicaCount }, createdAt: Date.now() });
  const transport = publicationTransport(journal, src, headers, hub, wallet, r);
  const confirmation = await settlePublication(journal, intent, transport);
  if (confirmation.status !== 1) throw new PublicationJournalError('PUBLICATION_SOURCE_REVERTED');
  const confirmedEntry = journal.snapshot().find(e => e.id === intent.id)!;
  const tx = confirmedEntry.transaction!;
  say(`  source confirmed ${tx.hash}`);
  const rc = await src.getTransactionReceipt(tx.hash);
  if (!rc || rc.blockHash !== confirmation.blockHash || rc.blockNumber !== confirmation.blockNumber) throw new PublicationJournalError('PUBLICATION_CONFIRMATION_CHANGED');
  const srcBlock = await retry('getBlock()', () => src.getBlock(rc.blockNumber));
  if (srcBlock?.hash !== confirmation.blockHash || srcBlock.number !== confirmation.blockNumber) throw new PublicationJournalError('PUBLICATION_CONFIRMATION_CHANGED');
  const t0 = Number(srcBlock!.timestamp);
  ok(`published in Sepolia block ${rc.blockNumber} at ${iso(t0)}, gas ${rc.gasUsed}`);

  let rec: Record = {
    sourceSnapshot: r.sourceSnapshot,
    rosterAuthVersion: 1, approvedIssuers,
    epochSchemaVersion: 2, sourceCutoff: p.sourceCutoff, snapshotId: p.snapshotId, publishedAt: t0,
    rosterFormatVersion: r.tree.formatVersion,
    epoch, root: r.tree.root, listVersion: p.listVersion,
    validUntil: p.validUntil, validUntilIso: iso(p.validUntil), validDays: p.validDays,
    entryCount: r.tree.entries.length, entries: r.tree.entries, excluded: r.excluded,
    setEpochPublisherTx: null, publishEpochTx: tx.hash,
    sepoliaBlock: rc.blockNumber, sepoliaConfirmedAt: iso(t0),
    proofAvailability: finalizePublicationAvailability(stagedAvailability, t0, true),
  };
  writeRecord(rec);

  // The worker carries the event: it watches ComplianceSource, waits for the Attestcoin
  // attestation, then submits execute() to the ASC. Nothing here can hurry that along.
  step('Waiting for CC3 to accept the epoch');
  say('  the separately-running worker carries the event; this run records the observed propagation time');
  const pollMs = num('EPOCH_POLL_SECONDS', 15) * 1000;
  const timeoutMs = num('EPOCH_TIMEOUT_MINUTES', 30) * 60_000;
  const started = Date.now();
  let carry: Awaited<ReturnType<typeof observeEpochCarry>> = null;

  while (Date.now() - started < timeoutMs) {
    const latest = Number(await retry('latestEpoch()', () => asc.latestEpoch()));
    const elapsed = (Date.now() - started) / 1000;
    process.stdout.write(`\r  elapsed ${mmss(elapsed)}  latestEpoch ${latest}   `);
    if (latest >= epoch) {
      carry = await observeEpochCarry(hub, { asc: ASC_ADDRESS, epoch, root: r.tree.root, validUntil: p.validUntil,
        sourceCutoff: p.sourceCutoff, publishedAt: t0, listVersion: p.listVersion, snapshotId: p.snapshotId,
        sourceBlock: rc.blockNumber, sourceTxIndex: rc.index }, cc3BlockBefore, hubConfirmations);
      if (carry) break;
      if (latest > epoch) throw new PublicationJournalError('EPOCH_HUB_SUPERSEDED_UNCONFIRMED');
    }
    await sleep(pollMs);
  }
  say();

  if (!carry) {
    bad(`No exact sufficiently confirmed CC3 acceptance for epoch ${epoch} within ${num('EPOCH_TIMEOUT_MINUTES', 30)} minutes.`);
    bad('The source transaction was confirmed; current hub acceptance remains unverified. Check:');
    bad('  - is `npm run worker` running?');
    bad(`  - does its explicit WORKER_START_BLOCK cover source block ${rc.blockNumber}? Preserve its durable state; do not blindly reset the cursor.`);
    bad('  - does WORKER_STATE_PATH (currently state/worker-v2.json) list this transaction, and in what state?');
    throw new PublicationJournalError('PUBLICATION_HUB_NOT_CONFIRMED');
  }

  const t1 = carry.timestamp;
  const method = 'source block timestamp to exact matched CC3 acceptance receipt block timestamp';
  ok(`CC3 accepted epoch ${epoch} in ${carry.transactionHash}`);
  ok(`propagation ${mmss(t1 - t0)} (one run), ${method}`);

  rec = { ...rec, hubCarry: carry, cc3AcceptedAt: iso(t1), propagationSeconds: t1 - t0, propagationMethod: method };
  const jsonPath = writeRecord(rec);
  say(`  wrote ${jsonPath}`);

  step('Verifying against the deployed contracts');
  await check(rec, () => reobservePublication(transport, confirmedEntry, confirmation));
}

/** `--check`, also reused as the tail of `--publish` so a publish is never reported unverified. */
async function check(carried?: Record, finalSourceCheck?: () => Promise<PublicationConfirmation>): Promise<void> {
  if (carried && !finalSourceCheck) throw new PublicationJournalError('PUBLICATION_FINAL_CHECK_REQUIRED');
  const expectedIssuer = expectedDemoIssuer(process.env.DEMO_EXPECTED_ISSUER);
  const runtimePins = epochRuntimePins(process.env);
  const { src, headers, hub } = providers();
  try {
  const observation = await captureEpochHub(hub), at = { blockTag: observation.blockNumber };
  const runtimeObservation = await checkEpochRuntimes(src, hub,
    { source: SOURCE_ADDRESS, asc: ASC_ADDRESS, registry: REGISTRY_ADDRESS }, runtimePins, observation.blockNumber);
  await requireRosterV2(hub, REGISTRY_ADDRESS, observation.blockNumber);
  const asc = new ethers.Contract(ASC_ADDRESS, ASC_ABI, hub);
  const reg = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, hub);
  if ((await reg.ASC(at)).toLowerCase() !== ASC_ADDRESS.toLowerCase()) throw new Error('EPOCH_REGISTRY_ASC_MISMATCH');
  await requireEpochV2(() => asc.EPOCH_SCHEMA_VERSION(at));
  await requireRosterAuthorization(() => asc.ROSTER_AUTH_VERSION(at));
  const policyObservation = await checkEpochPolicies(hub, REGISTRY_ADDRESS, expectedIssuer, observation.blockNumber);

  const latestEpoch = Number(await retry('latestEpoch()', () => asc.latestEpoch(at)));
  if (carried) requireCurrentPublishedEpoch(carried.epoch, latestEpoch);
  if (latestEpoch === 0) {
    step('no epoch published yet (latestEpoch=0)');
    say('  Mode B is implemented and tested, but nothing has been published on chain, so there is no');
    say('  root to verify against. Every deployed mark is origin = Direct.');
    say('  Publish one with: npx tsx script/publish-epoch.ts --publish   (worker running first)');
    throw new Error('EPOCH_VERIFICATION_FAILED');
  }

  // Reproduce the originally reviewed cutoff, never compare a later active set to an old root.
  const original: Record = carried?.epoch === latestEpoch ? carried : JSON.parse(readFileSync(recordPath(latestEpoch), 'utf8'));
  const input = original.sourceSnapshot;
  if (!input || input.version !== 2 || input.source.toLowerCase() !== SOURCE_ADDRESS.toLowerCase() || input.chainId !== '11155111') throw new Error('epoch source snapshot record missing or mismatched; historical records are not upgraded by inference');
  step('Replaying the recorded finalized source cutoff');
  const r = await buildFromChain(src, headers, hub, input.cutoffBlock, input.cutoffBlockHash, observation.blockNumber);
  assertSourceSnapshot(input, r.sourceSnapshot);
  const [sourceCutoff, publishedAt, snapshotId, listVersion] = await Promise.all([
    asc.epochSourceCutoff(at), asc.epochPublishedAt(at), asc.epochSnapshotId(at), asc.epochListVersion(at),
  ]);
  if (Number(sourceCutoff) !== input.cutoffTimestamp) throw new Error('hub source cutoff differs from source snapshot');
  printRoster(r);

  const [onChainRoot, validUntil, fresh] = await Promise.all([
    retry('epochRoots()', () => asc.epochRoots(latestEpoch, at) as Promise<string>),
    retry('epochValidUntil()', () => asc.epochValidUntil(at) as Promise<bigint>),
    retry('isRosterFresh()', () => asc.isRosterFresh(at) as Promise<boolean>),
  ]);

  step(`On-chain epoch ${latestEpoch}`);
  say(`  root       ${onChainRoot}`);
  say(`  validUntil ${Number(validUntil)} (${iso(Number(validUntil))})`);
  say(`  fresh      ${fresh}`);

  if (onChainRoot.toLowerCase() !== r.tree.root.toLowerCase()) {
    step('roster drift — refusing to print verdicts');
    bad(`rebuilt root  ${r.tree.root}`);
    bad(`on-chain root ${onChainRoot}`);
    bad('The exact recorded cutoff does not reproduce the published root. Do not edit the roster');
    bad('to match or treat this as normal post-publication drift. Stop and investigate source history,');
    bad(`RPC consistency and the recorded publication at ${recordPath(latestEpoch)}.`);
    throw new Error('EPOCH_VERIFICATION_FAILED');
  }
  ok('rebuilt root matches the on-chain root');
  const approvedIssuers = [...new Set(r.tree.entries.map(e => e.issuer.toLowerCase()))];
  for (const issuer of approvedIssuers) {
    if (!(await asc.epochIssuerApproved(latestEpoch, issuer, at))) throw new Error(`epoch ${latestEpoch} has no authenticated approval for roster issuer ${issuer}`);
  }

  if (!fresh) {
    bad(`the roster is past its validUntil, so verifyWithRoster fails closed for every subject`);
  }

  const proofMode = await registryHasProofMode(hub, observation.blockNumber);
  const verdicts = proofMode ? await rosterVerdicts(hub, r.tree, observation.blockNumber) : [];
  const offChain = proofMode ? [] : offChainVerdicts(r.tree, onChainRoot);
  const allMatch = proofMode && verdicts.every(v => v.expected === v.actual);

  if (!proofMode) {
    step('the deployed ProofmarkRegistry has no proof-mode entry points');
    bad(`ProofmarkRegistry ${REGISTRY_ADDRESS} on CC3 carries neither 0x${SEL_VERIFY_WITH_ROSTER}`);
    bad(`(verifyWithRoster) nor 0x${SEL_PROVE_NOT_IN_ROSTER} (proveNotInRoster) in its runtime code:`);
    bad('the deployed build predates those functions, while src/ProofmarkRegistry.sol has them.');
    bad('So the contract-side roster verdicts DID NOT RUN. They are not recorded, and no README');
    bad('snippet below claims them. Calling the functions anyway would return "execution reverted",');
    bad('which reads exactly like a proof that failed, and that is the one answer worth refusing.');
    bad('Remedy, outside this script: deploy the current ProofmarkRegistry build against the same');
    bad('ASC and re-register the two policies. The ASC itself is the current build — it accepted');
    bad('this epoch — and cache mode (isVerified) on the deployed registry is unaffected.');

    step('Off-chain verification against the on-chain root (pipeline/roster.ts, not a contract verdict)');
    for (const v of offChain) {
      say(`  ${v.expected === v.actual ? 'ok ' : 'x  '}${v.label}\n       expected ${v.expected}  actual ${v.actual}`);
    }
    say('  src/lib/RosterProof.sol is pinned to this implementation by test/RosterProof.t.sol, so the');
    say('  two agree in tests. Agreeing in tests is not a deployed contract answering.');
  }

  // Preserve original source facts, not previous checks/propagation. Only `carried` can supply
  // a propagation measurement from this same invocation; current contract reads supply checks.
  const rec: Record = {
    ...sourceEpochRecord(original),
    ...(carried ?? {}),
    hubObservation: observation,
    policyObservation,
    runtimeObservation,
    sourceSnapshot: r.sourceSnapshot,
    rosterAuthVersion: 1, approvedIssuers,
    epochSchemaVersion: 2,
    sourceCutoff: Number(sourceCutoff),
    publishedAt: Number(publishedAt),
    snapshotId,
    rosterFormatVersion: r.tree.formatVersion,
    epoch: latestEpoch,
    root: onChainRoot,
    listVersion: Number(listVersion),
    validUntil: Number(validUntil),
    validUntilIso: iso(Number(validUntil)),
    entryCount: r.tree.entries.length,
    entries: r.tree.entries,
    excluded: r.excluded,
    registryProofMode: proofMode,
    checks: proofMode ? verdicts : undefined,
    offChainChecks: proofMode ? undefined : offChain,
    checkedAt: new Date().toISOString().replace('.000Z', 'Z'),
  };

  // The long source replay and verdict calls must not turn a replaced hub block or source
  // cutoff into a completed observation. No record/snippet is written before these checks.
  const sourceBlock = await src.getBlock(input.cutoffBlock);
  if (sourceBlock?.number !== input.cutoffBlock || sourceBlock.hash !== input.cutoffBlockHash
    || sourceBlock.timestamp !== input.cutoffTimestamp) throw new Error('EPOCH_SOURCE_OBSERVATION_CHANGED');
  if (finalSourceCheck) rec.sourcePublicationObservation = await finalSourceCheck();
  if (carried?.hubCarry) {
    const c = carried.hubCarry;
    const [block, receipt] = await Promise.all([hub.getBlock(c.blockNumber), hub.getTransactionReceipt(c.transactionHash)]);
    if (block?.number !== c.blockNumber || block.hash !== c.blockHash || !receipt || receipt.status !== 1
      || receipt.hash !== c.transactionHash || receipt.blockNumber !== c.blockNumber || receipt.blockHash !== c.blockHash)
      throw new Error('EPOCH_HUB_CARRY_CHANGED');
  }
  await assertEpochHub(hub, observation);
  if (proofMode) printVerdicts(verdicts);
  const jsonPath = writeRecord(rec);
  step('Recorded');
  say(`  ${jsonPath}`);

  if (!proofMode) {
    bad('exiting non-zero: the epoch is published and verified against the rebuilt tree, but the');
    bad('contract-side roster verdicts could not be produced. A check that did not run stays unset.');
    throw new Error('EPOCH_VERIFICATION_FAILED');
  }
  if (!allMatch || !fresh) {
    bad('at least one verdict did not match expectation');
    throw new Error('EPOCH_VERIFICATION_FAILED');
  }
  const mdPath = writeSnippet(rec);
  say(`  ${mdPath}   observation snippet; independently verify before submission`);
  step('all verdicts match expectation');
  } finally { src.destroy(); headers.destroy(); hub.destroy(); }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const unknown = flags.filter((f) => !['--dry-run', '--publish', '--resume-publication', '--check-publication', '--cancel-unsigned-publication', '--check', '--help'].includes(f));
  if (unknown.length) { bad(`unknown flag ${unknown.join(' ')}`); usage(); process.exit(1); }

  if (flags.includes('--help')) { usage(); return; }
  if (flags.length > 1 || process.argv.slice(2).some(a => !a.startsWith('--'))) throw new Error('choose exactly one mode; positional arguments are unsupported');
  if (flags.includes('--resume-publication')) return publish('resume');
  if (flags.includes('--check-publication')) return checkPublication();
  if (flags.includes('--cancel-unsigned-publication')) return publish('cancel');
  if (flags.includes('--publish')) return publish();
  if (flags.includes('--check')) return check();
  return dryRun();
}

main().catch((e) => {
  const publication = process.argv.slice(2).some(f => ['--publish', '--resume-publication', '--check-publication', '--cancel-unsigned-publication'].includes(f));
  bad(publication ? (e instanceof PublicationJournalError ? e.code : 'PUBLICATION_DEPENDENCY_UNAVAILABLE') : e?.shortMessage ?? e?.message ?? String(e));
  process.exit(1);
});
