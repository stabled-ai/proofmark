import { ethers } from 'ethers';
import { packAttrs } from './attrs.js';
import type { IssuanceTransport, IssuanceReceipt } from './issuance-delivery.js';
import type { IssuanceEntry, SignedIssuance, SourceConfirmation } from './issuance-journal.js';
import { ISSUER_KEY_ABI, encodeIssuerIssue } from './issuer-key.js';

export const ISSUANCE_SOURCE_ABI = [
  'function processedRequest(bytes32) view returns (bool)',
  'function isIssuer(address) view returns (bool)',
  'function issueOnce(bytes32 requestId,address subject,bytes32 attrs,bytes32 claimsRoot,bytes32 evidenceHash)',
  'event KeyedMarkIssued(address indexed subject,bytes32 indexed attrs,address indexed issuer,uint64 issuerKeyEpoch,bytes32 claimsRoot,bytes32 evidenceHash)',
  'event MarkIssued(address indexed subject,bytes32 indexed attrs,address indexed issuer,bytes32 claimsRoot,bytes32 evidenceHash)',
] as const;
export const ISSUANCE_ASC_ABI = [
  'function expectedChainKey() view returns (uint64)',
  'function sourceContract() view returns (address)',
  'function tombstone(address) view returns (bool)',
  'function lastAppliedHeight(address) view returns (uint64)',
  'function lastAppliedTxIndex(address) view returns (uint64)',
  'function markIssuerKeyEpoch(address) view returns (uint64)',
  'function isMarkIssuerUsable(address) view returns (bool)',
  'function getMark(address) view returns ((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))',
] as const;
const sourceInterface = new ethers.Interface(ISSUANCE_SOURCE_ABI);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function issuanceCalldata(entry: IssuanceEntry): string {
  if (entry.outcome.status !== 'ISSUED') throw new Error('issuance was not approved');
  return sourceInterface.encodeFunctionData('issueOnce', [entry.requestId, entry.wallet, entry.outcome.attrs, entry.outcome.claimsRoot, entry.outcome.evidenceHash]);
}
/** Bind stored signed bytes to every immutable issuance field, including zero transferred value. */
export function validateSignedIssuance(entry: IssuanceEntry, signed: SignedIssuance): void {
  const tx = ethers.Transaction.from(signed.raw);
  if (!tx.isSigned() || tx.hash !== signed.hash || tx.nonce !== signed.nonce || tx.chainId !== BigInt(entry.target.chainId)
    || !tx.to || !same(tx.to, entry.target.source) || !same(tx.from!, entry.target.issuer) || tx.value !== 0n
    || tx.data !== issuanceCalldata(entry) || (signed.gasLimit !== undefined && tx.gasLimit.toString() !== signed.gasLimit) || signed.chainId !== entry.target.chainId
    || !same(signed.source, entry.target.source) || !same(signed.issuer, entry.target.issuer)) throw new Error('signed transaction does not match immutable issuance');
}

