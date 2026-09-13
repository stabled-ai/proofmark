import { ethers } from 'ethers';
import { buildRoster, type RosterEntry } from './roster.js';
import { validCredentialAttrs } from './attrs.js';

export const ROSTER_LIFECYCLE_ABI = [
  'event MarkIssued(address indexed subject,bytes32 indexed attrs,address indexed issuer,bytes32 claimsRoot,bytes32 evidenceHash)',
  'event KeyedMarkIssued(address indexed subject,bytes32 indexed attrs,address indexed issuer,uint64 issuerKeyEpoch,bytes32 claimsRoot,bytes32 evidenceHash)',
  'event MarkRevoked(address indexed subject,uint16 indexed reasonCode,uint32 indexed epoch)',
  'event SanctionDenied(address indexed subject,uint32 indexed listVersion,uint32 indexed epoch)',
  'event SanctionDenialCorrected(address indexed subject,uint64 indexed denialRevision,uint256 indexed correctionId,bytes32 reasonHash,address proposer,address approver)',
  'event IssuerKeyCompromised(address indexed issuer,uint64 indexed issuerKeyEpoch,uint64 lastTrustedBlock,bytes32 reasonHash)',
] as const;
const iface = new ethers.Interface(ROSTER_LIFECYCLE_ABI);
const watched = new Set(iface.fragments.map(f => iface.getEvent((f as ethers.EventFragment).name)!.topicHash));
const hash = (value: unknown) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(value)));
const isHash = (value: unknown): value is string => typeof value === 'string' && ethers.isHexString(value, 32);
const integer = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min;

export interface SnapshotBlock {
  number: number; hash: string | null; parentHash: string; timestamp: number; transactions: readonly string[];
  receiptsRoot: string | null;
}
export interface SnapshotLog {
  address: string; blockNumber: number; blockHash: string; transactionHash: string;
  transactionIndex: number; index: number; topics: readonly string[]; data: string; removed?: boolean;
}
export interface SnapshotReceipt {
  hash: string; blockNumber: number; blockHash: string; index: number; status: number | null;
  contractAddress: string | null; logs: readonly SnapshotLog[]; cumulativeGasUsed: bigint;
  logsBloom: string; type: number; root?: string | null;
}
export interface SnapshotHeaderReader {
  getNetwork(): Promise<{ chainId: bigint }>;
  getBlockNumber(): Promise<number>;
  getBlock(tag: number | 'finalized'): Promise<SnapshotBlock | null>;
}
export interface SnapshotReader {
  getNetwork(): Promise<{ chainId: bigint }>;
  getBlockNumber(): Promise<number>;
  getBlock(tag: number | 'finalized'): Promise<SnapshotBlock | null>;
  getTransactionReceipt(hash: string): Promise<SnapshotReceipt | null>;
  getBlockReceipts?(height: number): Promise<readonly SnapshotReceipt[]>;
  getLogs(filter: { address: string; fromBlock: number; toBlock: number }): Promise<SnapshotLog[]>;
}
export interface SourceSnapshotOptions {
  source: string; chainId: bigint; deploymentTx: string; confirmations: number;
  headerReader: SnapshotHeaderReader;
  checkpoint?: SourceReplayCheckpoint;
  checkpointSink?: (checkpoint: SourceReplayCheckpoint) => void;
  cutoffBlock?: number; expectedCutoffHash?: string; maxBlocks?: number; maxReceipts?: number; logChunk?: number;
  receiptConcurrency?: number; receiptRetries?: number;
}
interface LifecycleState { denied: boolean; revoked: boolean; entry?: RosterEntry; issuerKeyEpoch?: number; issueBlock?: number }
export interface SourceReplayCheckpoint {
  version: 1; chainId: string; source: string; deploymentTx: string; deploymentBlock: number;
  blockNumber: number; blockHash: string; blockTimestamp: number; receiptsRoot: string;
  receipts: number; sourceLogs: number; headersDigest: string; blocksDigest: string; logsDigest: string;
  states: [string, LifecycleState][]; compromiseCutoffs: [string, number][];
}
export interface SourceSnapshotManifest {
  version: 2; method: 'receipt-trie-verified-independent-headers-and-getLogs';
  trust: 'independent-finalized-header-rpc-plus-cryptographic-receipts-root';
  chainId: string; source: string; deploymentTx: string; deploymentBlock: number; deploymentBlockHash: string;
  cutoffBlock: number; cutoffBlockHash: string; cutoffTimestamp: number;
  confirmations: number; blocks: number; receipts: number; sourceLogs: number;
  headersDigest: string; blocksDigest: string; logsDigest: string; entriesDigest: string; root: string;
}
export interface SourceRosterSnapshot {
  tree: ReturnType<typeof buildRoster>; excluded: { subject: string; reason: string }[];
  manifest: SourceSnapshotManifest;
}

