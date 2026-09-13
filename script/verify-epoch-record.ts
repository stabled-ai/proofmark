/**
 * Rebuilds a checked-in epoch record, reads its root from CC3, and asks the deployed registry for
 * the three verdicts used in the submission. Read-only: no key is loaded and no state is written.
 *
 * Records written by the v1 publisher (no version stamps) are verified against the live v1 build
 * with the ported roster format 1; records with v2 stamps require the v2 contracts.
 */
import { ethers } from 'ethers';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRoster, inclusionProof, leafIndexOf, nonInclusionProof, type RosterEntry } from '../pipeline/roster.js';
import { unpackAttrs } from '../pipeline/attrs.js';
import { ROSTER_REGISTRY_ABI, assertRosterRecordVersion, requireRosterV2 } from '../pipeline/roster-format.js';
import {
  LEGACY_ASC_ABI, LEGACY_REGISTRY_ABI, buildLegacyRoster, detectRosterGeneration, isLegacyRosterRecord,
  legacyInclusionProof, legacyLeafIndexOf, legacyNonInclusionProof,
} from '../pipeline/roster-legacy-v1.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(repo, path), 'utf8')) as T;
const deployment = readJson<{ contracts: { ProofmarkASC: string; ProofmarkRegistry: string } }>('deployments/cc3-testnet.json');
// Default to the newest checked-in epoch record; an older record is no longer the latest epoch on chain.
const newestRecord = readdirSync(join(repo, 'deployments')).filter(name => /^epoch-\d+\.json$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).at(-1);
if (!newestRecord) throw new Error('no deployments/epoch-N.json record found');
const recordArg = process.argv[2] ?? `deployments/${newestRecord}`;
type EpochRecord = {
  rosterFormatVersion?: number;
  epochSchemaVersion?: number;
  rosterAuthVersion?: number;
  sourceCutoff?: number;
  publishedAt?: number;
  snapshotId?: string;
  epoch: number;
  root: string;
  validUntil: number;
  entries: RosterEntry[];
};
const record = readJson<EpochRecord>(recordArg);

