import { ethers } from 'ethers';
import { packAttrs, unpackAttrs, validCredentialAttrs } from './attrs.js';
import { ROSTER_SELECTORS } from './roster-format.js';
import { ROSTER_WITNESS_ABI } from './roster-witness.js';

export const STATUS_ASC_ABI = [
  'function expectedChainKey() view returns (uint64)', 'function sourceContract() view returns (address)',
  'function tombstone(address) view returns (bool)',
  'function getMark(address) view returns ((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))',
  'function latestEpoch() view returns (uint32)', 'function epochValidUntil() view returns (uint40)',
  'function isRosterFresh() view returns (bool)', 'function epochRoots(uint32) view returns (bytes32)',
  'function EPOCH_SCHEMA_VERSION() view returns (uint256)', 'function ROSTER_AUTH_VERSION() view returns (uint256)',
  'function ISSUER_KEY_PROVENANCE_VERSION() view returns (uint256)',
  'function TRANSACTION_PROCESSING_VERSION() view returns (uint256)', 'function ATTRS_SCHEMA_VERSION() view returns (uint256)',
  'function epochIssuerApproved(uint32,address) view returns (bool)',
  'function isEpochIssuerUsable(uint32,address) view returns (bool)',
  'function isMarkIssuerUsable(address) view returns (bool)', 'function markIssuerKeyEpoch(address) view returns (uint64)',
  'function epochSourceCutoff() view returns (uint40)', 'function epochPublishedAt() view returns (uint40)',
  'function epochSnapshotId() view returns (bytes32)',
] as const;
export const STATUS_REGISTRY_ABI = [
  'function ASC() view returns (address)', 'function ROSTER_FORMAT_VERSION() view returns (uint256)',
  'function EPOCH_SCHEMA_VERSION() view returns (uint256)', 'function ROSTER_AUTH_VERSION() view returns (uint256)',
  'function ISSUER_KEY_PROVENANCE_VERSION() view returns (uint256)',
  'function ATTRS_SCHEMA_VERSION() view returns (uint256)', 'function POLICY_SCHEMA_VERSION() view returns (uint256)',
  'function policyKind(uint256) view returns (uint8)', 'function isVerified(address,uint256) view returns (bool)',
  'function policies(uint256) view returns (uint32,uint8,uint40,uint16,uint16,address,bool,bool)',
  'function policyFrozen(uint256) view returns (bool)', ...ROSTER_WITNESS_ABI,
] as const;
const ZERO = ethers.ZeroAddress;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const optional = async (read: () => Promise<unknown>): Promise<number | null> => {
  try { const value = Number(await read()); return Number.isSafeInteger(value) ? value : null; } catch { return null; }
};
function directMark(m: ethers.Result) {
  return { status: Number(m[0]), origin: Number(m[1]), kind: Number(m[2]), assurance: Number(m[3]), regime: Number(m[4]), jurisdiction: Number(m[5]),
    methods: Number(m[6]), methodsHex: '0x' + Number(m[6]).toString(16), issuedAt: Number(m[7]), expiry: Number(m[8]), epoch: Number(m[9]),
    claimsRoot: String(m[10]), evidenceHash: String(m[11]), issuer: String(m[12]) };
}
type DecisionMark = ReturnType<typeof directMark>;

/** Registry boolean is authoritative for the observation block. Diagnostics are state-based,
 * not a source transaction, legal reason or finality proof. Optional failed reads are unknown. */