/** Exact deterministic audit inputs, not a signature over this off-chain metadata. */
export function assertSourceSnapshot(expected: unknown, actual: SourceSnapshotManifest): void {
  if (!expected || typeof expected !== 'object' || Object.entries(actual).some(([key, value]) =>
    (expected as Record<string, unknown>)[key] !== value)) throw new Error('source snapshot manifest drift; rebuild and review the plan');
}

function checkedBlock(value: SnapshotBlock | null, height?: number): SnapshotBlock & { hash: string } {
  if (!value || !integer(value.number) || (height !== undefined && value.number !== height) || !isHash(value.hash) ||
      !isHash(value.parentHash) || !isHash(value.receiptsRoot) || !integer(value.timestamp, 1) || !Array.isArray(value.transactions) ||
      value.transactions.some(tx => !isHash(tx)) || new Set(value.transactions).size !== value.transactions.length) throw new Error('invalid source snapshot block');
  return value as SnapshotBlock & { hash: string };
}

type RlpNode = string | RlpNode[];
const EMPTY_TRIE_ROOT = ethers.keccak256(ethers.encodeRlp('0x'));
const minimalInteger = (value: bigint | number): string => {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  if (n < 0n) throw new Error('negative receipt integer');
  return n === 0n ? '0x' : ethers.stripZerosLeft(ethers.toBeHex(n));
};
const nibbles = (value: string): number[] => [...ethers.getBytes(value)].flatMap(byte => [byte >> 4, byte & 15]);
const compactPath = (path: number[], leaf: boolean): string => {
  const odd = path.length % 2 === 1;
  const packed = odd ? [(leaf ? 3 : 1), ...path] : [(leaf ? 2 : 0), 0, ...path];
  return ethers.hexlify(Uint8Array.from({ length: packed.length / 2 }, (_, i) => (packed[i * 2] << 4) | packed[i * 2 + 1]));
};
const nodeRef = (node: RlpNode[]): RlpNode => {
  const encoded = ethers.encodeRlp(node);
  return ethers.dataLength(encoded) < 32 ? node : ethers.keccak256(encoded);
};
function trieNode(items: { key: number[]; value: string }[]): RlpNode[] {
  if (items.length === 1) return [compactPath(items[0].key, true), items[0].value];
  let common = 0;
  while (items.every(item => item.key.length > common && item.key[common] === items[0].key[common])) common++;
  if (common) return [compactPath(items[0].key.slice(0, common), false), nodeRef(trieNode(items.map(item => ({ key: item.key.slice(common), value: item.value }))))];
  const branch: RlpNode[] = Array.from({ length: 17 }, () => '0x');
  for (let nibble = 0; nibble < 16; nibble++) {
    const group = items.filter(item => item.key[0] === nibble).map(item => ({ key: item.key.slice(1), value: item.value }));
    if (group.length) branch[nibble] = nodeRef(trieNode(group));
  }
  const terminal = items.find(item => item.key.length === 0);
  if (terminal) branch[16] = terminal.value;
  return branch;
}
function encodedReceipt(receipt: SnapshotReceipt, logs: ReturnType<typeof normalizedLog>[]): string {
  if (!integer(receipt.type) || receipt.type > 0x7f || typeof receipt.cumulativeGasUsed !== 'bigint' || receipt.cumulativeGasUsed < 0n ||
      !ethers.isHexString(receipt.logsBloom, 256) || ![0, 1].includes(receipt.status ?? -1) || receipt.root != null) {
    throw new Error('receipt fields unavailable for cryptographic receipt root verification');
  }
  const payload = ethers.encodeRlp([
    minimalInteger(receipt.status!), minimalInteger(receipt.cumulativeGasUsed), receipt.logsBloom,
    logs.map(log => [log.address, [...log.topics], log.data]),
  ]);
  return receipt.type === 0 ? payload : ethers.concat([ethers.toBeHex(receipt.type, 1), payload]);
}
export function computeReceiptsRoot(receipts: { index: number; receipt: SnapshotReceipt; logs: ReturnType<typeof normalizedLog>[] }[]): string {
  if (!receipts.length) return EMPTY_TRIE_ROOT;
  const items = receipts.map(({ index, receipt, logs }) => ({
    key: nibbles(ethers.encodeRlp(minimalInteger(index))), value: encodedReceipt(receipt, logs),
  }));
  return ethers.keccak256(ethers.encodeRlp(trieNode(items)));
}

