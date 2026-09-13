import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { buildSourceRoster, assertSourceSnapshot, computeReceiptsRoot, ROSTER_LIFECYCLE_ABI,
  type SnapshotBlock, type SnapshotHeaderReader, type SnapshotLog, type SnapshotReceipt, type SnapshotReader } from './roster-source.js';
import type { SourceReplayCheckpoint } from './roster-source.js';
import { packAttrs } from './attrs.js';

const source = '0x' + '11'.repeat(20), issuer = '0x' + '22'.repeat(20);
const alice = '0x' + '33'.repeat(20), bob = '0x' + '44'.repeat(20), carol = '0x' + '55'.repeat(20);
const now = 1_800_000_000;
const iface = new ethers.Interface(ROSTER_LIFECYCLE_ABI);
const attrs = (expiry = now + 1000) => packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410, methods: 1 << 16, issuedAt: now, expiry, epoch: 0 });

class Reader implements SnapshotReader {
  blocks = new Map<number, SnapshotBlock>(); receipts = new Map<string, SnapshotReceipt>();
  getBlockReceipts?: (height: number) => Promise<readonly SnapshotReceipt[]>;
  final = 9; head = 10; chainId = 11155111n; reads: number[] = [];
  constructor() {
    for (let i = 0; i <= 10; i++) this.blocks.set(i, { number: i, hash: ethers.id(`block-${i}`), parentHash: ethers.id(`block-${i - 1}`),
      timestamp: now + i, transactions: [], receiptsRoot: computeReceiptsRoot([]) });
    const deployment = this.tx(1, []); deployment.contractAddress = source;
  }
  get deploymentTx() { return this.blocks.get(1)!.transactions[0]; }
  tx(height: number, events: { name: string; args: unknown[]; address?: string }[]): SnapshotReceipt {
    const block = this.blocks.get(height)!;
    const index = block.transactions.length, hash = ethers.id(`tx-${height}-${index}`);
    const start = [...this.receipts.values()].filter(r => r.blockNumber === height).reduce((n, r) => n + r.logs.length, 0);
    (block.transactions as string[]).push(hash);
    const receipt: SnapshotReceipt = { hash, blockNumber: height, blockHash: block.hash!, index, status: 1, contractAddress: null,
      cumulativeGasUsed: BigInt(index + 1), logsBloom: '0x' + '00'.repeat(256), type: 2, root: null,
      logs: events.map((event, i) => ({ ...iface.encodeEventLog(iface.getEvent(event.name)!, event.args), address: event.address ?? source,
        blockNumber: height, blockHash: block.hash!, transactionHash: hash, transactionIndex: index, index: start + i, removed: false })) };
    this.receipts.set(hash, receipt);
    const all = [...this.receipts.values()].filter(value => value.blockNumber === height).sort((a, b) => a.index - b.index);
    block.receiptsRoot = computeReceiptsRoot(all.map(value => ({ index: value.index, receipt: value,
      logs: value.logs.map(log => ({ address: log.address.toLowerCase(), blockNumber: log.blockNumber, blockHash: log.blockHash.toLowerCase(),
        transactionHash: log.transactionHash.toLowerCase(), transactionIndex: log.transactionIndex, index: log.index,
        topics: log.topics.map(topic => topic.toLowerCase()), data: log.data.toLowerCase() })) })));
    return receipt;
  }
  async getNetwork() { return { chainId: this.chainId }; }
  async getBlockNumber() { return this.head; }
  async getBlock(tag: number | 'finalized') { const n = tag === 'finalized' ? this.final : tag; this.reads.push(n); return structuredClone(this.blocks.get(n) ?? null); }
  async getTransactionReceipt(tx: string) {
    const value = structuredClone(this.receipts.get(tx) ?? null);
    if (value) value.logs = value.logs.map(log => ({ ...log, removed: undefined })); // actual ethers receipt shape
    return value;
  }
  async getLogs(filter: { address: string; fromBlock: number; toBlock: number }) {
    return structuredClone([...this.receipts.values()].flatMap(r => [...r.logs]).filter(l => l.address.toLowerCase() === filter.address.toLowerCase() && l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock));
  }
  headerReader(): SnapshotHeaderReader {
    return {
      getNetwork: async () => ({ chainId: this.chainId }),
      getBlockNumber: async () => this.head,
      getBlock: async tag => structuredClone(this.blocks.get(tag === 'finalized' ? this.final : tag) ?? null),
    };
  }
}
const issue = (subject: string, a = attrs()) => ({ name: 'MarkIssued', args: [subject, a, issuer, ethers.id('claims'), ethers.id('evidence')] });
const keyedIssue = (subject: string, epoch = 1) => ({ name: 'KeyedMarkIssued', args: [subject, attrs(), issuer, epoch, ethers.id('claims'), ethers.id('evidence')] });
const revoke = (subject: string) => ({ name: 'MarkRevoked', args: [subject, 1, 1] });
const deny = (subject: string) => ({ name: 'SanctionDenied', args: [subject, 9, 1] });
const correct = (subject: string, revision = 1) => ({ name: 'SanctionDenialCorrected',
  args: [subject, revision, 1, ethers.id('synthetic correction case'), issuer, '0x' + '66'.repeat(20)] });
