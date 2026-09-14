import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletSession, WalletSessionChanged, type WalletProvider } from './wallet-session.js';
const a = '0x' + 'ab'.repeat(20), b = '0x' + 'cd'.repeat(20);
function provider() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const p = { accounts: [a] as unknown, request: async (_args: { method: string }) => p.accounts,
    on(event: string, fn: (value: unknown) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
    removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
    emit(event: string, value: unknown) { for (const fn of [...listeners.get(event) ?? []]) fn(value); },
    listeners };
  return p;
}
test('wallet account, chain and disconnect changes invalidate a session and remove only its listeners', () => {
  for (const [event, value] of [['accountsChanged', [b]], ['accountsChanged', []], ['chainChanged', '0x1'], ['disconnect', { message: 'PRIVATE_PROVIDER_DATA' }]] as const) {
    const p = provider(), notices: string[] = [], session = new WalletSession();
    const foreign = () => {}; p.on('accountsChanged', foreign);
    session.attach(p, reason => notices.push(reason)); const revision = session.revision; session.bind(revision, [a]);
    p.emit('accountsChanged', [a.toUpperCase().replace('0X', '0x')]); assert.equal(notices.length, 0);
    p.emit(event, value); assert.throws(() => session.assertCurrent(revision), WalletSessionChanged);
    assert.equal(notices.length, 1); assert.equal(notices[0].includes('PRIVATE_PROVIDER_DATA'), false);
    assert.deepEqual([...p.listeners.get('accountsChanged')!], [foreign]);
    assert.equal(p.listeners.get('chainChanged')!.size, 0); assert.equal(p.listeners.get('disconnect')!.size, 0);
  }
});
test('wallet connection refuses stale permission results and providers without event support', () => {
  const p = provider(), session = new WalletSession(); session.attach(p, () => {}); const revision = session.revision;
  p.emit('accountsChanged', [b]); assert.throws(() => session.bind(revision, [a]), WalletSessionChanged);
  assert.throws(() => session.attach({ request: async () => [a] }, () => {}), /account-change notifications/);
});
test('wallet connection accepts a pre-authorization empty account event superseded by the permission result', async () => {
  const p = provider(), notices: string[] = [], session = new WalletSession();
  session.attach(p, reason => notices.push(reason)); const revision = session.revision;
  p.emit('accountsChanged', []); assert.equal(session.bind(revision, [a]), a);
  await session.check(revision, () => p); assert.deepEqual(notices, []);
});
test('account rechecks reject silent account changes and replacement during an outstanding request', async () => {
  const p = provider(), session = new WalletSession(); session.attach(p, () => {}); session.bind(session.revision, [a]);
  p.accounts = [b]; await assert.rejects(session.check(session.revision, () => p), WalletSessionChanged);
  p.accounts = [a]; session.attach(p, () => {}); const revision = session.revision; session.bind(revision, [a]);
  let resolve!: (accounts: unknown) => void; p.request = async () => new Promise(r => { resolve = r; });
  let current: WalletProvider = p; const pending = session.check(revision, () => current);
  await Promise.resolve(); // The request wrapper dispatches after installing cancellation handlers.
  current = provider(); resolve([a]); await assert.rejects(pending, WalletSessionChanged);
});
test('late callbacks and results from a disposed session cannot invalidate or update a new session', async () => {
  const p = provider(), session = new WalletSession(), notices: string[] = [];
  session.attach(p, reason => notices.push(reason)); const first = session.revision; session.bind(first, [a]);
  const late = [...p.listeners.get('disconnect')!][0];
  session.attach(p, reason => notices.push(reason)); const second = session.revision; session.bind(second, [a]);
  late({}); session.assertCurrent(second); assert.throws(() => session.assertCurrent(first), WalletSessionChanged);
  await session.check(second, () => p); assert.deepEqual(notices, []);
  session.dispose(); assert.equal([...p.listeners.values()].reduce((n, s) => n + s.size, 0), 0);
});

test('wallet expiry subtracts request duration and invalidates once without a provider request', () => {
  let now = { wall: 10000, monotonic: 100 };
  const p = provider(), notices: string[] = [], session = new WalletSession(() => now);
  session.attach(p, reason => notices.push(reason)); const revision = session.revision; session.bind(revision, [a]);
  const started = session.authorizationStarted(); now = { wall: 10400, monotonic: 500 };
  session.authorize(revision, { serverTime: 900000, walletExpiresAt: 901000 }, started);
  now = { wall: 10999, monotonic: 1099 }; assert.equal(session.expireIfNeeded(), false);
  now = { wall: 11000, monotonic: 1100 }; assert.equal(session.expireIfNeeded(), true);
  assert.equal(session.expireIfNeeded(), false); assert.equal(notices.length, 1); assert.match(notices[0], /session expired/);
  assert.throws(() => session.assertCurrent(revision), WalletSessionChanged);
  assert.equal([...p.listeners.values()].reduce((n, s) => n + s.size, 0), 0);
});

test('wallet expiry rejects unavailable timing, excessive TTL, delayed responses and clock regression', () => {
  for (const timing of [{ serverTime: 100, walletExpiresAt: 100 }, { serverTime: 100, walletExpiresAt: 1800101 },
    { serverTime: 8700000000000000, walletExpiresAt: 8700000000001000 },
    { serverTime: NaN, walletExpiresAt: 1000 }, { serverTime: 100, walletExpiresAt: undefined as unknown as number }]) {
    const p = provider(), session = new WalletSession(() => ({ wall: 10000, monotonic: 100 }));
    session.attach(p, () => {}); const rev = session.revision; session.bind(rev, [a]);
    assert.throws(() => session.authorize(rev, timing, session.authorizationStarted()), WalletSessionChanged);
  }
  for (const later of [{ wall: 11000, monotonic: 100 }, { wall: 10000, monotonic: 1100 }, { wall: 9999, monotonic: 100 }, { wall: 10000, monotonic: 99 }]) {
    let now = { wall: 10000, monotonic: 100 }; const session = new WalletSession(() => now), p = provider();
    session.attach(p, () => {}); const rev = session.revision; session.bind(rev, [a]);
    const started = session.authorizationStarted(); now = later;
    assert.throws(() => session.authorize(rev, { serverTime: 100, walletExpiresAt: 1100 }, started), WalletSessionChanged);
  }
});