function assertMatchingHeader(primary: SnapshotBlock & { hash: string }, header: SnapshotBlock & { hash: string }): void {
  if (primary.number !== header.number || primary.hash.toLowerCase() !== header.hash.toLowerCase() ||
      primary.parentHash.toLowerCase() !== header.parentHash.toLowerCase() || primary.timestamp !== header.timestamp ||
      primary.receiptsRoot!.toLowerCase() !== header.receiptsRoot!.toLowerCase() ||
      JSON.stringify(primary.transactions.map(tx => tx.toLowerCase())) !== JSON.stringify(header.transactions.map(tx => tx.toLowerCase()))) {
    throw new Error('independent source header/block body disagrees with roster RPC');
  }
}

function checkedCheckpoint(value: SourceReplayCheckpoint, options: SourceSnapshotOptions, source: string,
  deploymentBlock: number, cutoffHeight: number): SourceReplayCheckpoint {
  const stateOk = (pair: [string, LifecycleState]) => {
    if (!Array.isArray(pair) || pair.length !== 2 || !ethers.isAddress(pair[0]) || !pair[1] ||
        typeof pair[1].denied !== 'boolean' || typeof pair[1].revoked !== 'boolean') return false;
    const state = pair[1], entry = state.entry;
    if (entry && (!ethers.isAddress(entry.subject) || ethers.getAddress(entry.subject) !== ethers.getAddress(pair[0]) ||
      !ethers.isAddress(entry.issuer) || !isHash(entry.attrs) || !isHash(entry.claimsRoot) || !isHash(entry.evidenceHash))) return false;
    return (state.issuerKeyEpoch === undefined || integer(state.issuerKeyEpoch)) &&
      (state.issueBlock === undefined || integer(state.issueBlock, deploymentBlock));
  };
  if (!value || value.version !== 1 || value.chainId !== options.chainId.toString() || value.source !== source ||
      value.deploymentTx !== options.deploymentTx.toLowerCase() || value.deploymentBlock !== deploymentBlock ||
      !integer(value.blockNumber, deploymentBlock) || value.blockNumber > cutoffHeight || !isHash(value.blockHash) ||
      !integer(value.blockTimestamp, 1) || !isHash(value.receiptsRoot) || !integer(value.receipts) || !integer(value.sourceLogs) ||
      !isHash(value.headersDigest) || !isHash(value.blocksDigest) || !isHash(value.logsDigest) || !Array.isArray(value.states) ||
      value.states.some(pair => !stateOk(pair)) || new Set(value.states.map(([subject]) => subject.toLowerCase())).size !== value.states.length ||
      !Array.isArray(value.compromiseCutoffs) || value.compromiseCutoffs.some(pair => !Array.isArray(pair) || pair.length !== 2 ||
        !/^0x[0-9a-f]{40}\|[1-9][0-9]*$/.test(pair[0]) || !integer(pair[1])) ||
      new Set(value.compromiseCutoffs.map(([key]) => key)).size !== value.compromiseCutoffs.length) {
    throw new Error('invalid or inapplicable authenticated source checkpoint');
  }
  return structuredClone(value);
}