const options = (r: Reader) => ({ source, chainId: 11155111n, deploymentTx: r.deploymentTx, confirmations: 1, logChunk: 3,
  headerReader: r.headerReader() });

test('source replay excludes unrelayed revokes, deny-before-issue and never-issued restrictions without a hub discovery assumption', async () => {
  const r = new Reader();
  r.tx(2, [issue(alice), deny(bob), revoke(carol)]);
  r.tx(7, [revoke(alice), issue(bob)]);
  const s = await buildSourceRoster(r, options(r));
  assert.equal(s.tree.entries.length, 0);
  assert.equal(s.excluded.length, 3);
  assert.match(s.excluded.find(e => e.subject === alice)!.reason, /revoke/);
  assert.match(s.excluded.find(e => e.subject === bob)!.reason, /permanent/);
  for (let i = 1; i <= 9; i++) assert.ok(r.reads.includes(i), `empty block ${i} is not a stopping point`);
  assert.equal(s.manifest.cutoffBlock, 9);
  assert.equal(s.manifest.receipts, 3);
});

test('block receipt transport preserves the same receipt-root verification without per-transaction RPC reads', async () => {
  const r = new Reader();
  r.tx(2, [issue(alice)]); r.tx(7, [revoke(alice), issue(bob)]);
  const getReceipt = r.getTransactionReceipt.bind(r);
  let individualReads = 0, blockReads = 0;
  r.getTransactionReceipt = async tx => {
    individualReads++;
    return getReceipt(tx);
  };
  r.getBlockReceipts = async height => {
    blockReads++;
    return structuredClone([...r.receipts.values()].filter(receipt => receipt.blockNumber === height).sort((a, b) => a.index - b.index));
  };
  const snapshot = await buildSourceRoster(r, options(r));
  assert.deepEqual(snapshot.tree.entries.map(entry => entry.subject), [bob]);
  assert.equal(individualReads, 1, 'only the deployment receipt is read before the block sweep');
  assert.equal(blockReads, 9, 'every block, including empty blocks, supplies an exact receipt set');
  assert.equal(snapshot.manifest.receipts, 3);
});

test('same-block and mixed receipt lifecycle replay is deterministic at the original cutoff after later writes', async () => {
  const r = new Reader();
  r.tx(2, [issue(alice), revoke(alice), issue(alice), issue(bob), revoke(bob)]);
  r.tx(2, [issue(bob)]);
  r.tx(3, [issue(carol, attrs(now + 5))]);
  const first = await buildSourceRoster(r, { ...options(r), cutoffBlock: 7 });
  assert.deepEqual(new Set(first.tree.entries.map(e => e.subject)), new Set([alice, bob]));
  assert.match(first.excluded[0].reason, /expired/);
  r.tx(8, [deny(alice)]);
  const again = await buildSourceRoster(r, { ...options(r), cutoffBlock: 7, expectedCutoffHash: first.manifest.cutoffBlockHash });
  assert.deepEqual(again, first);
  assertSourceSnapshot(first.manifest, again.manifest);
  assert.throws(() => assertSourceSnapshot({ ...first.manifest, logsDigest: ethers.ZeroHash }, again.manifest), /drift/);
  assert.throws(() => assertSourceSnapshot(undefined, again.manifest), /drift/);
  const latest = await buildSourceRoster(r, options(r));
  assert.deepEqual(latest.tree.entries.map(e => e.subject), [bob]);
});

