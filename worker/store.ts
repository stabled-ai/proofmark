import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type JobState =
  | 'discovered'   // seen on the source chain, not yet attested
  | 'attested'   // the block is attested
  | 'submitted'   // submitted to the ASC
  | 'done'   // confirmed
  | 'skipped'   // the ASC already processed this query, so no gas was spent
  | 'dead';   // permanently failed, needs a human

export interface Job {
  txHash: string;
  blockNumber: number;
  blockHash?: string;
  transactionIndex?: number;
  action: number;
  eventName: string;
  logCount: number;
  state: JobState;
  attempts: number;
  lastError?: string;
  ascTxHash?: string;
  queryId?: string;
  discoveredAt: number;
  updatedAt: number;
  skipObservation?: { blockNumber: number; blockHash: string; confirmations: number; observedAt: number };
  relayHistory?: { hash: string; nonce: number; status: 'success' | 'reverted'; blockNumber: number; blockHash: string }[];
}

export interface WorkerScope { sourceChainId: number; hubChainId: number; chainKey: number; source: string; asc: string; signer: string; startBlock: number }
export interface RelayEnvelope { sourceTxHash: string; queryId: string; hash: string; raw: string; nonce: number; chainId: number; to: string; signer: string; data: string }
export class StoreWriteError extends Error { constructor() { super('WORKER_STATE_WRITE_FAILED'); } }
export class SourceSafetyError extends Error { constructor(code: string) { super(code); } }
export class HubSafetyError extends Error { constructor(code: string) { super(code); } }
export interface SourceCheckpoint { height: number; hash: string }

interface Data {
  version: 1;
  /** Last fully scanned source block. Every job up to here is persisted. */
  cursor: number;
  jobs: Record<string, Job>;
  scope?: WorkerScope;
  relay?: RelayEnvelope;
  sourceCheckpoints?: SourceCheckpoint[];
  sourceHold?: string;
  hubStartNonce?: number;
  hubHold?: string;
  sourceRewinds?: { at: number; from: number; to: number; orphanedTxs: string[] }[];
}

export interface RecoverySnapshot {
  scope?: WorkerScope;
  relay?: RelayEnvelope;
  jobs: Record<string, Job>;
  hubStartNonce?: number;
  hubHold?: string;
}

/**
 * File-backed persistent state.
 *
 * The worker cannot rely on in-memory tracking: a restart would otherwise miss source events and
 * lose ownership of a signed relay transaction.
 *
 * Writes go to a tmp file then rename, so a crash never leaves half a file.
 */