export function issuanceProvider(url: string): ethers.JsonRpcProvider {
  // Public testnet RPCs can exceed five seconds while CC3 or Sepolia is under load. Issuance is
  // already journaled and resumable, so allow one bounded request enough time to finish instead
  // of persistently holding the signer gate after a premature transport timeout.
  const connection = new ethers.FetchRequest(url); connection.timeout = 15_000;
  return new ethers.JsonRpcProvider(connection, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
}

export class EvmIssuanceTransport implements IssuanceTransport {
  constructor(private readonly sourceProvider: ethers.Provider, private readonly hubProvider: ethers.Provider, private readonly signer: ethers.Wallet, private readonly confirmations = 6, private readonly allowedTarget?: IssuanceEntry['target']) {
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('invalid source confirmation count');
  }
  close(): void { this.sourceProvider.destroy(); this.hubProvider.destroy(); }
  async assertTarget(entry: IssuanceEntry): Promise<void> {
    if (entry.target.issuerMode && entry.target.issuerMode !== 'direct') throw new Error('direct transport cannot use a rotating issuer target');
    if (this.allowedTarget && (entry.target.chainId !== this.allowedTarget.chainId || entry.target.hubChainId !== this.allowedTarget.hubChainId
      || !same(entry.target.source, this.allowedTarget.source) || !same(entry.target.asc, this.allowedTarget.asc)
      || !same(entry.target.issuer, this.allowedTarget.issuer))) throw new Error('journal targets a different configured deployment');
    const [sourceNetwork, hubNetwork, sourceCode] = await Promise.all([
      this.sourceProvider.getNetwork(), this.hubProvider.getNetwork(), this.sourceProvider.getCode(entry.target.source),
    ]);
    // This release only supports the repository's Sepolia -> CC3 path. More chains need explicit
    // Attestcoin chain-key configuration, not an inferred equality with EVM chain IDs.
    if (entry.target.chainId !== 11155111 || entry.target.hubChainId !== 102031 || sourceNetwork.chainId !== BigInt(entry.target.chainId)
      || hubNetwork.chainId !== BigInt(entry.target.hubChainId) || sourceCode === '0x' || !same(this.signer.address, entry.target.issuer)) throw new Error('issuance deployment or signer mismatch');
    const asc = new ethers.Contract(entry.target.asc, ISSUANCE_ASC_ABI, this.hubProvider);
    const [source, chainKey] = await Promise.all([asc.sourceContract(), asc.expectedChainKey()]);
    if (!same(source, entry.target.source) || chainKey !== 1n) throw new Error('ASC source binding mismatch');
  }
  async processed(entry: IssuanceEntry): Promise<boolean> {
    return new ethers.Contract(entry.target.source, ISSUANCE_SOURCE_ABI, this.sourceProvider).processedRequest(entry.requestId);
  }
  async prepare(entry: IssuanceEntry): Promise<SignedIssuance> {
    const contract = new ethers.Contract(entry.target.source, ISSUANCE_SOURCE_ABI, this.sourceProvider);
    if (!await contract.isIssuer(entry.target.issuer)) throw new Error('signer is not an authorized issuer');
    // A persistent signer gate is held across this pending nonce read and the durable signed save.
    const request = await this.signer.populateTransaction({ to: entry.target.source, data: issuanceCalldata(entry), value: 0n });
    const raw = await this.signer.signTransaction(request);
    const result = { hash: ethers.keccak256(raw), raw, nonce: Number(request.nonce), chainId: entry.target.chainId, source: entry.target.source,
      issuer: entry.target.issuer, gasLimit: request.gasLimit!.toString() };
    validateSignedIssuance(entry, result);
    return result;
  }
  async broadcast(transaction: SignedIssuance): Promise<void> {
    const tx = await this.sourceProvider.broadcastTransaction(transaction.raw);
    if (tx.hash !== transaction.hash) throw new Error('broadcast returned a different hash');
  }
  async receipt(entry: IssuanceEntry): Promise<IssuanceReceipt> {
    const signed = entry.transaction!;
    validateSignedIssuance(entry, signed);
    const receipt = await this.sourceProvider.getTransactionReceipt(signed.hash);
    if (!receipt || await receipt.confirmations() < this.confirmations) return { status: 'pending' };
    const block = await this.sourceProvider.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash) return { status: 'pending' };
    if (!same(receipt.from, entry.target.issuer) || !receipt.to || !same(receipt.to, entry.target.source) || receipt.hash !== signed.hash) throw new Error('source receipt binding mismatch');
    const confirmation = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionIndex: receipt.index,
      confirmedAt: Date.now(), gasUsed: receipt.gasUsed.toString() };
    if (receipt.status !== 1) return { status: 'reverted', confirmation };
    const matches = receipt.logs.filter(log => {
      if (!same(log.address, entry.target.source)) return false;
      try {
        const decoded = sourceInterface.parseLog(log);
        return decoded?.name === 'MarkIssued' && entry.outcome.status === 'ISSUED'
          && same(decoded.args.subject, entry.wallet) && same(decoded.args.issuer, entry.target.issuer)
          && same(decoded.args.attrs, entry.outcome.attrs) && same(decoded.args.claimsRoot, entry.outcome.claimsRoot)
          && same(decoded.args.evidenceHash, entry.outcome.evidenceHash);
      } catch { return false; }
    });
    if (matches.length !== 1 || !await this.processed(entry)) throw new Error('source issuance event or request consumption missing');
    return { status: 'success', confirmation };
  }
  async materialized(entry: IssuanceEntry, confirmation: SourceConfirmation): Promise<boolean> {
    if (entry.outcome.status !== 'ISSUED') return false;
    const asc = new ethers.Contract(entry.target.asc, ISSUANCE_ASC_ABI, this.hubProvider);
    const blockTag = await this.hubProvider.getBlockNumber();
    const [mark, tombstone, height, index] = await Promise.all([
      asc.getMark(entry.wallet, { blockTag }), asc.tombstone(entry.wallet, { blockTag }),
      asc.lastAppliedHeight(entry.wallet, { blockTag }), asc.lastAppliedTxIndex(entry.wallet, { blockTag }),
    ]);
    if (tombstone || Number(mark[0]) !== 1 || Number(mark[1]) !== 1 || Number(height) !== confirmation.blockNumber || Number(index) !== confirmation.transactionIndex) return false;
    const attrs = packAttrs({ kind: Number(mark[2]), assurance: Number(mark[3]), regime: Number(mark[4]), jurisdiction: Number(mark[5]),
      methods: Number(mark[6]), issuedAt: Number(mark[7]), expiry: Number(mark[8]), epoch: Number(mark[9]) });
    return same(attrs, entry.outcome.attrs) && same(mark[10], entry.outcome.claimsRoot)
      && same(mark[11], entry.outcome.evidenceHash) && same(mark[12], entry.target.issuer);
  }
}