test('authenticated checkpoint resumes after its exact header and reproduces a cold replay manifest', async () => {
  const r = new Reader(); r.tx(2, [issue(alice)]); r.tx(4, [issue(bob)]);
  let checkpoint: SourceReplayCheckpoint | undefined;
  await buildSourceRoster(r, { ...options(r), cutoffBlock: 5, checkpointSink: value => { checkpoint = value; } });
  assert.ok(checkpoint);
  r.tx(7, [revoke(alice)]); r.tx(8, [issue(carol)]);
  r.reads = [];
  const resumed = await buildSourceRoster(r, { ...options(r), checkpoint, maxBlocks: 4, maxReceipts: 2 });
  assert.equal(r.reads.some(height => height > 0 && height < 5), false, 'verified history before checkpoint is not rescanned');
  await assert.rejects(buildSourceRoster(r, { ...options(r), maxBlocks: 4, maxReceipts: 2 }), /block budget/);
  const cold = await buildSourceRoster(r, options(r));
  assert.deepEqual(resumed, cold);
  await assert.rejects(buildSourceRoster(r, { ...options(r), checkpoint: { ...checkpoint, blockHash: ethers.ZeroHash } }), /checkpoint anchor changed/);
});

test('source replay retains pre-cutoff keyed marks and excludes post-cutoff compromised generation marks', async () => {
  const r = new Reader();
  r.tx(2, [keyedIssue(alice)]);
  r.tx(5, [keyedIssue(bob)]);
  r.tx(7, [{ name: 'IssuerKeyCompromised', args: [issuer, 1, 3, ethers.id('incident')] }]);
  const snapshot = await buildSourceRoster(r, options(r));
  assert.deepEqual(snapshot.tree.entries.map(entry => entry.subject), [alice]);
  assert.match(snapshot.excluded.find(entry => entry.subject === bob)!.reason, /compromise cutoff/);
});

test('source replay includes only the replacement credential emitted with a governed denial correction', async () => {
  const r = new Reader();
  r.tx(2, [issue(alice), deny(alice)]);
  r.tx(5, [correct(alice), issue(alice)]);
  const snapshot = await buildSourceRoster(r, options(r));
  assert.deepEqual(snapshot.tree.entries.map(entry => entry.subject), [alice]);
  assert.equal(snapshot.excluded.length, 0);

  const missing = new Reader();
  missing.tx(2, [issue(alice), deny(alice)]);
  missing.tx(5, [correct(alice)]);
  const failClosed = await buildSourceRoster(missing, options(missing));
  assert.equal(failClosed.tree.entries.length, 0);
  assert.match(failClosed.excluded[0].reason, /revoke|no issuance/);
});

test('getLogs omission, duplicated logs and foreign injected logs cannot become a publishable snapshot', async () => {
  for (const change of ['omit', 'duplicate', 'foreign'] as const) {
    const r = new Reader(); r.tx(2, [issue(alice)]); r.tx(3, [revoke(alice)]);
    const get = r.getLogs.bind(r);
    r.getLogs = async f => {
      const logs = await get(f);
      if (!logs.length) return logs;
      if (change === 'omit') return logs.filter(l => l.blockNumber !== 3);
      if (change === 'duplicate') return [...logs, logs[0]];
      return [...logs, { ...logs[0], address: issuer }];
    };
    await assert.rejects(buildSourceRoster(r, options(r)), /getLogs\/receipts disagree/);
  }
});

test('PM-T18-01 consistently omitted revoke transaction cannot produce a stale allow roster', async () => {
  const r = new Reader();
  r.tx(2, [issue(alice)]);
  r.tx(3, [revoke(alice)]);
  const getBlock = r.getBlock.bind(r);
  const getLogs = r.getLogs.bind(r);
  r.getBlock = async tag => {
    const block = await getBlock(tag);
    return block && tag === 3 ? { ...block, transactions: [] } : block;
  };
  r.getLogs = async filter => (await getLogs(filter)).filter(log => log.blockNumber !== 3);

  await assert.rejects(buildSourceRoster(r, options(r)), /receipt root|independent source header/i);
});

