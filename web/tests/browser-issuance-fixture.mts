/** Owned Chromium + built frontend. API calls go directly to the real local route server. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

export async function builtFrontend(t: TestContext, cwd: string, fetch: typeof globalThis.fetch) {
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupOutput = '';
  const remember = (chunk: Buffer) => { startupOutput = (startupOutput + chunk.toString('utf8')).slice(-4000); };
  app.stdout.on('data', remember); app.stderr.on('data', remember);
  t.after(async () => { if (app.exitCode === null) { app.kill('SIGTERM'); await new Promise(r => app.once('exit', r)); } });
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; ; n++) {
    try { assert.equal((await fetch(base + '/verify/sandbox', { signal: AbortSignal.timeout(2000), redirect: 'error' })).status, 200); return base; }
    catch {
      if (app.exitCode !== null || n >= 50) {
        throw new Error(`Build web before the connected browser integration (exit ${app.exitCode ?? 'running'}): ${startupOutput}`);
      }
      await delay(100);
    }
  }
}

export async function browserIssuance(t: TestContext, base: string,
  wallet: { address: string; signMessage(message: Uint8Array): Promise<string> }) {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(10000);
  const errors: string[] = [], calls: { path: string; method: string; action?: string }[] = [];
  let signatures = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return;
    calls.push({ path, method: request.method(), ...(['/api/kyc/issue', '/api/kyc/status'].includes(path) && request.method() === 'POST'
      ? { action: path.endsWith('/status') ? 'status' : request.postDataJSON()?.action ?? 'issue' } : {}) });
  });
  // Block external navigation/assets/RPC. No route.fulfill, response substitution or API replay.
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.exposeFunction('syntheticWalletSign', async (message: string, address: string) => {
    assert.equal(address.toLowerCase(), wallet.address.toLowerCase()); assert.match(message, /^0x(?:[0-9a-f]{2})+$/i);
    const bytes = Buffer.from(message.slice(2), 'hex');
    assert.match(bytes.toString('utf8'), /wants you to sign in with your Ethereum account/);
    signatures++; return wallet.signMessage(bytes);
  });
  await page.addInitScript(address => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const w = window as unknown as { ethereum: unknown; syntheticWalletSign(message: string, address: string): Promise<string> };
    w.ethereum = {
      on(event: string, fn: (value: unknown) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
      removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
      async request(args: { method: string; params?: string[] }) {
        if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') return [address];
        if (args.method === 'personal_sign' && args.params?.length === 2) return w.syntheticWalletSign(args.params[0], args.params[1]);
        throw new Error('Unexpected synthetic wallet method');
      },
    };
  }, wallet.address);
  const sign = async () => {
    await page.getByRole('button', { name: /^Matching details/ }).click();
    await page.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor();
    await page.getByRole('checkbox').check();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/kyc/wallet' && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Connect and sign', exact: true }).click();
    const actual = await response; assert.equal(actual.status(), 200); const body = await actual.json();
    await page.getByRole('button', { name: 'Signed', exact: true }).waitFor(); return body;
  };
  const recover = async (action: 'status' | 'resume') => {
    const expectedPath = action === 'status' ? '/api/kyc/status' : '/api/kyc/issue';
    const response = page.waitForResponse(r => new URL(r.url()).pathname === expectedPath
      && (action === 'status' || r.request().postDataJSON()?.action === action));
    await page.getByRole('button', { name: action === 'status' ? 'Load original result' : 'Resume original request', exact: true }).click();
    const actual = await response; assert.equal(actual.status(), 200);
    const request = actual.request().postDataJSON(); assert.equal(request.idProof, undefined); assert.equal(request.bankProof, undefined);
    const body = await actual.json();
    await page.getByRole('region', { name: 'Review and submit', exact: true })
      .getByText(body.onchain.txHash, { exact: true }).waitFor({ state: 'attached' });
    return body;
  };
  await page.goto(base + '/verify/sandbox');
  return { page, calls, errors, sign, recover, signatures: () => signatures,
    recoveryId: () => page.evaluate(address => sessionStorage.getItem(`proofmark-request:${address.toLowerCase()}`), wallet.address) };
}