test('wallet expiry during an account await rejects its late answer and does not affect a fresh authorization', async () => {
  let now = { wall: 10000, monotonic: 100 };
  const session = new WalletSession(() => now), p = provider(), notices: string[] = [];
  session.attach(p, r => notices.push(r)); const rev = session.revision; session.bind(rev, [a]);
  session.authorize(rev, { serverTime: 100, walletExpiresAt: 1100 }, session.authorizationStarted());
  let finish!: (value: unknown) => void; p.request = async () => new Promise(resolve => { finish = resolve; });
  const pending = session.check(rev, () => p); await Promise.resolve(); now = { wall: 11000, monotonic: 1100 }; finish([a]);
  await assert.rejects(pending, WalletSessionChanged); assert.equal(notices.length, 1);
  session.attach(p, r => notices.push(r)); const fresh = session.revision; session.bind(fresh, [a]);
  session.authorize(fresh, { serverTime: 100, walletExpiresAt: 1100 }, session.authorizationStarted());
  session.assertCurrent(fresh); assert.throws(() => session.assertCurrent(rev), WalletSessionChanged);
  session.clearAuthorization(); now = { wall: 13000, monotonic: 3100 }; session.assertCurrent(fresh);
  assert.equal(notices.length, 1);
});

test('wallet permission, account and signing waits time out without replay and consume late resolve/reject', async () => {
  for (const method of ['eth_requestAccounts', 'eth_accounts', 'personal_sign'] as const) {
    const p = provider(), notices: string[] = [], session = new WalletSession(undefined, { account: 10, prompt: 10 });
    let calls = 0, finish!: (value: unknown) => void, fail!: (error: Error) => void;
    p.request = async () => { calls++; return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); };
    session.attach(p, r => notices.push(r)); const rev = session.revision; session.bind(rev, [a]);
    await assert.rejects(session.request(rev, { method }, () => p), WalletSessionChanged);
    assert.equal(calls, 1); assert.equal(notices.length, 1); assert.match(notices[0], /did not cancel/);
    session.attach(p, r => notices.push(r)); const next = session.revision; session.bind(next, [a]);
    if (method === 'personal_sign') fail(new Error('PRIVATE_LATE_WALLET_DIAGNOSTIC')); else finish([a]);
    await Promise.resolve(); await Promise.resolve();
    session.assertCurrent(next); assert.equal(notices.length, 1); session.dispose();
  }
});

test('wallet disposal settles pending waits immediately and suppresses an undispatched request', async () => {
  for (const dispatched of [false, true]) {
    const p = provider(), session = new WalletSession(); let calls = 0;
    p.request = async () => { calls++; return new Promise(() => {}); };
    session.attach(p, () => {}); const rev = session.revision;
    const waiting = assert.rejects(session.request(rev, { method: 'personal_sign' }, () => p), WalletSessionChanged);
    if (dispatched) await Promise.resolve();
    session.dispose(); await waiting; await Promise.resolve(); assert.equal(calls, dispatched ? 1 : 0);
  }
  let clock = { wall: 10000, monotonic: 100 }; let calls = 0;
  const p = provider(), session = new WalletSession(() => clock);
  p.request = async () => { calls++; return [a]; }; session.attach(p, () => {});
  const waiting = assert.rejects(session.request(session.revision, { method: 'eth_requestAccounts' }, () => p), WalletSessionChanged);
  clock = { wall: 130000, monotonic: 120100 }; await waiting; assert.equal(calls, 0);
});

test('wallet request rejection is private and clock-expired responses cannot beat a delayed timeout callback', async () => {
  for (const reason of ['reject', 'late', 'rewind'] as const) {
    let clock = { wall: 10000, monotonic: 100 };
    const p = provider(), notices: string[] = [], session = new WalletSession(() => clock);
    let finish!: (value: unknown) => void;
    p.request = async () => reason === 'reject' ? Promise.reject(new Error('PRIVATE_WALLET_RPC_BODY')) : new Promise(resolve => { finish = resolve; });
    session.attach(p, r => notices.push(r)); const rev = session.revision;
    const waiting = assert.rejects(session.request(rev, { method: 'personal_sign' }, () => p), WalletSessionChanged);
    await Promise.resolve();
    if (reason !== 'reject') { clock = reason === 'late' ? { wall: 130000, monotonic: 120100 } : { wall: 9999, monotonic: 100 }; finish('late-signature'); }
    await waiting; assert.equal(notices.length, 1); assert.equal(notices[0].includes('PRIVATE_WALLET_RPC_BODY'), false);
  }
  const p = provider(), session = new WalletSession(); let observed: unknown;
  p.request = async args => { observed = args; return 'synthetic-signature'; }; session.attach(p, () => {});
  const args: Parameters<WalletSession['request']>[1] = { method: 'personal_sign', params: ['original-message', a] };
  const result = session.request(session.revision, args, () => p); args.method = 'eth_accounts'; args.params![0] = 'replacement';
  assert.equal(await result, 'synthetic-signature'); assert.deepEqual(observed, { method: 'personal_sign', params: ['original-message', a] });
  session.dispose();
});