const checkedRotatingTarget = (entry: IssuanceEntry) => {
  const t = entry.target;
  if (t.issuerMode !== 'rotating' || !ethers.isAddress(t.operatingKey) || t.operatingKey === ethers.ZeroAddress
    || !Number.isSafeInteger(t.issuerKeyEpoch) || t.issuerKeyEpoch! < 1) throw new Error('invalid rotating issuer journal target');
  return { ...t, operatingKey: ethers.getAddress(t.operatingKey!), issuerKeyEpoch: t.issuerKeyEpoch! };
};

export function validateRotatingSignedIssuance(entry: IssuanceEntry, signed: SignedIssuance): void {
  const target = checkedRotatingTarget(entry);
  if (entry.outcome.status !== 'ISSUED') throw new Error('issuance was not approved');
  const tx = ethers.Transaction.from(signed.raw);
  const data = encodeIssuerIssue(BigInt(target.issuerKeyEpoch), entry.requestId, entry.wallet, entry.outcome.attrs,
    entry.outcome.claimsRoot, entry.outcome.evidenceHash);
  if (!tx.isSigned() || tx.hash !== signed.hash || tx.nonce !== signed.nonce || tx.chainId !== BigInt(target.chainId)
    || !tx.to || !same(tx.to, target.issuer) || !same(tx.from!, target.operatingKey) || tx.value !== 0n
    || tx.data !== data || (signed.gasLimit !== undefined && tx.gasLimit.toString() !== signed.gasLimit) || signed.chainId !== target.chainId || !same(signed.source, target.source)
    || !same(signed.issuer, target.issuer)) throw new Error('signed transaction does not match immutable rotating issuance');
}

/** Journaled transport for a stable issuer contract. The stored target pins both the stable
 * principal and the exact public operator generation; rotation makes unsigned work fail closed. */