test('receipt payload is cryptographically bound to the independently observed block receipts root', async () => {
  const r = new Reader(); const tx = r.tx(2, [issue(alice)]);
  const getReceipt = r.getTransactionReceipt.bind(r);
  r.getTransactionReceipt = async hash => {
    const receipt = await getReceipt(hash);
    return receipt && hash === tx.hash ? { ...receipt, cumulativeGasUsed: receipt.cumulativeGasUsed + 1n } : receipt;
  };
  await assert.rejects(buildSourceRoster(r, options(r)), /receipt root mismatch/);
});

test('missing receipts, changed coordinates and receipt-local log omission fail even if indexed logs look valid', async () => {
  for (const change of ['missing', 'block', 'index', 'logs'] as const) {
    const r = new Reader(); const tx = r.tx(2, [issue(alice), revoke(alice)]);
    const get = r.getTransactionReceipt.bind(r);
    r.getTransactionReceipt = async hash => {
      const receipt = await get(hash);
      if (!receipt || hash !== tx.hash) return receipt;
      if (change === 'missing') return null;
      if (change === 'block') receipt.blockHash = ethers.ZeroHash;
      if (change === 'index') receipt.index++;
      if (change === 'logs') receipt.logs = [receipt.logs[1]];
      return receipt;
    };
    await assert.rejects(buildSourceRoster(r, options(r)), /receipt/);
  }
});

test('wrong chain, missing finality, unfinalized cutoff, fake deployment and partial-scan budgets are rejected', async () => {
  const r = new Reader(); r.tx(2, [issue(alice)]);
  for (const changed of [{ chainId: 1n }, { cutoffBlock: 10 }, { deploymentTx: ethers.id('missing') }, { maxBlocks: 2 }, { maxReceipts: 1 },
    { confirmations: 0 }, { logChunk: 0 }, { receiptConcurrency: 0 }, { receiptConcurrency: 17 }, { receiptRetries: 0 },
    { receiptRetries: 11 }, { expectedCutoffHash: ethers.ZeroHash }]) {
    await assert.rejects(buildSourceRoster(r, { ...options(r), ...changed }));
  }
  const wrong = new Reader(); wrong.receipts.get(wrong.deploymentTx)!.contractAddress = issuer;
  await assert.rejects(buildSourceRoster(wrong, options(wrong)), /deployment/);
  const noFinal = new Reader(); const get = noFinal.getBlock.bind(noFinal);
  noFinal.getBlock = async tag => tag === 'finalized' ? null : get(tag);
  await assert.rejects(buildSourceRoster(noFinal, options(noFinal)), /block/);
});

test('parent discontinuity and a cutoff reorg during log comparison discard the whole snapshot', async () => {
  const r = new Reader(); r.blocks.get(5)!.parentHash = ethers.ZeroHash;
  await assert.rejects(buildSourceRoster(r, options(r)), /block chain changed/);
  const fork = new Reader(); fork.tx(2, [issue(alice)]);
  const get = fork.getLogs.bind(fork);
  fork.getLogs = async f => { const logs = await get(f); if (f.toBlock === 9) fork.blocks.get(9)!.hash = ethers.id('fork'); return logs; };
  await assert.rejects(buildSourceRoster(fork, options(fork)), /snapshot changed/);
});

test('malformed trusted lifecycle logs and invalid issuance cannot be silently ignored; foreign receipts do not grant authority', async () => {
  const foreign = new Reader(); foreign.tx(2, [{ ...issue(alice), address: issuer }]);
  assert.equal((await buildSourceRoster(foreign, options(foreign))).tree.entries.length, 0);
  const malformed = new Reader(); const tx = malformed.tx(2, [issue(alice)]);
  (tx.logs as SnapshotLog[])[0].data += '00'.repeat(32);
  await assert.rejects(buildSourceRoster(malformed, options(malformed)), /noncanonical/);
  const invalid = new Reader(); invalid.tx(2, [issue(alice, ethers.ZeroHash)]);
  await assert.rejects(buildSourceRoster(invalid, options(invalid)), /attributes/);
});