function normalizedLog(log: SnapshotLog, fromReceipt = false) {
  if (!ethers.isAddress(log.address) || !isHash(log.blockHash) || !isHash(log.transactionHash) ||
      !integer(log.blockNumber) || !integer(log.transactionIndex) || !integer(log.index) ||
      (log.removed !== false && !(fromReceipt && log.removed === undefined)) ||
      !Array.isArray(log.topics) || log.topics.some(t => !isHash(t)) || !ethers.isHexString(log.data, true)) {
    throw new Error('invalid source snapshot log');
  }
  return { address: log.address.toLowerCase(), blockNumber: log.blockNumber, blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(), transactionIndex: log.transactionIndex, index: log.index,
    topics: log.topics.map(t => t.toLowerCase()), data: log.data.toLowerCase() };
}

/** Full cold replay from independently observed finalized headers with per-block receipt-trie verification. */
export async function buildSourceRoster(reader: SnapshotReader, options: SourceSnapshotOptions): Promise<SourceRosterSnapshot> {
  const source = ethers.getAddress(options.source);
  const maxBlocks = options.maxBlocks ?? 20_000, maxReceipts = options.maxReceipts ?? 200_000, chunk = options.logChunk ?? 100;
  const receiptConcurrency = options.receiptConcurrency ?? 6, receiptRetries = options.receiptRetries ?? 3;
  if (source === ethers.ZeroAddress || !isHash(options.deploymentTx) || typeof options.chainId !== 'bigint' || options.chainId <= 0n ||
      !integer(options.confirmations, 1) || !integer(maxBlocks, 1) || !integer(maxReceipts, 1) || !integer(chunk, 1) || chunk > 1000 ||
      !integer(receiptConcurrency, 1) || receiptConcurrency > 16 || !integer(receiptRetries, 1) || receiptRetries > 10 ||
      (options.expectedCutoffHash !== undefined && !isHash(options.expectedCutoffHash))) throw new Error('invalid source snapshot settings');
  if (!options.headerReader || options.headerReader === reader) throw new Error('independent source header reader required');
  const [network, head, finalValue, creation, headerNetwork, headerHead, headerFinalValue] = await Promise.all([
    reader.getNetwork(), reader.getBlockNumber(), reader.getBlock('finalized'), reader.getTransactionReceipt(options.deploymentTx),
    options.headerReader.getNetwork(), options.headerReader.getBlockNumber(), options.headerReader.getBlock('finalized'),
  ]);
  const finalized = checkedBlock(finalValue), headerFinalized = checkedBlock(headerFinalValue);
  if (network.chainId !== options.chainId || headerNetwork.chainId !== options.chainId || !integer(head) || !integer(headerHead) ||
      finalized.number > head || headerFinalized.number > headerHead) throw new Error('source chain/finality unavailable');
  const ceiling = Math.min(finalized.number, head - options.confirmations, headerFinalized.number, headerHead - options.confirmations);
  const cutoffHeight = options.cutoffBlock ?? ceiling;
  if (!integer(cutoffHeight, 1) || cutoffHeight > ceiling) throw new Error('source cutoff is not finalized and confirmed');
  // Current deployment script uses top-level CREATE; factory/CREATE2 needs separate attested deployment evidence.
  if (!creation || creation.status !== 1 || creation.hash.toLowerCase() !== options.deploymentTx.toLowerCase() ||
      creation.contractAddress?.toLowerCase() !== source.toLowerCase() || !integer(creation.blockNumber, 1) ||
      creation.blockNumber > cutoffHeight || !isHash(creation.blockHash)) throw new Error('verified source deployment receipt required');
  const [cutoffValue, headerCutoffValue] = await Promise.all([reader.getBlock(cutoffHeight), options.headerReader.getBlock(cutoffHeight)]);
  const cutoff = checkedBlock(cutoffValue, cutoffHeight), headerCutoff = checkedBlock(headerCutoffValue, cutoffHeight);
  assertMatchingHeader(cutoff, headerCutoff);
  if (options.expectedCutoffHash && cutoff.hash.toLowerCase() !== options.expectedCutoffHash.toLowerCase()) throw new Error('approved source cutoff hash changed');
  const checkpoint = options.checkpoint
    ? checkedCheckpoint(options.checkpoint, options, source, creation.blockNumber, cutoffHeight) : undefined;
  const anchorHeight = checkpoint?.blockNumber ?? creation.blockNumber - 1;
  const [anchorValue, headerAnchorValue] = await Promise.all([
    reader.getBlock(anchorHeight), options.headerReader.getBlock(anchorHeight),
  ]);
  const anchor = checkedBlock(anchorValue, anchorHeight), headerAnchor = checkedBlock(headerAnchorValue, anchorHeight);
  assertMatchingHeader(anchor, headerAnchor);
  if (checkpoint && (anchor.hash.toLowerCase() !== checkpoint.blockHash.toLowerCase() || anchor.timestamp !== checkpoint.blockTimestamp ||
      anchor.receiptsRoot!.toLowerCase() !== checkpoint.receiptsRoot.toLowerCase())) throw new Error('authenticated source checkpoint anchor changed');
  if (cutoffHeight - anchorHeight > maxBlocks) throw new Error('source snapshot exceeds scan block budget; no partial roster allowed');
  let parentHash = anchor.hash, previousTimestamp = anchor.timestamp;
  let headersDigest = checkpoint?.headersDigest ?? hash(['source-headers-v2', options.chainId.toString(), anchor.number, anchor.hash, anchor.receiptsRoot]);
  let blocksDigest = checkpoint?.blocksDigest ?? hash(['source-snapshot-v2', options.chainId.toString(), source, options.deploymentTx.toLowerCase(), anchor.hash]);
  let logsDigest = checkpoint?.logsDigest ?? hash(['source-logs-v2']);
  let receipts = checkpoint?.receipts ?? 0, sourceLogCount = checkpoint?.sourceLogs ?? 0, scannedReceipts = 0;
  const states = new Map<string, LifecycleState>(checkpoint?.states ?? []);
  const compromiseCutoffs = new Map<string, number>(checkpoint?.compromiseCutoffs ?? []);
  for (let from = anchorHeight + 1; from <= cutoffHeight; from += chunk) {
    const to = Math.min(from + chunk - 1, cutoffHeight);
    const receiptLogs: ReturnType<typeof normalizedLog>[] = [];
    for (let height = from; height <= to; height++) {
      const [blockValue, headerBlockValue] = await Promise.all([reader.getBlock(height), options.headerReader.getBlock(height)]);
      const block = checkedBlock(blockValue, height), headerBlock = checkedBlock(headerBlockValue, height);
      assertMatchingHeader(block, headerBlock);
      if (block.parentHash !== parentHash || block.timestamp < previousTimestamp || block.timestamp > cutoff.timestamp ||
          (height === creation.blockNumber && block.hash !== creation.blockHash) ||
          (height === cutoffHeight && block.hash !== cutoff.hash)) throw new Error('source snapshot block chain changed');
      let nextLogIndex = 0;
      const receiptDigests: string[] = [];
      const blockReceipts: { index: number; receipt: SnapshotReceipt; logs: ReturnType<typeof normalizedLog>[] }[] = [];
      if (scannedReceipts + block.transactions.length > maxReceipts) {
        throw new Error('source snapshot exceeds receipt budget; no partial roster allowed');
      }
      scannedReceipts += block.transactions.length;
      receipts += block.transactions.length;
      let fetchedReceipts: (SnapshotReceipt | null)[] = [];
      if (reader.getBlockReceipts) {
        let last: unknown;
        for (let attempt = 1; attempt <= receiptRetries; attempt++) {
          try {
            fetchedReceipts = [...await reader.getBlockReceipts(height)];
            last = undefined;
            break;
          } catch (error) {
            last = error;
          }
          if (attempt < receiptRetries) await new Promise(resolve => setTimeout(resolve, attempt * 200));
        }
        if (last) throw last;
      } else for (let offset = 0; offset < block.transactions.length; offset += receiptConcurrency) {
        const hashes = block.transactions.slice(offset, offset + receiptConcurrency);
        fetchedReceipts.push(...await Promise.all(hashes.map(async txHash => {
          let last: unknown;
          for (let attempt = 1; attempt <= receiptRetries; attempt++) {
            try {
              const receipt = await reader.getTransactionReceipt(txHash);
              if (receipt) return receipt;
              last = new Error('missing source transaction receipt');
            } catch (error) {
              last = error;
            }
            if (attempt < receiptRetries) await new Promise(resolve => setTimeout(resolve, attempt * 200));
          }
          if (last instanceof Error && last.message !== 'missing source transaction receipt') throw last;
          return null;
        })));
      }
      for (const [transactionIndex, txHash] of block.transactions.entries()) {
        const receipt = fetchedReceipts[transactionIndex];
        if (!receipt || receipt.hash.toLowerCase() !== txHash.toLowerCase() || receipt.index !== transactionIndex ||
            receipt.blockNumber !== height || receipt.blockHash !== block.hash || ![0, 1].includes(receipt.status ?? -1) ||
            !Array.isArray(receipt.logs) || (receipt.status === 0 && receipt.logs.length !== 0)) throw new Error('missing/inconsistent source transaction receipt');
        // ethers' receipt formatter omits removed; canonical receipt/block coordinates are checked below.
        // getLogs still must explicitly be non-removed, and removed=true is never accepted.
        const logs = receipt.logs.map(log => normalizedLog(log, true));
        blockReceipts.push({ index: transactionIndex, receipt, logs });
        for (const log of logs) {
          if (log.blockNumber !== height || log.blockHash !== block.hash.toLowerCase() || log.transactionHash !== txHash.toLowerCase() ||
              log.transactionIndex !== transactionIndex || log.index !== nextLogIndex++) throw new Error('source receipt log coordinates/gap inconsistent');
          if (log.address !== source.toLowerCase()) continue;
          receiptLogs.push(log);
          sourceLogCount++;
          logsDigest = hash([logsDigest, log]);
          if (!watched.has(log.topics[0])) continue;
          const event = iface.parseLog(log);
          if (!event) throw new Error('invalid source lifecycle log');
          const canonical = iface.encodeEventLog(event.fragment, event.args);
          if (canonical.data.toLowerCase() !== log.data || JSON.stringify(canonical.topics.map(t => t.toLowerCase())) !== JSON.stringify(log.topics)) throw new Error('noncanonical source lifecycle log');
          if (event.name === 'IssuerKeyCompromised') {
            const issuer = ethers.getAddress(event.args.issuer); const epoch = Number(event.args.issuerKeyEpoch);
            const lastTrustedBlock = Number(event.args.lastTrustedBlock);
            if (issuer === ethers.ZeroAddress || !integer(epoch, 1) || !integer(lastTrustedBlock) || lastTrustedBlock >= height
              || !isHash(event.args.reasonHash) || event.args.reasonHash === ethers.ZeroHash) throw new Error('invalid issuer compromise provenance');
            const key = `${issuer.toLowerCase()}|${epoch}`; const previous = compromiseCutoffs.get(key);
            compromiseCutoffs.set(key, previous === undefined ? lastTrustedBlock : Math.min(previous, lastTrustedBlock));
            continue;
          }
          const subject = ethers.getAddress(event.args.subject);
          if (subject === ethers.ZeroAddress) throw new Error('zero source lifecycle subject');
          const state = states.get(subject) ?? { denied: false, revoked: false };
          if (event.name === 'SanctionDenied') state.denied = true;
          else if (event.name === 'SanctionDenialCorrected') {
            if (
              !integer(Number(event.args.denialRevision), 1) || event.args.correctionId === 0n
              || !isHash(event.args.reasonHash) || event.args.reasonHash === ethers.ZeroHash
              || !ethers.isAddress(event.args.proposer) || !ethers.isAddress(event.args.approver)
              || event.args.proposer === ethers.ZeroAddress || event.args.approver === ethers.ZeroAddress
              || event.args.proposer.toLowerCase() === event.args.approver.toLowerCase()
            ) throw new Error('invalid denial correction provenance');
            state.denied = false;
            state.revoked = true;
            state.entry = undefined;
            state.issuerKeyEpoch = undefined;
            state.issueBlock = undefined;
          }
          else if (event.name === 'MarkRevoked') state.revoked = true;
          else {
            if (!validCredentialAttrs(event.args.attrs, block.timestamp) || event.args.issuer === ethers.ZeroAddress) throw new Error('invalid source issuance attributes/issuer');
            state.entry = { subject, attrs: event.args.attrs.toLowerCase(), claimsRoot: event.args.claimsRoot.toLowerCase(),
              evidenceHash: event.args.evidenceHash.toLowerCase(), issuer: ethers.getAddress(event.args.issuer) };
            state.issuerKeyEpoch = event.name === 'KeyedMarkIssued' ? Number(event.args.issuerKeyEpoch) : 0;
            if (!integer(state.issuerKeyEpoch, event.name === 'KeyedMarkIssued' ? 1 : 0)) throw new Error('invalid issuance key epoch');
            state.issueBlock = height;
            state.revoked = false;
          }
          states.set(subject, state);
        }
        receiptDigests.push(hash([txHash.toLowerCase(), receipt.status, logs]));
      }
      if (computeReceiptsRoot(blockReceipts).toLowerCase() !== block.receiptsRoot!.toLowerCase()) {
        throw new Error('source block receipt root mismatch; omitted or altered transaction receipt');
      }
      if (height === creation.blockNumber && block.transactions[creation.index]?.toLowerCase() !== options.deploymentTx.toLowerCase()) throw new Error('deployment transaction missing from source block');
      headersDigest = hash([headersDigest, height, block.hash, block.parentHash, block.timestamp, block.receiptsRoot]);
      blocksDigest = hash([blocksDigest, height, block.hash, block.parentHash, block.timestamp, block.receiptsRoot, receiptDigests]);
      parentHash = block.hash; previousTimestamp = block.timestamp;
    }
    const indexed = (await reader.getLogs({ address: source, fromBlock: from, toBlock: to })).map(log => normalizedLog(log))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    if (JSON.stringify(indexed) !== JSON.stringify(receiptLogs)) throw new Error('source getLogs/receipts disagree; missing/duplicate/foreign logs prohibit publication');
  }
  const [endAgain, anchorAgain, finalAgain, headAgain, headerEndAgain, headerAnchorAgain, headerFinalAgain, headerHeadAgain] = await Promise.all([
    reader.getBlock(cutoffHeight), reader.getBlock(anchor.number), reader.getBlock('finalized'), reader.getBlockNumber(),
    options.headerReader.getBlock(cutoffHeight), options.headerReader.getBlock(anchor.number), options.headerReader.getBlock('finalized'), options.headerReader.getBlockNumber(),
  ]);
  const checkedEndAgain = checkedBlock(endAgain, cutoffHeight), checkedAnchorAgain = checkedBlock(anchorAgain, anchor.number);
  const checkedHeaderEndAgain = checkedBlock(headerEndAgain, cutoffHeight), checkedHeaderAnchorAgain = checkedBlock(headerAnchorAgain, anchor.number);
  assertMatchingHeader(checkedEndAgain, checkedHeaderEndAgain); assertMatchingHeader(checkedAnchorAgain, checkedHeaderAnchorAgain);
  if (checkedEndAgain.hash !== cutoff.hash || checkedAnchorAgain.hash !== anchor.hash ||
      checkedBlock(finalAgain).number < cutoffHeight || !integer(headAgain) || headAgain - options.confirmations < cutoffHeight ||
      finalAgain!.number > headAgain || checkedBlock(headerFinalAgain).number < cutoffHeight || !integer(headerHeadAgain) ||
      headerHeadAgain - options.confirmations < cutoffHeight || headerFinalAgain!.number > headerHeadAgain) throw new Error('source snapshot changed or finality regressed');
  const entries: RosterEntry[] = [], excluded: SourceRosterSnapshot['excluded'] = [];
  for (const [subject, state] of [...states.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const compromiseCutoff = state.entry && state.issuerKeyEpoch
      ? compromiseCutoffs.get(`${state.entry.issuer.toLowerCase()}|${state.issuerKeyEpoch}`) : undefined;
    const reason = state.denied ? 'permanent source denial at/before cutoff' : state.revoked ? 'latest ordinary source event is revoke' :
      !state.entry ? 'no issuance at/before cutoff' : compromiseCutoff !== undefined && state.issueBlock! > compromiseCutoff
        ? 'issuance is after approved issuer-key compromise cutoff'
        : !validCredentialAttrs(state.entry.attrs, cutoff.timestamp) ? 'credential expired at source cutoff' : null;
    if (reason) excluded.push({ subject, reason }); else entries.push(state.entry!);
  }
  const tree = buildRoster(entries);
  const manifest: SourceSnapshotManifest = { version: 2, method: 'receipt-trie-verified-independent-headers-and-getLogs',
    trust: 'independent-finalized-header-rpc-plus-cryptographic-receipts-root', chainId: options.chainId.toString(), source,
    deploymentTx: options.deploymentTx.toLowerCase(), deploymentBlock: creation.blockNumber, deploymentBlockHash: creation.blockHash,
    cutoffBlock: cutoffHeight, cutoffBlockHash: cutoff.hash, cutoffTimestamp: cutoff.timestamp, confirmations: options.confirmations,
    blocks: cutoffHeight - creation.blockNumber + 1, receipts, sourceLogs: sourceLogCount,
    headersDigest, blocksDigest, logsDigest, entriesDigest: hash(tree.entries), root: tree.root };
  const nextCheckpoint: SourceReplayCheckpoint = { version: 1, chainId: options.chainId.toString(), source,
    deploymentTx: options.deploymentTx.toLowerCase(), deploymentBlock: creation.blockNumber, blockNumber: cutoffHeight,
    blockHash: cutoff.hash, blockTimestamp: cutoff.timestamp, receiptsRoot: cutoff.receiptsRoot!, receipts, sourceLogs: sourceLogCount,
    headersDigest, blocksDigest, logsDigest, states: [...states.entries()].sort(([a], [b]) => a.localeCompare(b)),
    compromiseCutoffs: [...compromiseCutoffs.entries()].sort(([a], [b]) => a.localeCompare(b)) };
  options.checkpointSink?.(nextCheckpoint);
  return { tree, excluded, manifest };
}
