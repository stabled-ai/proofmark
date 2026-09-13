import { ethers } from 'ethers';

/**
 * Roster format 1, as deployed by the live `v1-live` build (`deployments/cc3-testnet.json`).
 *
 * This is a read-only port of the pre-v2 `pipeline/roster.ts`, kept so the judge verification path
 * can rebuild and verify the historical epoch records against the deployed registry. It must not
 * be used to publish new roots: the v2 format in `pipeline/roster.ts` fixes the leaf/internal-node
 * ambiguity, and new publications use that format.
 */

export interface LegacyRosterEntry {
  subject: string;
  attrs: string;
  claimsRoot: string;
  evidenceHash: string;
  issuer: string;
}

export interface LegacyRosterTree {
  entries: LegacyRosterEntry[];
  keys: string[];
  marks: string[];
  leaves: string[];
  layers: string[][];
  root: string;
}

export interface LegacyInclusionProof { index: number; siblings: string[] }
export interface LegacyNonInclusionProof {
  left: LegacyInclusionProof; leftKey: string; leftMark: string;
  right: LegacyInclusionProof; rightKey: string; rightMark: string;
}

export const LEGACY_EVM_NAMESPACE = 'eip155';
export const LEGACY_MIN_KEY = '0x' + '00'.repeat(32);
export const LEGACY_MAX_KEY = '0x' + 'ff'.repeat(32);
const SENTINEL_MARK = '0x' + '00'.repeat(32);

/** A checked-in epoch record without the v2 version stamps was produced by the v1 publisher. */
export function isLegacyRosterRecord(record: { rosterFormatVersion?: unknown; epochSchemaVersion?: unknown; rosterAuthVersion?: unknown }): boolean {
  return record.rosterFormatVersion === undefined && record.epochSchemaVersion === undefined && record.rosterAuthVersion === undefined;
}

export function legacySubjectKey(subject: string, namespace = LEGACY_EVM_NAMESPACE): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string', 'address'], [namespace, ethers.getAddress(subject)]));
}

export function legacyMarkHash(e: LegacyRosterEntry): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32', 'bytes32', 'address'], [e.attrs, e.claimsRoot, e.evidenceHash, ethers.getAddress(e.issuer)]));
}

const leafOf = (key: string, mark: string) => ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [key, mark]));
const hashNode = (left: string, right: string) => ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]));

/** Tree index of `entries[i]`; the low sentinel shifts it by one. */
export function legacyLeafIndexOf(i: number): number { return i + 1; }

export function buildLegacyRoster(entries: readonly LegacyRosterEntry[], namespace = LEGACY_EVM_NAMESPACE): LegacyRosterTree {
  const withKeys = entries.map((e) => ({ e, k: legacySubjectKey(e.subject, namespace) }));
  withKeys.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  for (let i = 1; i < withKeys.length; i++) {
    if (withKeys[i].k === withKeys[i - 1].k) throw new Error(`buildLegacyRoster: duplicate subject ${withKeys[i].e.subject}`);
  }
  for (const { k, e } of withKeys) {
    if (k === LEGACY_MIN_KEY || k === LEGACY_MAX_KEY) throw new Error(`buildLegacyRoster: ${e.subject} collides with a sentinel key`);
  }
  const sorted = withKeys.map((x) => x.e);
  const keys = [LEGACY_MIN_KEY, ...withKeys.map((x) => x.k), LEGACY_MAX_KEY];
  const marks = [SENTINEL_MARK, ...sorted.map(legacyMarkHash), SENTINEL_MARK];
  const leaves = keys.map((key, i) => leafOf(key, marks[i]));
  const layers: string[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(hashNode(cur[i], i + 1 < cur.length ? cur[i + 1] : cur[i]));
    layers.push(next);
  }
  return { entries: sorted, keys, marks, leaves, layers, root: layers[layers.length - 1][0] };
}

export function legacyInclusionProof(tree: LegacyRosterTree, index: number): LegacyInclusionProof {
  if (index < 0 || index >= tree.leaves.length) throw new Error('legacyInclusionProof: index out of range');
  const siblings: string[] = [];
  let idx = index;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const pair = idx ^ 1;
    siblings.push(pair < layer.length ? layer[pair] : layer[idx]);
    idx >>= 1;
  }
  return { index, siblings };
}

export function verifyLegacyInclusion(root: string, leaf: string, proof: LegacyInclusionProof): boolean {
  let acc = leaf;
  let idx = proof.index;
  for (const s of proof.siblings) { acc = idx % 2 === 0 ? hashNode(acc, s) : hashNode(s, acc); idx >>= 1; }
  return acc.toLowerCase() === root.toLowerCase();
}

