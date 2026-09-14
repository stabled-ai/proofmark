/** Browser-safe account/session fence; no keys, server tokens or chain-switch requests. */
export type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (value: unknown) => void): unknown;
  removeListener?(event: string, listener: (value: unknown) => void): unknown;
};
export class WalletSessionChanged extends Error {
  constructor() { super('Wallet session changed. Reconnect and sign again.'); }
}
const first = (value: unknown) => Array.isArray(value) && typeof value[0] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value[0]) ? value[0].toLowerCase() : null;

export class WalletSession {
  revision = 0;
  private deadline: { wall: number; monotonic: number; startWall: number; startMonotonic: number } | null = null;
  private readonly pending = new Set<() => void>();
  constructor(private readonly clock = () => ({ wall: Date.now(), monotonic: performance.now() }),
    private readonly requestTimeouts = { account: 10000, prompt: 120000 }) {}
  authorizationStarted() { return { ...this.clock() }; }
  clearAuthorization() { this.deadline = null; }
  authorize(revision: number, timing: { serverTime: number; walletExpiresAt: number }, started: { wall: number; monotonic: number }) {
    this.assertCurrent(revision);
    const remaining = timing.walletExpiresAt - timing.serverTime;
    if (!Number.isSafeInteger(timing.serverTime) || timing.serverTime <= 0 || !Number.isSafeInteger(timing.walletExpiresAt) || timing.walletExpiresAt > 8640000000000000
      || remaining <= 0 || remaining > 30 * 60_000 || !Number.isSafeInteger(started.wall) || started.wall <= 0
      || !Number.isFinite(started.monotonic) || started.monotonic < 0 || !Number.isSafeInteger(started.wall + remaining)
      || !Number.isFinite(started.monotonic + remaining)) {
      this.invalidate('Wallet service returned invalid session expiry. Reconnect after the service is updated.'); throw new WalletSessionChanged();
    }
    // Start before the request: network/provider time is subtracted, never added to server TTL.
    this.deadline = { wall: started.wall + remaining, monotonic: started.monotonic + remaining,
      startWall: started.wall, startMonotonic: started.monotonic };
    this.assertCurrent(revision);
  }
  expireIfNeeded(): boolean {
    if (!this.deadline) return false;
    const now = this.clock(), d = this.deadline;
    if (!Number.isSafeInteger(now.wall) || !Number.isFinite(now.monotonic) || now.wall < d.startWall || now.monotonic < d.startMonotonic
      || now.wall >= d.wall || now.monotonic >= d.monotonic) {
      this.invalidate('Wallet-control session expired or its clock changed. Reconnect and sign again.'); return true;
    }
    return false;
  }
  private provider: WalletProvider | null = null;
  private address: string | null = null;
  private observed: string | null | undefined;
  private detach = () => {};
  private notify = (_reason: string) => {};
  attach(provider: WalletProvider, notify: (reason: string) => void) {
    this.dispose();
    if (typeof provider.on !== 'function' || typeof provider.removeListener !== 'function') {
      throw new Error('This wallet does not support account-change notifications. Use an event-capable injected wallet.');
    }
    this.provider = provider; this.address = null; this.observed = undefined; this.notify = notify;
    const revision = this.revision;
    const invalidate = (reason: string) => { if (this.revision === revision && this.provider === provider) this.invalidate(reason); };
    const accounts = (value: unknown) => {
      if (this.revision !== revision || this.provider !== provider) return;
      this.observed = first(value);
      // Some injected wallets report the still-unapproved empty account list while
      // eth_requestAccounts is opening. Its eventual result is the authoritative
      // first binding; empty or changed notifications remain fatal after that.
      if (this.address && (!this.observed || this.address !== this.observed)) invalidate('Wallet account changed or became unavailable.');
    };
    const chain = () => invalidate('Wallet network changed.');
    const disconnected = () => invalidate('Wallet disconnected.');
    const listeners: [string, (value: unknown) => void][] = [['accountsChanged', accounts], ['chainChanged', chain], ['disconnect', disconnected]];
    this.detach = () => { for (const [event, listener] of listeners) { try { provider.removeListener!(event, listener); } catch { /* revision still rejects stale callbacks */ } } };
    try { for (const [event, listener] of listeners) provider.on(event, listener); }
    catch { this.dispose(); throw new Error('Wallet event subscription failed. Reconnect with a supported wallet.'); }
  }
  assertCurrent(revision: number) { if (revision !== this.revision || this.expireIfNeeded()) throw new WalletSessionChanged(); }
  bind(revision: number, accounts: unknown) {
    this.assertCurrent(revision);
    const address = first(accounts);
    if (!address || (typeof this.observed === 'string' && this.observed !== address)) {
      this.invalidate('Wallet account changed while connecting.'); throw new WalletSessionChanged();
    }
    this.address = address; this.observed = address; return address;
  }
  request(revision: number, args: { method: 'eth_accounts' | 'eth_requestAccounts' | 'personal_sign'; params?: unknown[] },
    getCurrent: () => WalletProvider | undefined): Promise<unknown> {
    this.assertCurrent(revision);
    const provider = this.provider;
    if (!provider || getCurrent() !== provider) { this.invalidate('Wallet provider changed or became unavailable.'); throw new WalletSessionChanged(); }
    const timeoutMs = args.method === 'eth_accounts' ? this.requestTimeouts.account : this.requestTimeouts.prompt;
    if (!['eth_accounts', 'eth_requestAccounts', 'personal_sign'].includes(args.method)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid wallet request limits.');
    const requestArgs = { method: args.method, ...(args.params ? { params: [...args.params] } : {}) };
    const started = this.authorizationStarted();
    const timeoutReason = 'Wallet did not respond in time. This page stopped waiting, but did not cancel the wallet request. Dismiss any open prompt before reconnecting.';
    const late = () => {
      const now = this.clock();
      return !Number.isFinite(now.wall) || !Number.isFinite(now.monotonic) || now.wall < started.wall || now.monotonic < started.monotonic
        || now.wall - started.wall >= timeoutMs || now.monotonic - started.monotonic >= timeoutMs;
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.pending.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(new WalletSessionChanged());
      const timer = setTimeout(() => {
        if (settled) return;
        this.invalidate(timeoutReason);
      }, timeoutMs);
      this.pending.add(cancel);
      // Disposal settles our wait and removes its timer, not the wallet's own promise/prompt.
      // Both eventual outcomes are consumed so late rejection cannot become unhandled.
      Promise.resolve().then(() => {
        this.assertCurrent(revision);
        if (late()) { this.invalidate(timeoutReason); throw new WalletSessionChanged(); }
        if (getCurrent() !== provider) throw new WalletSessionChanged();
        return provider.request(requestArgs);
      }).then(value => {
        if (settled) return;
        try {
          if (late()) { this.invalidate(timeoutReason); return; }
          this.assertCurrent(revision);
          if (getCurrent() !== provider) { this.invalidate('Wallet provider changed or became unavailable.'); throw new WalletSessionChanged(); }
          finish(null, value);
        } catch {
          if (revision === this.revision) this.invalidate('Wallet response could not be confirmed. Reconnect with the intended account.');
          cancel();
        }
      }, () => {
        if (settled) return;
        // Provider diagnostics may contain private extension/account data; never reflect them.
        if (revision === this.revision) this.invalidate('Wallet request was declined or unavailable. Review or dismiss any open wallet prompt before reconnecting.');
        cancel();
      });
    });
  }
  async check(revision: number, getCurrent: () => WalletProvider | undefined) {
    this.assertCurrent(revision);
    if (!this.provider || getCurrent() !== this.provider) { this.invalidate('Wallet provider changed or became unavailable.'); throw new WalletSessionChanged(); }
    if (!this.address) return;
    let accounts: unknown;
    try { accounts = await this.request(revision, { method: 'eth_accounts' }, getCurrent); }
    catch { this.assertCurrent(revision); this.invalidate('Wallet account access is unavailable.'); throw new WalletSessionChanged(); }
    this.assertCurrent(revision);
    if (getCurrent() !== this.provider || first(accounts) !== this.address) { this.invalidate('Wallet account changed or became unavailable.'); throw new WalletSessionChanged(); }
  }
  invalidate(reason: string) { this.dispose(); this.notify(reason); }
  dispose() {
    this.revision++; this.deadline = null;
    for (const cancel of [...this.pending]) cancel();
    this.detach(); this.detach = () => {}; this.provider = null; this.address = null; this.observed = undefined;
  }
}