export async function readOnchainState(provider: ethers.Provider, config: { asc: string; registry: string; subject: string }, observationBlock?: number) {
  for (const address of Object.values(config)) if (!ethers.isAddress(address)) throw new Error('invalid on-chain address');
  if (observationBlock !== undefined && (!Number.isSafeInteger(observationBlock) || observationBlock < 0)) throw new Error('invalid observation block');
  if ((await provider.getNetwork()).chainId !== 102031n) throw new Error('wrong hub chain');
  const block = await provider.getBlock(observationBlock ?? 'latest');
  if (!block?.hash) throw new Error('observation block unavailable');
  if (observationBlock !== undefined && block.number !== observationBlock) throw new Error('observation block number mismatch');
  const at = { blockTag: block.number };
  const asc = new ethers.Contract(config.asc, STATUS_ASC_ABI, provider);
  const reg = new ethers.Contract(config.registry, STATUS_REGISTRY_ABI, provider);
  const versionNames = ['ROSTER_FORMAT_VERSION', 'EPOCH_SCHEMA_VERSION', 'ROSTER_AUTH_VERSION', 'ISSUER_KEY_PROVENANCE_VERSION', 'ROSTER_WITNESS_VERSION', 'ATTRS_SCHEMA_VERSION', 'POLICY_SCHEMA_VERSION'] as const;
  const ascNames = ['EPOCH_SCHEMA_VERSION', 'ROSTER_AUTH_VERSION', 'ISSUER_KEY_PROVENANCE_VERSION', 'ATTRS_SCHEMA_VERSION', 'TRANSACTION_PROCESSING_VERSION'] as const;
  const [boundAsc, chainKey, source, tomb, rawMark, directIssuerUsable, directKeyEpoch, epoch, validUntil, fresh, code, versions, ascVersions, rawPolicies] = await Promise.all([
    reg.ASC(at) as Promise<string>, asc.expectedChainKey(at), asc.sourceContract(at), asc.tombstone(config.subject, at), asc.getMark(config.subject, at),
    optional(() => asc.isMarkIssuerUsable(config.subject, at)), optional(() => asc.markIssuerKeyEpoch(config.subject, at)),
    asc.latestEpoch(at), asc.epochValidUntil(at), asc.isRosterFresh(at), provider.getCode(config.registry, block.number),
    Promise.all(versionNames.map(name => optional(() => reg[name](at)))),
    Promise.all(ascNames.map(name => optional(() => asc[name](at)))),
    Promise.all([1, 2].map(async id => {
      const [p, frozen, verified] = await Promise.all([reg.policies(id, at), reg.policyFrozen(id, at), reg.isVerified(config.subject, id, at)]);
      return { id, name: id === 1 ? 'KR VASP production' : 'KR sandbox pilot', requireAll: Number(p[0]), requireAllHex: '0x' + Number(p[0]).toString(16),
        minAssurance: Number(p[1]), maxAge: Number(p[2]), requiredRegime: Number(p[3]), requiredJurisdiction: Number(p[4]), trustedIssuer: String(p[5]),
        requireRoster: Boolean(p[6]), exists: Boolean(p[7]), frozen: Boolean(frozen), verified: Boolean(verified) };
    })),
  ]);
  if (!same(boundAsc, config.asc) || Number(chainKey) !== 1) throw new Error('registry/ASC source binding mismatch');
  const [format, epochSchema, auth, keyProvenance, witnessVersion, attrsSchema, policySchema] = versions;
  const compatible = directIssuerUsable !== null && directKeyEpoch !== null
    && format === 2 && epochSchema === 2 && auth === 1 && keyProvenance === 1 && attrsSchema === 0 && policySchema === 2
    && ascVersions[0] === 2 && ascVersions[1] === 1 && ascVersions[2] === 1 && ascVersions[3] === 0 && ascVersions[4] === 2;
  const m = directMark(rawMark);
  const latestEpoch = Number(epoch);
  const [root, issuerTombstoned, kinds, rawWitness, provenance] = await Promise.all([
    latestEpoch ? asc.epochRoots(latestEpoch, at) as Promise<string> : null,
    same(m.issuer, ZERO) ? false : asc.tombstone(m.issuer, at) as Promise<boolean>,
    policySchema === 2 ? Promise.all(rawPolicies.map(p => reg.policyKind(p.id, at).then(Number))) : [null, null],
    witnessVersion === 1 ? reg.getRosterWitness(config.subject, at) as Promise<ethers.Result> : null,
    ascVersions[0] === 2 ? Promise.all([asc.epochSourceCutoff(at), asc.epochPublishedAt(at), asc.epochSnapshotId(at)]) : null,
  ]);
  let witness: { epoch: number; mark: DecisionMark; issuerApproved: boolean } | null = null;
  if (rawWitness) {
    const w = rawWitness[1]; const attrs = unpackAttrs(w[0]);
    witness = { epoch: Number(rawWitness[0]), mark: { ...attrs, status: 1, origin: 2, methodsHex: '0x' + attrs.methods.toString(16),
      claimsRoot: String(w[1]), evidenceHash: String(w[2]), issuer: String(w[3]) },
    issuerApproved: ascVersions[1] === 1 && ascVersions[2] === 1 && Number(rawWitness[0]) > 0
      ? Boolean(await asc.isEpochIssuerUsable(rawWitness[0], w[3], at)) : false };
  }
  const policies = rawPolicies.map((p, i) => {
    const reasonCodes: string[] = [];
    const decisionMark = p.requireRoster ? (witnessVersion === 1 && witness?.epoch ? witness.mark : null) : m;
    if (!compatible) reasonCodes.push('LEGACY_OR_UNCONFIRMED_SCHEMA');
    else {
      if (!p.exists) reasonCodes.push('UNKNOWN_POLICY');
      if (tomb) reasonCodes.push('SUBJECT_TOMBSTONED');
      if (p.requireRoster) {
        if (witnessVersion !== 1) reasonCodes.push('WITNESS_CAPABILITY_UNAVAILABLE');
        else if (!witness?.epoch) reasonCodes.push('AWAITING_ROSTER_WITNESS');
        else {
          if (witness.epoch !== latestEpoch) reasonCodes.push('STALE_ROSTER_WITNESS');
          if (!witness.issuerApproved) reasonCodes.push('ISSUER_ROOT_NOT_APPROVED');
        }
        if (!fresh) reasonCodes.push('ROSTER_NOT_FRESH');
      } else {
        if (m.status !== 1) reasonCodes.push('NO_ACTIVE_DIRECT_MARK');
        if (!directIssuerUsable) reasonCodes.push('ISSUER_KEY_COMPROMISE_CUTOFF');
      }
      if (decisionMark) {
        const d = decisionMark;
        if (!validCredentialAttrs(packAttrs(d))) reasonCodes.push('INVALID_CREDENTIAL_SCHEMA');
        if (d.kind !== kinds[i]) reasonCodes.push('WRONG_CREDENTIAL_KIND');
        if ((d.methods & p.requireAll) !== p.requireAll) reasonCodes.push('MISSING_METHODS');
        if (d.assurance < p.minAssurance) reasonCodes.push('LOW_ASSURANCE');
        if (p.requiredRegime && d.regime !== p.requiredRegime) reasonCodes.push('WRONG_REGIME');
        if (p.requiredJurisdiction && d.jurisdiction !== p.requiredJurisdiction) reasonCodes.push('WRONG_JURISDICTION');
        if (same(d.issuer, ZERO) || (!same(p.trustedIssuer, ZERO) && !same(d.issuer, p.trustedIssuer))) reasonCodes.push('WRONG_ISSUER');
        if (d.expiry <= block.timestamp) reasonCodes.push('CREDENTIAL_EXPIRED');
        if (d.issuedAt > block.timestamp) reasonCodes.push('FUTURE_ISSUANCE');
        if (p.maxAge && block.timestamp - d.issuedAt > p.maxAge) reasonCodes.push('CREDENTIAL_TOO_OLD');
      }
    }
    const diagnosis = !compatible ? 'unavailable' : p.verified === (reasonCodes.length === 0) ? 'consistent' : 'unexplained';
    return { ...p, kind: kinds[i], policySchemaVersion: policySchema, decisionMark, reasonCodes, diagnosis,
      verdictSource: 'Registry.isVerified', warning: !p.requireRoster ? 'Direct proof does not establish continued revocation freshness.' : 'Current witness still trusts issuer screening and roster completeness.' };
  });
  if ((await provider.getBlock(block.number))?.hash !== block.hash) throw new Error('observation block changed; retry instead of mixing states');
  return { subject: config.subject, blockNumber: block.number,
    observation: { blockHash: block.hash, timestamp: block.timestamp, chainId: 102031, finality: 'latest-observed-not-finalized', canonicalAtCheck: true },
    asc: { address: config.asc, expectedChainKey: Number(chainKey), sourceContract: String(source), versions: Object.fromEntries(ascNames.map((n, i) => [n, ascVersions[i]])) },
    registry: { address: config.registry, proofMode: compatible && ROSTER_SELECTORS.every(sel => code.toLowerCase().includes(sel)), rosterFormatVersion: format,
      compatible, versions: Object.fromEntries(versionNames.map((n, i) => [n, versions[i]])) },
    tombstone: Boolean(tomb), mark: { ...m, issuerTombstoned, issuerKeyEpoch: Number(directKeyEpoch), issuerKeyUsable: Boolean(directIssuerUsable) }, policies, witness,
    epoch: { latestEpoch, root, validUntil: Number(validUntil), fresh: Boolean(fresh), sourceCutoff: provenance ? Number(provenance[0]) : null,
      publishedAt: provenance ? Number(provenance[1]) : null, snapshotId: provenance ? String(provenance[2]) : null },
    propagation: { sourceTransaction: null, hubTransaction: null, status: 'not-resolved-by-state-read' },
  };
}