export class Store {
  private data: Data;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.data = this.load();
  }

  private load(): Data {
    const path = this.path;
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Data;
      if (parsed.version !== 1) throw new Error(`unknown state file version: ${parsed.version}`);
      if (parsed.relay) {
        const job = parsed.jobs[parsed.relay.sourceTxHash];
        if (!job || job.state !== 'submitted' || job.ascTxHash !== parsed.relay.hash || job.queryId !== parsed.relay.queryId) throw new Error('INCONSISTENT_RELAY_STATE');
      }
      return parsed;
    } else {
      return { version: 1, cursor: 0, jobs: {} };
    }
  }
  /** Must be called after acquiring exclusive process ownership. */
  reload(): void { this.data = this.load(); }
  bindScope(scope: WorkerScope): void {
    if (this.data.scope && JSON.stringify(this.data.scope) !== JSON.stringify(scope)) throw new Error('WORKER_STATE_SCOPE_MISMATCH');
    if (!this.data.scope && (this.data.cursor !== 0 || Object.keys(this.data.jobs).length)) throw new Error('LEGACY_WORKER_STATE_REQUIRES_RECONCILIATION');
    if (!this.data.scope) this.commit({ ...this.data, scope: structuredClone(scope) });
  }
  get relay(): RelayEnvelope | undefined { return structuredClone(this.data.relay); }
  get checkpoints(): SourceCheckpoint[] { return structuredClone(this.data.sourceCheckpoints ?? []); }
  recoverySnapshot(): RecoverySnapshot {
    return structuredClone({ scope: this.data.scope, relay: this.data.relay, jobs: this.data.jobs,
      hubStartNonce: this.data.hubStartNonce, hubHold: this.data.hubHold });
  }
  assertSourceReady(): void { if (this.data.sourceHold) throw new SourceSafetyError(this.data.sourceHold); }
  assertHubReady(): void { if (this.data.hubHold) throw new HubSafetyError(this.data.hubHold); }
  holdSource(reason: string): never {
    this.commit({ ...this.data, sourceHold: reason });
    throw new SourceSafetyError(reason);
  }
  holdHub(reason: string): never {
    this.commit({ ...this.data, hubHold: reason });
    throw new HubSafetyError(reason);
  }
  initializeHubSigner(startNonce: number): void {
    this.assertHubReady();
    if (!Number.isSafeInteger(startNonce) || startNonce < 0) throw new HubSafetyError('HUB_SIGNER_BASELINE_INVALID');
    if (this.data.hubStartNonce !== undefined) {
      if (this.data.hubStartNonce !== startNonce) throw new HubSafetyError('HUB_SIGNER_BASELINE_MISMATCH');
      return;
    }
    this.commit({ ...this.data, hubStartNonce: startNonce });
  }
  initializeSource(checkpoint: SourceCheckpoint): void {
    this.assertSourceReady();
    if (this.checkpoints.length) return;
    if (Object.keys(this.data.jobs).length || (this.data.cursor !== 0 && this.data.cursor !== checkpoint.height)) throw new SourceSafetyError('UNHASHED_SOURCE_STATE_REQUIRES_RECONCILIATION');
    this.commit({ ...this.data, cursor: checkpoint.height, sourceCheckpoints: [checkpoint] });
  }
  commitSourceRange(from: number, end: SourceCheckpoint, jobs: Omit<Job, 'discoveredAt' | 'updatedAt'>[]): void {
    this.assertSourceReady(); this.assertHubReady();
    if (from !== this.data.cursor + 1 || end.height < from) throw new SourceSafetyError('SOURCE_SCAN_CURSOR_CONFLICT');
    const next = structuredClone(this.data); const now = Date.now();
    for (const job of jobs) {
      if (!job.blockHash || !Number.isSafeInteger(job.transactionIndex) || job.blockNumber < from || job.blockNumber > end.height) throw new SourceSafetyError('INVALID_SOURCE_JOB_COORDINATES');
      const existing = next.jobs[job.txHash];
      if (existing && (existing.blockHash !== job.blockHash || existing.blockNumber !== job.blockNumber)) throw new SourceSafetyError('SOURCE_TX_RELOCATION_NOT_RECONCILED');
      if (!existing) next.jobs[job.txHash] = { ...job, discoveredAt: now, updatedAt: now };
    }
    const checkpoints = [...(next.sourceCheckpoints ?? []), end];
    // Preserve the verified initial anchor plus the 128 most recent range boundaries.
    next.sourceCheckpoints = checkpoints.length > 129 ? [checkpoints[0], ...checkpoints.slice(-128)] : checkpoints;
    next.cursor = end.height; this.commit(next);
  }
  rewindUnsignedSource(ancestor: SourceCheckpoint): number {
    this.assertSourceReady();
    if (!this.checkpoints.some(c => c.height === ancestor.height && c.hash === ancestor.hash)) throw new SourceSafetyError('UNKNOWN_SOURCE_ANCESTOR');
    const affected = Object.values(this.data.jobs).filter(j => j.blockNumber > ancestor.height);
    if (affected.some(j => j.ascTxHash || j.queryId || j.relayHistory?.length || ['submitted', 'done', 'skipped'].includes(j.state))) {
      return this.holdSource('SOURCE_REORG_TOUCHES_RELAYED_JOB');
    }
    const next = structuredClone(this.data);
    for (const job of affected) delete next.jobs[job.txHash];
    next.sourceRewinds ??= [];
    next.sourceRewinds.push({ at: Date.now(), from: this.data.cursor, to: ancestor.height, orphanedTxs: affected.map(j => j.txHash) });
    next.cursor = ancestor.height;
    next.sourceCheckpoints = next.sourceCheckpoints!.filter(c => c.height <= ancestor.height);
    this.commit(next); return affected.length;
  }

  reserveRelay(relay: RelayEnvelope): void {
    this.assertSourceReady(); this.assertHubReady();
    if (this.data.relay) throw new Error('RELAY_NONCE_UNRESOLVED');
    const job = this.data.jobs[relay.sourceTxHash];
    if (!job || ['done', 'dead', 'skipped'].includes(job.state)) throw new Error('RELAY_JOB_NOT_PENDING');
    const next = structuredClone(this.data);
    next.relay = structuredClone(relay);
    Object.assign(next.jobs[job.txHash], { state: 'submitted', ascTxHash: relay.hash, queryId: relay.queryId, updatedAt: Date.now() });
    this.commit(next);
  }

  finishRelay(hash: string, receipt: { status: 'success' | 'reverted'; blockNumber: number; blockHash: string }): void {
    this.assertHubReady();
    const relay = this.data.relay;
    if (!relay || relay.hash !== hash) throw new Error('RELAY_STATE_CONFLICT');
    const next = structuredClone(this.data); const job = next.jobs[relay.sourceTxHash];
    job.relayHistory ??= [];
    job.relayHistory.push({ hash, nonce: relay.nonce, ...receipt });
    job.state = receipt.status === 'success' ? 'done' : 'dead';
    job.lastError = receipt.status === 'success' ? undefined : 'ASC_TRANSACTION_REVERTED_REVIEW_REQUIRED';
    job.updatedAt = Date.now(); delete next.relay;
    this.commit(next);
  }

  get cursor(): number { return this.data.cursor; }

  /** Advance the cursor only once every job for that block is persisted. */
  setCursor(block: number): void {
    if (block < this.data.cursor) return;   // never rewind
    this.commit({ ...this.data, cursor: block });
  }

  has(txHash: string): boolean { return txHash in this.data.jobs; }
  get(txHash: string): Job | undefined { return structuredClone(this.data.jobs[txHash]); }

  add(job: Omit<Job, 'discoveredAt' | 'updatedAt'>): Job {
    if (this.has(job.txHash)) return this.get(job.txHash)!;
    const now = Date.now();
    const j: Job = { ...job, discoveredAt: now, updatedAt: now };
    const next = structuredClone(this.data); next.jobs[j.txHash] = j;
    this.commit(next);
    return structuredClone(j);
  }

  update(txHash: string, patch: Partial<Job>): void {
    if (this.data.relay?.sourceTxHash === txHash && patch.state && patch.state !== 'submitted') throw new Error('UNRESOLVED_RELAY_CANNOT_BE_DROPPED');
    const next = structuredClone(this.data); const j = next.jobs[txHash];
    if (!j) return;
    Object.assign(j, patch, { updatedAt: Date.now() });
    this.commit(next);
  }

  /** Jobs that have not finished */
  pending(): Job[] {
    const jobs = Object.values(this.data.jobs).filter(
      (j) => j.state !== 'done' && j.state !== 'dead' && j.state !== 'skipped',
    );
    // The unresolved nonce owner must not starve behind attestation waits after restart.
    jobs.sort((a, b) => Number(b.txHash === this.data.relay?.sourceTxHash) - Number(a.txHash === this.data.relay?.sourceTxHash));
    return structuredClone(jobs);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const j of Object.values(this.data.jobs)) out[j.state] = (out[j.state] ?? 0) + 1;
    return out;
  }

  private commit(next: Data): void {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next, null, 2)); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(tmp, this.path);
      this.data = next;
      const directory = openSync(dirname(this.path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      // A rename may have succeeded. Reload authoritative bytes; caller must not broadcast on
      // any save error and can later reconcile a remotely/locally committed signature.
      this.data = this.load();
      throw new StoreWriteError();
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
}

/** Pending jobs not already executing. Kept beside Store so retry scheduling is unit-testable
 * without loading network configuration. */
export function jobsReadyForDispatch(store: Store, reserved: { has(id: string): boolean }, limit = Infinity): Job[] {
  return store.pending().filter((job) => !reserved.has(job.txHash)).slice(0, limit);
}