export function legacyNonInclusionProof(tree: LegacyRosterTree, target: string, namespace = LEGACY_EVM_NAMESPACE): LegacyNonInclusionProof {
  const tk = legacySubjectKey(target, namespace);
  if (tree.keys.includes(tk)) throw new Error('legacyNonInclusionProof: the target is in the roster');
  const hi = tree.keys.findIndex((k) => k > tk);
  if (hi <= 0) throw new Error('legacyNonInclusionProof: outside the sentinel range');
  const lo = hi - 1;
  return {
    left: legacyInclusionProof(tree, lo), leftKey: tree.keys[lo], leftMark: tree.marks[lo],
    right: legacyInclusionProof(tree, hi), rightKey: tree.keys[hi], rightMark: tree.marks[hi],
  };
}

export function verifyLegacyNonInclusion(root: string, target: string, proof: LegacyNonInclusionProof, namespace = LEGACY_EVM_NAMESPACE): boolean {
  const tk = legacySubjectKey(target, namespace);
  if (!(proof.leftKey < tk && tk < proof.rightKey)) return false;
  if (proof.right.index !== proof.left.index + 1) return false;
  return verifyLegacyInclusion(root, leafOf(proof.leftKey, proof.leftMark), proof.left)
    && verifyLegacyInclusion(root, leafOf(proof.rightKey, proof.rightMark), proof.right);
}

/** Views of the deployed v1 contracts. The v2 ABI in `roster-format.ts` is incompatible by design. */
export const LEGACY_REGISTRY_ABI = [
  'function ROSTER_FORMAT_VERSION() view returns (uint256)',
  'function isVerified(address,uint256) view returns (bool)',
  'function policyFrozen(uint256) view returns (bool)',
  'function policies(uint256) view returns (uint32 requireAll,uint8 minAssurance,uint40 maxAge,uint16 requiredRegime,uint16 requiredJurisdiction,address trustedIssuer,bool requireRoster,bool exists)',
  'function verifyWithRoster(address subject,uint256 policyId,(bytes32 attrs,bytes32 claimsRoot,bytes32 evidenceHash,address issuer) mark,(uint256 index,bytes32[] siblings) inclusion) view returns (bool)',
  'function proveNotInRoster(address subject,((uint256 index,bytes32[] siblings) left,bytes32 leftKey,bytes32 leftMark,(uint256 index,bytes32[] siblings) right,bytes32 rightKey,bytes32 rightMark) proof) view returns (bool)',
] as const;

export const LEGACY_ASC_ABI = [
  'function expectedChainKey() view returns (uint64)',
  'function sourceContract() view returns (address)',
  'function tombstone(address) view returns (bool)',
  'function getMark(address) view returns ((uint8 status,uint8 origin,uint8 kind,uint8 assurance,uint16 regime,uint16 jurisdiction,uint32 methods,uint40 issuedAt,uint40 expiry,uint32 epoch,bytes32 claimsRoot,bytes32 evidenceHash,address issuer))',
  'function latestEpoch() view returns (uint32)',
  'function epochRoots(uint32) view returns (bytes32)',
  'function epochValidUntil() view returns (uint40)',
  'function isRosterFresh() view returns (bool)',
] as const;

export type RosterGeneration = 'v1-live' | 'v2';

const isRevert = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'CALL_EXCEPTION';

/**
 * Which registry generation is deployed at `registry`. A v2 registry advertises
 * `ROSTER_FORMAT_VERSION() == 2`; the live v1 build has no such view and reverts. Network
 * failures and unknown versions are errors, never silently classified as v1.
 */
export async function detectRosterGeneration(provider: ethers.Provider, registry: string, blockTag?: number): Promise<RosterGeneration> {
  const at = blockTag === undefined ? {} : { blockTag };
  if ((await provider.getCode(registry, blockTag)) === '0x') throw new Error(`no contract code at registry ${registry}`);
  const iface = new ethers.Interface(LEGACY_REGISTRY_ABI);
  try {
    const raw = await provider.call({ to: registry, data: iface.encodeFunctionData('ROSTER_FORMAT_VERSION'), ...at });
    if (raw === '0x') return 'v1-live';
    const [version] = iface.decodeFunctionResult('ROSTER_FORMAT_VERSION', raw);
    if (version === 2n) return 'v2';
    throw new Error(`registry ${registry} advertises unknown roster format ${version}`);
  } catch (error) {
    if (isRevert(error)) return 'v1-live';
    throw error;
  }
}