const RPC = process.env.CREDITCOIN_RPC_URL ?? 'https://rpc.cc3-testnet.creditcoin.network';
const NEVER_ISSUED = '0x00000000000000000000000000000000DeaDBeef';
const DEMO_SUBJECT = '0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2';
const provider = new ethers.JsonRpcProvider(RPC, 102031, { staticNetwork: true });
const requiredRemaining = Number(process.env.EPOCH_MIN_REMAINING_SECONDS ?? '3600');
if (!Number.isSafeInteger(requiredRemaining) || requiredRemaining <= 0 || requiredRemaining > 86_400) throw new Error('EPOCH_MIN_REMAINING_SECONDS must be 1..86400');

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function verifyLegacyRecord(): Promise<void> {
  const network = await provider.getNetwork();
  check('connected to Creditcoin CC3 Testnet', network.chainId === 102031n, `chainId ${network.chainId}`);
  const generation = await detectRosterGeneration(provider, deployment.contracts.ProofmarkRegistry);
  check('record generation matches the deployed registry', generation === 'v1-live', `record v1 (no version stamps), registry ${generation}`);
  if (generation !== 'v1-live') return;

  const tree = buildLegacyRoster(record.entries);
  check('checked-in entries reproduce the recorded root (roster format 1)', tree.root.toLowerCase() === record.root.toLowerCase(), tree.root);

  const asc = new ethers.Contract(deployment.contracts.ProofmarkASC, LEGACY_ASC_ABI, provider);
  const registry = new ethers.Contract(deployment.contracts.ProofmarkRegistry, LEGACY_REGISTRY_ABI, provider);
  const latestBlock = await provider.getBlock('latest');
  if (!latestBlock) throw new Error('hub block unavailable; cannot verify a common observation time');
  const atBlock = { blockTag: latestBlock.number };
  const [latestEpoch, storedRoot, validUntil, fresh] = await Promise.all([
    asc.latestEpoch(atBlock) as Promise<bigint>,
    asc.epochRoots(record.epoch, atBlock) as Promise<string>,
    asc.epochValidUntil(atBlock) as Promise<bigint>,
    asc.isRosterFresh(atBlock) as Promise<boolean>,
  ]);
  check('record is the latest published epoch', Number(latestEpoch) === record.epoch, `chain ${latestEpoch}, record ${record.epoch}`);
  check('CC3 stores the recorded root', storedRoot.toLowerCase() === record.root.toLowerCase(), storedRoot);
  check('roster is fresh', fresh, `validUntil ${iso(Number(validUntil))}`);
  check('recorded validUntil matches CC3', record.validUntil === Number(validUntil));

  const entryIndex = tree.entries.findIndex((entry) => entry.subject.toLowerCase() === DEMO_SUBJECT.toLowerCase());
  check('demo subject is in the recorded roster', entryIndex >= 0, DEMO_SUBJECT);
  if (entryIndex < 0) return;

  const entry = tree.entries[entryIndex];
  const mark = { attrs: entry.attrs, claimsRoot: entry.claimsRoot, evidenceHash: entry.evidenceHash, issuer: entry.issuer };
  const inclusion = legacyInclusionProof(tree, legacyLeafIndexOf(entryIndex));
  const absent = legacyNonInclusionProof(tree, NEVER_ISSUED);
  const [production, pilot, absentVerdict, pilotPolicy, currentMark] = await Promise.all([
    registry.verifyWithRoster(entry.subject, 1n, mark, inclusion, atBlock) as Promise<boolean>,
    registry.verifyWithRoster(entry.subject, 2n, mark, inclusion, atBlock) as Promise<boolean>,
    registry.proveNotInRoster(NEVER_ISSUED, absent, atBlock) as Promise<boolean>,
    registry.policies(2n, atBlock) as Promise<ethers.Result>,
    asc.getMark(entry.subject, atBlock) as Promise<ethers.Result>,
  ]);
  const attrs = unpackAttrs(entry.attrs);
  const maxAge = Number(pilotPolicy.maxAge);
  const ageUntil = maxAge === 0 ? Number.MAX_SAFE_INTEGER : attrs.issuedAt + maxAge;
  const effectiveUntil = Math.min(attrs.expiry, ageUntil, Number(validUntil));
  const remaining = effectiveUntil - latestBlock.timestamp;
  check('production policy 1 rejects the recorded sandbox mark', production === false, String(production));
  check('sandbox policy 2 accepts the recorded mark through the roster', pilot === true,
    pilot ? String(pilot) : `false — the recorded mark was issued ${iso(attrs.issuedAt)} and policy 2 allows ${maxAge}s of age; publish a fresh epoch with the current marks`);
  check('unissued control proves non-membership', absentVerdict === true, String(absentVerdict));
  if (Number(currentMark[7]) !== attrs.issuedAt) {
    console.log(`INFO  the subject's current Direct mark was issued ${iso(Number(currentMark[7]))}; the recorded roster carries the ${iso(attrs.issuedAt)} mark. Roster verdicts apply to the recorded mark until a fresh epoch is published.`);
  }
  check(`recorded roster evidence has at least ${requiredRemaining}s freshness remaining (recording margin, not policy lifetime)`, remaining >= requiredRemaining,
    `${Math.floor(remaining / 3600)}h remaining; effective until ${iso(effectiveUntil)}`);
  check('observation block remains canonical', (await provider.getBlock(latestBlock.number))?.hash === latestBlock.hash);
  console.log('NOTE  roster format 1 is the legacy v1 build. Its non-inclusion proof accepts internal nodes as leaves; publish new roots only with the corrected v2 contracts and format.');
}

