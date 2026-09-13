import { ethers } from 'ethers';
import { ROSTER_FORMAT_VERSION } from './roster.js';
import { requireEpochV2 } from './epoch.js';
import { requireRosterAuthorization } from './roster-authorization.js';

/** A single ABI definition for the incompatible, size-bound v2 proof format. */
export const ROSTER_REGISTRY_ABI = [
  'function ROSTER_FORMAT_VERSION() view returns (uint256)',
  'function EPOCH_SCHEMA_VERSION() view returns (uint256)',
  'function ROSTER_AUTH_VERSION() view returns (uint256)',
  'function verifyWithRoster(address subject,uint256 policyId,(bytes32 attrs,bytes32 claimsRoot,bytes32 evidenceHash,address issuer) mark,(uint256 index,uint256 leafCount,bytes32[] siblings) inclusion) view returns (bool)',
  'function proveNotInRoster(address subject,((uint256 index,uint256 leafCount,bytes32[] siblings) left,bytes32 leftKey,bytes32 leftMark,(uint256 index,uint256 leafCount,bytes32[] siblings) right,bytes32 rightKey,bytes32 rightMark) proof) view returns (bool)',
] as const;

export const ROSTER_SELECTORS = ['verifyWithRoster', 'proveNotInRoster'].map(
  (name) => new ethers.Interface(ROSTER_REGISTRY_ABI).getFunction(name)!.selector.slice(2),
);

export function assertRosterRecordVersion(record: { rosterFormatVersion?: number; epochSchemaVersion?: number; rosterAuthVersion?: number }): void {
  if (record.rosterFormatVersion !== ROSTER_FORMAT_VERSION || record.epochSchemaVersion !== 2 || record.rosterAuthVersion !== 1) {
    throw new Error('Legacy or unknown roster record: roster format 2, epoch schema 2 AND roster authorization 1 require compatible v2 contracts and fresh publication. Preserve historical records.');
  }
}

export async function requireRosterV2(provider: ethers.Provider, registry: string, blockTag?: number): Promise<void> {
  const contract = new ethers.Contract(registry, ROSTER_REGISTRY_ABI, provider);
  const at = blockTag === undefined ? {} : { blockTag };
  const version = await contract.ROSTER_FORMAT_VERSION(at).catch(() => null);
  if (version !== BigInt(ROSTER_FORMAT_VERSION)) {
    throw new Error(`Registry ${registry} does not advertise roster v2. Refusing to publish or verify v2 roots against a legacy or unknown deployment.`);
  }
  await requireEpochV2(() => contract.EPOCH_SCHEMA_VERSION(at));
  await requireRosterAuthorization(() => contract.ROSTER_AUTH_VERSION(at));
}
