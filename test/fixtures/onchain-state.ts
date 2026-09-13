import { ethers } from 'ethers';
import { STATUS_ASC_ABI, STATUS_REGISTRY_ABI } from '../../pipeline/onchain-state.js';
import { packAttrs } from '../../pipeline/attrs.js';
import { ROSTER_SELECTORS } from '../../pipeline/roster-format.js';

/** Synthetic RPC state only. It cannot prove deployment or real protocol finality. */
export class StatusFixture {
  asc = '0x' + '11'.repeat(20); registry = '0x' + '22'.repeat(20); subject = '0x' + '33'.repeat(20); issuer = '0x' + '44'.repeat(20);
  hash = ethers.id('observation'); now = 1800000000; chainId = 102031n; reorg = false; wrongBinding = false; legacy = false;
  verified = true; fresh = true; tombstone = false; witnessEpoch = 1; approved = true;
  failMethod = ''; reads: { method: string; blockTag: unknown }[] = []; blockReads: unknown[] = [];
  attrs = { kind: 1, assurance: 3, regime: 1, jurisdiction: 410, methods: 1 << 16, issuedAt: this.now - 100, expiry: this.now + 2000, epoch: 0 };
  readonly ascAbi = new ethers.Interface(STATUS_ASC_ABI);
  readonly regAbi = new ethers.Interface(STATUS_REGISTRY_ABI);
  config() { return { asc: this.asc, registry: this.registry, subject: this.subject }; }
  call(to: string, data: string, blockTag: unknown) {
    const abi = to.toLowerCase() === this.asc ? this.ascAbi : this.regAbi;
    const f = abi.getFunction(data.slice(0, 10))!; const args = abi.decodeFunctionData(f, data);
    this.reads.push({ method: f.name, blockTag });
    if (f.name === this.failMethod || (this.legacy && (f.name.endsWith('_VERSION')
      || ['isMarkIssuerUsable', 'markIssuerKeyEpoch'].includes(f.name)))) throw new Error('synthetic RPC failure');
    const versions: Record<string, number> = { ROSTER_FORMAT_VERSION: 2, EPOCH_SCHEMA_VERSION: 2, ROSTER_AUTH_VERSION: 1, ISSUER_KEY_PROVENANCE_VERSION: 1,
      ROSTER_WITNESS_VERSION: 1, ATTRS_SCHEMA_VERSION: 0, POLICY_SCHEMA_VERSION: 2, TRANSACTION_PROCESSING_VERSION: 2 };
    let value: unknown[];
    if (f.name in versions) value = [versions[f.name]];
    else switch (f.name) {
      case 'ASC': value = [this.wrongBinding ? this.subject : this.asc]; break;
      case 'expectedChainKey': value = [1]; break;
      case 'sourceContract': value = [this.issuer]; break;
      case 'tombstone': value = [String(args[0]).toLowerCase() === this.subject && this.tombstone]; break;
      case 'getMark': value = [[1, 1, 1, 3, 2, 410, 0, this.now - 100, this.now + 2000, 0, ethers.id('claims'), ethers.id('evidence'), this.issuer]]; break;
      case 'isMarkIssuerUsable': value = [true]; break;
      case 'markIssuerKeyEpoch': value = [0]; break;
      case 'latestEpoch': value = [1]; break;
      case 'epochValidUntil': value = [this.now + 1000]; break;
      case 'isRosterFresh': value = [this.fresh]; break;
      case 'epochRoots': value = [ethers.id('root')]; break;
      case 'epochSourceCutoff': value = [this.now - 100]; break;
      case 'epochPublishedAt': value = [this.now - 90]; break;
      case 'epochSnapshotId': value = [ethers.id('snapshot')]; break;
      case 'epochIssuerApproved': value = [this.approved]; break;
      case 'isEpochIssuerUsable': value = [this.approved]; break;
      case 'policies': value = [1 << 16, 2, 3600, 1, 410, this.issuer, true, true]; break;
      case 'policyFrozen': value = [true]; break;
      case 'policyKind': value = [1]; break;
      case 'isVerified': value = [this.verified]; break;
      case 'getRosterWitness': value = [this.witnessEpoch, [packAttrs(this.attrs), ethers.id('claims'), ethers.id('evidence'), this.issuer]]; break;
      default: throw new Error('unsupported fixture call ' + f.name);
    }
    return abi.encodeFunctionResult(f, value);
  }
  provider(): ethers.Provider {
    return { getNetwork: async () => ethers.Network.from(this.chainId),
      getBlock: async (tag: unknown) => { this.blockReads.push(tag); return { number: 100, timestamp: this.now,
        hash: this.reorg && this.blockReads.length > 1 ? ethers.id('fork') : this.hash }; },
      getCode: async (_address: string, blockTag: unknown) => { this.reads.push({ method: 'getCode', blockTag }); return '0x' + ROSTER_SELECTORS.join(''); },
      call: async (tx: { to: string; data: string; blockTag: unknown }) => this.call(tx.to, tx.data, tx.blockTag),
    } as unknown as ethers.Provider;
  }
}