export class RotatingIssuerEvmTransport implements IssuanceTransport {
  constructor(private readonly sourceProvider: ethers.Provider, private readonly hubProvider: ethers.Provider,
    private readonly signer: ethers.Wallet, private readonly confirmations = 6,
    private readonly allowedTarget?: IssuanceEntry['target']) {
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('invalid source confirmation count');
  }
  close(): void { this.sourceProvider.destroy(); this.hubProvider.destroy(); }
  async assertTarget(entry: IssuanceEntry): Promise<void> {
    const t = checkedRotatingTarget(entry);
    if (this.allowedTarget) {
      const allowed = checkedRotatingTarget({ ...entry, target: this.allowedTarget });
      if (t.chainId !== allowed.chainId || t.hubChainId !== allowed.hubChainId
        || !same(t.source, allowed.source) || !same(t.asc, allowed.asc) || !same(t.issuer, allowed.issuer)
        || !same(t.operatingKey, allowed.operatingKey) || t.issuerKeyEpoch !== allowed.issuerKeyEpoch) {
        throw new Error('journal targets a different configured deployment');
      }
    }
    const [sourceNetwork, hubNetwork, sourceCode, issuerCode] = await Promise.all([
      this.sourceProvider.getNetwork(), this.hubProvider.getNetwork(), this.sourceProvider.getCode(t.source),
      this.sourceProvider.getCode(t.issuer),
    ]);
    if (t.chainId !== 11155111 || t.hubChainId !== 102031 || sourceNetwork.chainId !== BigInt(t.chainId)
      || hubNetwork.chainId !== BigInt(t.hubChainId) || sourceCode === '0x' || issuerCode === '0x'
      || !same(this.signer.address, t.operatingKey)) throw new Error('issuance deployment or signer mismatch');
    const asc = new ethers.Contract(t.asc, ISSUANCE_ASC_ABI, this.hubProvider);
    const source = new ethers.Contract(t.source, ISSUANCE_SOURCE_ABI, this.sourceProvider);
    const stable = new ethers.Contract(t.issuer, ISSUER_KEY_ABI, this.sourceProvider);
    const [boundSource, chainKey, stableSource, currentKey, epoch, suspended, stableRole, directRole] = await Promise.all([
      asc.sourceContract(), asc.expectedChainKey(), stable.SOURCE(), stable.operatingKey(), stable.keyEpoch(), stable.suspended(),
      source.isIssuer(t.issuer), source.isIssuer(t.operatingKey),
    ]);
    if (!same(boundSource, t.source) || chainKey !== 1n || !same(stableSource, t.source)
      || !same(currentKey, t.operatingKey) || epoch !== BigInt(t.issuerKeyEpoch) || suspended || !stableRole || directRole) {
      throw new Error('rotating issuer binding, epoch or role mismatch');
    }
  }
  async processed(entry: IssuanceEntry): Promise<boolean> {
    return new ethers.Contract(entry.target.source, ISSUANCE_SOURCE_ABI, this.sourceProvider).processedRequest(entry.requestId);
  }
  async prepare(entry: IssuanceEntry): Promise<SignedIssuance> {
    await this.assertTarget(entry);
    const t = checkedRotatingTarget(entry);
    if (entry.outcome.status !== 'ISSUED') throw new Error('issuance was not approved');
    const data = encodeIssuerIssue(BigInt(t.issuerKeyEpoch), entry.requestId, entry.wallet, entry.outcome.attrs,
      entry.outcome.claimsRoot, entry.outcome.evidenceHash);
    const request = await this.signer.populateTransaction({ to: t.issuer, data, value: 0n });
    const raw = await this.signer.signTransaction(request);
    const result = { hash: ethers.keccak256(raw), raw, nonce: Number(request.nonce), chainId: t.chainId,
      source: t.source, issuer: t.issuer, gasLimit: request.gasLimit!.toString() };
    validateRotatingSignedIssuance(entry, result);
    return result;
  }
  async broadcast(transaction: SignedIssuance): Promise<void> {
    const tx = await this.sourceProvider.broadcastTransaction(transaction.raw);
    if (tx.hash !== transaction.hash) throw new Error('broadcast returned a different hash');
  }
  async receipt(entry: IssuanceEntry): Promise<IssuanceReceipt> {
    const t = checkedRotatingTarget(entry); const signed = entry.transaction!;
    validateRotatingSignedIssuance(entry, signed);
    const receipt = await this.sourceProvider.getTransactionReceipt(signed.hash);
    if (!receipt || await receipt.confirmations() < this.confirmations) return { status: 'pending' };
    const block = await this.sourceProvider.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash) return { status: 'pending' };
    if (!same(receipt.from, t.operatingKey) || !receipt.to || !same(receipt.to, t.issuer) || receipt.hash !== signed.hash) {
      throw new Error('rotating source receipt binding mismatch');
    }
    const confirmation = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      transactionIndex: receipt.index, confirmedAt: Date.now(), gasUsed: receipt.gasUsed.toString() };
    if (receipt.status !== 1) return { status: 'reverted', confirmation };
    const matches = receipt.logs.filter(log => {
      if (!same(log.address, t.source)) return false;
      try {
        const decoded = sourceInterface.parseLog(log);
        return decoded?.name === 'KeyedMarkIssued' && entry.outcome.status === 'ISSUED'
          && same(decoded.args.subject, entry.wallet) && same(decoded.args.issuer, t.issuer)
          && Number(decoded.args.issuerKeyEpoch) === t.issuerKeyEpoch && same(decoded.args.attrs, entry.outcome.attrs)
          && same(decoded.args.claimsRoot, entry.outcome.claimsRoot) && same(decoded.args.evidenceHash, entry.outcome.evidenceHash);
      } catch { return false; }
    });
    if (matches.length !== 1 || !await this.processed(entry)) throw new Error('keyed source issuance event or request consumption missing');
    return { status: 'success', confirmation };
  }
  async materialized(entry: IssuanceEntry, confirmation: SourceConfirmation): Promise<boolean> {
    if (entry.outcome.status !== 'ISSUED') return false;
    const t = checkedRotatingTarget(entry); const asc = new ethers.Contract(t.asc, ISSUANCE_ASC_ABI, this.hubProvider);
    const blockTag = await this.hubProvider.getBlockNumber();
    const [mark, tombstone, height, index, keyEpoch, usable] = await Promise.all([
      asc.getMark(entry.wallet, { blockTag }), asc.tombstone(entry.wallet, { blockTag }),
      asc.lastAppliedHeight(entry.wallet, { blockTag }), asc.lastAppliedTxIndex(entry.wallet, { blockTag }),
      asc.markIssuerKeyEpoch(entry.wallet, { blockTag }), asc.isMarkIssuerUsable(entry.wallet, { blockTag }),
    ]);
    if (tombstone || !usable || Number(keyEpoch) !== t.issuerKeyEpoch || Number(mark[0]) !== 1 || Number(mark[1]) !== 1
      || Number(height) !== confirmation.blockNumber || Number(index) !== confirmation.transactionIndex) return false;
    const attrs = packAttrs({ kind: Number(mark[2]), assurance: Number(mark[3]), regime: Number(mark[4]), jurisdiction: Number(mark[5]),
      methods: Number(mark[6]), issuedAt: Number(mark[7]), expiry: Number(mark[8]), epoch: Number(mark[9]) });
    return same(attrs, entry.outcome.attrs) && same(mark[10], entry.outcome.claimsRoot)
      && same(mark[11], entry.outcome.evidenceHash) && same(mark[12], t.issuer);
  }
}