async function verifyV2Record(): Promise<void> {
  assertRosterRecordVersion(record);
  const asc = new ethers.Contract(deployment.contracts.ProofmarkASC, [
    'function latestEpoch() view returns (uint32)',
    'function epochRoots(uint32) view returns (bytes32)',
    'function epochValidUntil() view returns (uint40)',
    'function isRosterFresh() view returns (bool)',
    'function epochSourceCutoff() view returns (uint40)',
    'function epochPublishedAt() view returns (uint40)',
    'function epochSnapshotId() view returns (bytes32)',
    'function epochIssuerApproved(uint32,address) view returns (bool)',
  ], provider);
  const registry = new ethers.Contract(deployment.contracts.ProofmarkRegistry, [
    'function policies(uint256) view returns (uint32 requireAll,uint8 minAssurance,uint40 maxAge,uint16 requiredRegime,uint16 requiredJurisdiction,address trustedIssuer,bool requireRoster,bool exists)',
    ...ROSTER_REGISTRY_ABI,
  ], provider);

  const network = await provider.getNetwork();
  await requireRosterV2(provider, deployment.contracts.ProofmarkRegistry);
  check('connected to Creditcoin CC3 Testnet', network.chainId === 102031n, `chainId ${network.chainId}`);

  const tree = buildRoster(record.entries);
  check('checked-in entries reproduce the recorded root', tree.root.toLowerCase() === record.root.toLowerCase(), tree.root);

  const latestBlock = await provider.getBlock('latest');
  if (!latestBlock) throw new Error('hub block unavailable; cannot verify a common observation time');
  const atBlock = { blockTag: latestBlock.number };
  const [latestEpoch, storedRoot, validUntil, fresh, sourceCutoff, publishedAt, snapshotId] = await Promise.all([
    asc.latestEpoch(atBlock) as Promise<bigint>,
    asc.epochRoots(record.epoch, atBlock) as Promise<string>,
    asc.epochValidUntil(atBlock) as Promise<bigint>,
    asc.isRosterFresh(atBlock) as Promise<boolean>,
    asc.epochSourceCutoff(atBlock) as Promise<bigint>,
    asc.epochPublishedAt(atBlock) as Promise<bigint>,
    asc.epochSnapshotId(atBlock) as Promise<string>,
  ]);
  check('record is the latest published epoch', Number(latestEpoch) === record.epoch, `chain ${latestEpoch}, record ${record.epoch}`);
  check('CC3 stores the recorded root', storedRoot.toLowerCase() === record.root.toLowerCase(), storedRoot);
  check('roster is fresh', fresh, `validUntil ${iso(Number(validUntil))}`);
  check('recorded epoch provenance matches CC3', record.sourceCutoff === Number(sourceCutoff) && record.publishedAt === Number(publishedAt)
    && record.validUntil === Number(validUntil) && record.snapshotId?.toLowerCase() === snapshotId.toLowerCase());
  for (const issuer of new Set(tree.entries.map(entry => entry.issuer.toLowerCase()))) {
    check(`authenticated approval for roster issuer ${issuer}`, await asc.epochIssuerApproved(record.epoch, issuer, atBlock));
  }

  const entryIndex = tree.entries.findIndex((entry) => entry.subject.toLowerCase() === DEMO_SUBJECT.toLowerCase());
  check('demo subject is in the recorded roster', entryIndex >= 0, DEMO_SUBJECT);
  if (entryIndex < 0) process.exit(1);

  const entry = tree.entries[entryIndex];
  const mark = { attrs: entry.attrs, claimsRoot: entry.claimsRoot, evidenceHash: entry.evidenceHash, issuer: entry.issuer };
  const inclusion = inclusionProof(tree, leafIndexOf(entryIndex));
  const absent = nonInclusionProof(tree, NEVER_ISSUED);
  const nonInclusion = {
    left: absent.left,
    leftKey: absent.leftKey,
    leftMark: absent.leftMark,
    right: absent.right,
    rightKey: absent.rightKey,
    rightMark: absent.rightMark,
  };

  const [production, pilot, absentVerdict, pilotPolicy] = await Promise.all([
    registry.verifyWithRoster(entry.subject, 1n, mark, inclusion, atBlock) as Promise<boolean>,
    registry.verifyWithRoster(entry.subject, 2n, mark, inclusion, atBlock) as Promise<boolean>,
    registry.proveNotInRoster(NEVER_ISSUED, nonInclusion, atBlock) as Promise<boolean>,
    registry.policies(2n, atBlock) as Promise<ethers.Result>,
  ]);
  check('production policy 1 rejects the sandbox mark', production === false, String(production));
  check('sandbox policy 2 accepts the same mark', pilot === true, String(pilot));
  check('unissued control proves non-membership', absentVerdict === true, String(absentVerdict));

  const attrs = unpackAttrs(entry.attrs);
  const chainNow = latestBlock.timestamp;
  const maxAge = Number(pilotPolicy.maxAge ?? pilotPolicy[2]);
  const ageUntil = maxAge === 0 ? Number.MAX_SAFE_INTEGER : attrs.issuedAt + maxAge;
  const effectiveUntil = Math.min(attrs.expiry, ageUntil, Number(validUntil));
  const remaining = effectiveUntil - chainNow;
  check(`demo evidence has at least ${requiredRemaining}s freshness remaining (recording margin, not policy lifetime)`, remaining >= requiredRemaining,
    `${Math.floor(remaining / 3600)}h remaining; effective until ${iso(effectiveUntil)}`);
  check('observation block remains canonical', (await provider.getBlock(latestBlock.number))?.hash === latestBlock.hash);
}

try {
  if (isLegacyRosterRecord(record)) await verifyLegacyRecord(); else await verifyV2Record();
} finally { provider.destroy(); }

if (failures) {
  console.error(`\n${failures} epoch verification(s) failed.`);
  process.exit(1);
}
console.log('\nRecorded epoch and all three on-chain verdicts verified. No transaction was sent.');
