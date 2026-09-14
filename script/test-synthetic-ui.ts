/** Real Chromium rendering with synthetic API responses. Not wallet/source/hub E2E. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

test('rendered synthetic samples fill the API flow, distinguish rejection, reset state and require demo configuration', { timeout: 45000 }, async t => {
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: fileURLToPath(new URL('../web/', import.meta.url)), stdio: 'ignore' });
  t.after(async () => { if (app.exitCode === null) { app.kill('SIGTERM'); await new Promise(r => app.once('exit', r)); } });
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; ; n++) {
    try { if ((await fetch(base + '/verify/sandbox')).ok) break; throw new Error('not ready'); }
    catch { if (app.exitCode !== null || n >= 100) throw new Error('local Next build did not start'); await delay(100); }
  }
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  mkdirSync('artifacts', { recursive: true });
  const screenshots = mkdtempSync(join('artifacts', 'verify-accessibility-'));
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [], calls: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const wallet = '0x1111111111111111111111111111111111111111'; let mode = 'demo'; let documents = 0, bankCalls = 0;
  let enableIssuance = false, walletRequestId = '0x' + '77'.repeat(32), issuanceCalls = 0, recoveryCalls = 0;
  let walletLifetime = 30 * 60_000;
  const originalRequestId = walletRequestId;
  let heldDocument: { ready: () => void; release: Promise<void> } | null = null;
  await page.addInitScript({ content: `const listeners = new Map(); window.ethereum = {
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    removeListener(event, fn) { listeners.get(event)?.delete(fn); },
    async request(args) { return ['eth_requestAccounts', 'eth_accounts'].includes(args.method) ? [${JSON.stringify(wallet)}] : 'synthetic-signature-not-valid-on-any-chain'; }
  }; window.emitSyntheticWalletEvent = (event, value) => { for (const fn of [...(listeners.get(event) || [])]) fn(value); };` });
  const side = (name: string) => ({ configured: true, vendor: `demo:${name}`, live: false, demo: true, env: 'demo', missing: [] });
  const cfg = () => ({ demo: mode !== 'live', sandboxBits: true,
    id: mode === 'demo' ? side('id') : { ...side('id'), demo: false, live: true, vendor: 'synthetic-live-config' }, bank: side('bank'),
    issuer: { configured: enableIssuance, address: null, missing: enableIssuance ? [] : ['ISSUER_PRIVATE_KEY'] }, banks: [{ code: '004', name: 'Synthetic bank label' }],
    vault: { configured: false, persistent: false, missing: [], mode: 'none' }, bankState: { configured: true, mode: 'demo-memory' },
    issuanceJournal: { configured: enableIssuance, mode: enableIssuance ? 'redis-encrypted' : 'none', missing: [] },
    tokenKey: { configured: enableIssuance, mode: enableIssuance ? 'versioned-dedicated' : 'none', missing: [] },
    processingPolicy: { configured: true, status: 'synthetic', policyId: 'synthetic-browser-policy', customerId: 'synthetic-browser-customer',
      operatingModel: 'first-party', noticeVersion: 'synthetic-browser-v1', noticeStatement: 'Synthetic browser fixture processing notice.',
      fingerprint: '0x' + '11'.repeat(32), missing: [] },
    issuanceTracking: { configured: true, sourceExpectedSeconds: [10, 30], hubExpectedSeconds: [20, 60], timeoutSeconds: 120,
      supportUrl: 'https://support.example.test/issuance', missing: [], invalid: [] } });
  const recovered = (ready = false) => ({ status: ready ? 'ISSUED' : 'PREPARED', requestId: originalRequestId, subject: wallet,
    issuance: { phase: ready ? 'materialized' : 'prepared' }, evidenceHash: '0x' + 'aa'.repeat(32), evidence: [], reason: 'synthetic recovered original request',
    progress: { source: ready ? { state: 'confirmed', blockNumber: 12, confirmedAt: Date.now() - 1_000 } : { state: 'not-submitted' },
      attestation: ready ? { state: 'applied', appliedAt: Date.now() } : { state: 'not-started' },
      policy: ready ? { state: 'eligible', policies: [{ id: 2, name: 'pilot', verified: true, reasonCodes: [] }] }
        : { state: 'waiting-attestation', policies: [] }, nextAction: ready ? 'refresh-status' : 'resume', timing: {
        configured: true, source: { expectedSeconds: [10, 30], expectedBy: Date.now() + 30_000, overdue: false },
        attestation: { expectedSeconds: [20, 60], expectedBy: null, overdue: null }, timeoutAt: Date.now() + 120_000,
        timedOut: false, supportUrl: 'https://support.example.test/issuance', missing: [], invalid: [] } },
    assetAction: { ready, readyPolicyIds: ready ? [2] : [], scope: 'synthetic status fixture' },
    ...(ready ? { onchain: { sent: true, blockNumber: 12 }, claims: [], attrs: '0x' + '00'.repeat(32), claimsRoot: '0x' + 'bb'.repeat(32),
      methodsHex: '0x0', methodNames: [], regime: 2, assurance: 3, expiry: 2_000_000_000,
      policyPreview: { production: false, sandbox: false, scope: 'synthetic' } } : {}) });
  await page.route('**/*', async route => {
    const req = route.request(), url = req.url();
    if (!url.startsWith(base)) return route.abort();
    if (!url.startsWith(base + '/api/')) return route.continue();
    const path = new URL(url).pathname; calls.push(path);
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/kyc/status') {
      if (req.method() === 'GET') return reply(cfg());
      const body = req.postDataJSON(); recoveryCalls++; assert.equal(body.requestId, originalRequestId);
      assert.equal(body.walletProof, 'synthetic-new-flow-proof'); assert.equal(body.idProof, undefined); assert.equal(body.bankProof, undefined);
      return reply(recovered(recoveryCalls === 3));
    }
    if (path === '/api/kyc/wallet') {
      const serverTime = Date.now();
      return reply(req.method() === 'GET' ? { message: 'synthetic consent fixture', token: 'challenge' } : { address: wallet,
        walletProof: walletRequestId === originalRequestId ? 'synthetic-flow-proof' : 'synthetic-new-flow-proof', requestId: walletRequestId,
        serverTime, walletExpiresAt: serverTime + walletLifetime });
    }
    if (path === '/api/kyc/issue') {
      const body = req.postDataJSON();
      if (!body.action) {
        issuanceCalls++;
        assert.equal(await page.evaluate(address => sessionStorage.getItem(`proofmark-request:${address}`), wallet), originalRequestId,
          'recovery ID must be persisted before the first issuance request leaves the browser');
        return route.abort('failed'); // No status, body or requestId ever reaches the client.
      }
      recoveryCalls++; assert.equal(body.action, 'status'); assert.equal(body.requestId, originalRequestId);
      assert.equal(body.walletProof, 'synthetic-new-flow-proof');
      assert.equal(body.idProof, undefined); assert.equal(body.bankProof, undefined);
      return reply(recovered());
    }
    if (path === '/api/kyc/id') {
      const form = await new Request(url, { method: 'POST', headers: req.headers(), body: new Uint8Array(req.postDataBuffer()!) }).formData();
      assert.equal(form.get('syntheticSample'), '1'); assert.equal(form.get('walletProof'), walletRequestId === originalRequestId ? 'synthetic-flow-proof' : 'synthetic-new-flow-proof');
      const file = form.get('image') as File; assert.equal(file.type, 'image/png'); assert.match(file.name, /^proofmark-synthetic-/);
      const bytes = new Uint8Array(await file.arrayBuffer()); assert.deepEqual(Array.from(bytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(bytes.length > 1000 && bytes.length < 100000); documents++;
      if (heldDocument) { const held = heldDocument; heldDocument = null; held.ready(); await held.release; }
      const authentic = !String(form.get('fullName')).includes('FAKE');
      return reply({ status: authentic ? 'verified' : 'rejected', idProof: 'synthetic-id-proof', summary: {
        docType: 'RRC', docHash: '0x' + 'ab'.repeat(32), authenticityChecked: true, authentic, live: false, vendor: 'demo:id', ref: null, code: authentic ? '1' : '0',
      } });
    }
    if (path === '/api/kyc/bank') {
      const body = req.postDataJSON(); assert.equal(body.syntheticSample, true); assert.equal(body.walletProof, walletRequestId === originalRequestId ? 'synthetic-flow-proof' : 'synthetic-new-flow-proof'); bankCalls++;
      if (body.action === 'start') {
        if (body.accountNumber.endsWith('99')) return reply({ error: 'The bank account holder does not match the declared identity.', code: 'HOLDER_MISMATCH' }, 422);
        return reply({ challenge: 'synthetic-challenge', holderNameMasked: 'P***', vendor: 'demo:bank', live: false, ref: null, demoCode: '1234' });
      }
      assert.equal(body.code, '1234');
      return reply({ bankProof: 'synthetic-bank-proof', summary: { bankCode: '004', holderNameMasked: 'P***', vendor: 'demo:bank', live: false, ref: null } });
    }
    throw new Error('unexpected API action ' + path);
  });
  await page.goto(base + '/verify/sandbox'); const samples = page.getByRole('region', { name: 'Synthetic sample scenarios' });
  await samples.waitFor(); assert.match(await page.locator('body').innerText(), /do not enter real personal information/);
  const connect = page.getByRole('button', { name: 'Connect and sign', exact: true });
  assert.equal(await connect.isDisabled(), true);
  const loadMatching = page.getByRole('button', { name: 'Matching details' });
  await loadMatching.focus(); await page.keyboard.press('Enter');
  await samples.getByRole('button', { name: 'Matching details', pressed: true }).waitFor();
  const documentStep = page.getByRole('region', { name: 'ID document', exact: true });
  assert.equal(await documentStep.locator('details').first().getAttribute('open'), null, 'future steps start collapsed');
  await documentStep.locator('summary').first().click();
  await page.getByRole('img', { name: 'Synthetic training sample — not an identity document' }).waitFor();
  assert.deepEqual(calls, ['/api/kyc/status'], 'loading the sample must not call wallet, vendor or issuance APIs');
  assert.equal(await page.getByRole('region', { name: 'Connect your wallet', exact: true }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'ID document', level: 2, exact: true }).count(), 1);
  assert.equal(await page.getByRole('radio', { name: 'Resident card', exact: true }).isDisabled(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '390px sample view must not require horizontal page scrolling');
  await page.screenshot({ path: join(screenshots, 'sample-mobile.png'), fullPage: true });
  await page.getByText('Wallet requirements and session details', { exact: true }).click();
  assert.match(await page.getByRole('region', { name: 'Connect your wallet', exact: true }).innerText(), /Contract-wallet and multisig verification are not supported/);
  await page.getByText('Wallet requirements and session details', { exact: true }).click();
  assert.equal(await page.getByLabel('Name on the card', { exact: true }).inputValue(), 'PROOFMARK SAMPLE PERSON');
  assert.equal(await page.locator('input[type=file]').isDisabled(), true);
  assert.equal(await page.getByLabel('Name on the card', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Read document details' }).isDisabled(), true);
  const sign = async () => {
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Connect and sign', exact: true }).click();
    try { await page.getByRole('button', { name: 'Signed', exact: true }).waitFor({ timeout: 5000 }); }
    catch { throw new Error('synthetic wallet flow failed: ' + await page.locator('body').innerText()); }
  };
  const consent = page.getByRole('checkbox'); await consent.focus(); await page.keyboard.press('Space');
  assert.equal(await consent.isChecked(), true);
  assert.ok(await consent.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
  assert.deepEqual(calls, ['/api/kyc/status'], 'keyboard consent alone must not request a signature or send data');
  await sign();
  await page.getByRole('region', { name: 'Connect your wallet', exact: true }).screenshot({ path: join(screenshots, 'wallet-expiry.png') });
  await page.getByRole('button', { name: 'Check sample document' }).click();
  const bank = page.getByRole('button', { name: 'Check sample account', includeHidden: true });
  await bank.waitFor(); await bank.click(); await page.getByRole('region', { name: 'Bank account', exact: true }).getByLabel('Code', { exact: false }).fill('1234');
  assert.equal(await page.getByLabel('Account number', { exact: false }).isDisabled(), true);
  assert.match(await page.locator('body').innerText(), /No real deposit was made/);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByText('one-won code', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Submit verification', exact: true, includeHidden: true }).isDisabled(), true, 'missing journal is not bypassed by samples');
  await page.getByRole('button', { name: 'Rejected document' }).click();
  await samples.getByRole('button', { name: 'Rejected document', pressed: true }).waitFor();
  await page.getByRole('button', { name: 'Connect and sign', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox').isChecked(), false); assert.equal(await page.getByRole('button', { name: 'Confirm', exact: true }).count(), 0);
  await sign(); await page.getByRole('button', { name: 'Check sample document' }).click();
  await page.getByText('not confirmed', { exact: true }).first().waitFor(); assert.equal(await bank.isDisabled(), true);
  await page.getByRole('button', { name: 'Account mismatch' }).click();
  await samples.getByRole('button', { name: 'Account mismatch', pressed: true }).waitFor();
  await samples.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor(); await sign();
  await page.getByRole('button', { name: 'Check sample document' }).click(); await bank.click();
  await page.getByText('The bank account holder does not match the declared identity.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: 'The bank account holder does not match the declared identity.' }).count(), 1);
  assert.equal(documents, 3); assert.equal(bankCalls, 3); assert.ok(!calls.includes('/api/kyc/issue'));
  enableIssuance = true; await page.reload(); await samples.waitFor();
  await page.getByRole('button', { name: 'Matching details' }).click();
  await samples.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor(); await sign();
  await page.getByRole('button', { name: 'Check sample document' }).click(); await bank.click();
  await page.getByRole('region', { name: 'Bank account', exact: true }).getByLabel('Code', { exact: false }).fill('1234'); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByText('one-won code', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Submit verification', exact: true }).click();
  await page.getByText('Failed to fetch', { exact: false }).waitFor();
  assert.equal(issuanceCalls, 1); assert.equal(recoveryCalls, 0);
  walletRequestId = '0x' + '88'.repeat(32); await page.reload(); await samples.waitFor();
  await page.getByRole('button', { name: 'Matching details' }).click();
  await samples.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor(); await sign();
  await page.getByRole('button', { name: 'Load original result', exact: true }).click();
  await page.getByText('synthetic recovered original request', { exact: false }).waitFor();
  assert.equal(issuanceCalls, 1); assert.equal(recoveryCalls, 1);
  assert.equal(await page.evaluate(address => sessionStorage.getItem(`proofmark-request:${address}`), wallet), originalRequestId,
    'reconnecting must not overwrite the old recovery target with the new flow ID');
  const emit = (event: string, value: unknown) => page.evaluate(({ event, value }) => {
    (window as unknown as { emitSyntheticWalletEvent: (event: string, value: unknown) => void }).emitSyntheticWalletEvent(event, value);
  }, { event, value });
  await emit('accountsChanged', [wallet]); assert.equal(await page.getByRole('button', { name: 'Signed', exact: true }).count(), 1);
  await emit('accountsChanged', ['0x' + '22'.repeat(20)]);
  await page.getByText('Local details were cleared.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Signed', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Load original result', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Name on the card', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  assert.equal(await page.evaluate(address => sessionStorage.getItem(`proofmark-request:${address}`), wallet), originalRequestId);
  await page.getByRole('button', { name: 'Matching details' }).click();
  await samples.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor(); await sign();
  let releaseDocument!: () => void, documentReady!: () => void;
  const ready = new Promise<void>(resolve => { documentReady = resolve; });
  heldDocument = { ready: documentReady, release: new Promise<void>(resolve => { releaseDocument = resolve; }) };
  await page.getByRole('button', { name: 'Check sample document' }).click(); await ready;
  await page.getByRole('status').filter({ hasText: 'Working on document verification. Please wait.' }).waitFor({ state: 'attached' });
  await emit('chainChanged', '0x1'); await page.getByText('Wallet network changed.', { exact: false }).waitFor();
  const delivered = page.waitForResponse('**/api/kyc/id'); releaseDocument(); await (await delivered).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('button', { name: 'Signed', exact: true }).count(), 0);
  assert.equal(await bank.isDisabled(), true, 'late previous-session ID success must not restore credentials');
  assert.equal(await page.getByText('Document hash', { exact: true }).count(), 0, 'no stale identity summary may return even while the wallet is disconnected');
  assert.equal(await page.getByText('Verified', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Submit verification', exact: true, includeHidden: true }).isDisabled(), true);
  assert.equal(issuanceCalls, 1, 'wallet changes must not automatically issue or resume');
  await page.getByRole('button', { name: 'Matching details' }).click();
  await samples.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor(); await sign();
  await emit('disconnect', { message: 'PRIVATE_DISCONNECT_SENTINEL' });
  await page.getByText('Wallet disconnected.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Signed', exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_DISCONNECT_SENTINEL/);
  // Expiration is passive: discard a late document answer and retain the original recovery ID.
  walletLifetime = 1000;
  await page.getByRole('button', { name: 'Matching details' }).click();
  await samples.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor(); await sign();
  const expiryReady = new Promise<void>(resolve => { documentReady = resolve; });
  heldDocument = { ready: documentReady, release: new Promise<void>(resolve => { releaseDocument = resolve; }) };
  await page.getByRole('button', { name: 'Check sample document' }).click(); await expiryReady;
  const callsBeforeExpiry = calls.length;
  await page.getByRole('alert').filter({ hasText: 'Wallet-control session expired or its clock changed.' }).waitFor();
  assert.equal(calls.length, callsBeforeExpiry, 'expiry must not sign, reissue or resume automatically');
  const expiredResponse = page.waitForResponse('**/api/kyc/id'); releaseDocument(); await (await expiredResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('button', { name: 'Signed', exact: true }).count(), 0);
  assert.equal(await page.getByText('Document hash', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Name on the card', { exact: true }).inputValue(), '');
  assert.equal(await page.evaluate(address => sessionStorage.getItem(`proofmark-request:${address}`), wallet), originalRequestId);
  walletLifetime = 30 * 60_000;
  await page.getByRole('button', { name: 'Matching details' }).click();
  await samples.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor(); await sign();
  await page.getByRole('button', { name: 'Load original result', exact: true }).click();
  await page.getByText('synthetic recovered original request', { exact: false }).waitFor();
  assert.equal(recoveryCalls, 2); assert.equal(issuanceCalls, 1);
  const automaticStatus = page.waitForResponse(response => new URL(response.url()).pathname === '/api/kyc/status'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action === undefined);
  await automaticStatus;
  assert.equal(recoveryCalls, 3, 'an open nonterminal result must poll only the read-only request status endpoint');
  await page.getByText('Your credential is ready for the eligible assets listed in your verification record.', { exact: true }).waitFor();
  const beforeReset = calls.length; await page.getByRole('button', { name: 'Reset wallet session', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Wallet-control session reset.' }).waitFor();
  assert.equal(calls.length, beforeReset); assert.equal(await page.getByRole('button', { name: 'Signed', exact: true }).count(), 0);
  assert.equal(await page.evaluate(address => sessionStorage.getItem(`proofmark-request:${address}`), wallet), originalRequestId);
  assert.deepEqual(errors, []);
  mode = 'mixed'; await page.reload(); await page.getByText('Sample profiles are unavailable.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Matching details' }).count(), 0);
  assert.equal(await page.locator('input[type=file]').isDisabled(), true, 'no upload before a wallet flow');
  // Only synthetic wallet/config responses: no institution request, upload or real account.
  mode = 'live'; await page.reload(); await page.getByRole('group', { name: 'Document', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  await sign();
  const resident = page.getByRole('radio', { name: 'Resident card', exact: true });
  const licence = page.getByRole('radio', { name: 'Driver licence', exact: true });
  await resident.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await licence.isChecked(), true); assert.equal(await licence.evaluate(el => el === document.activeElement), true);
  await page.getByLabel('Licence number', { exact: false }).waitFor();
  assert.ok(await licence.evaluate(el => getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) >= 2));
  await page.getByRole('group', { name: 'Document', exact: true }).screenshot({ path: join(screenshots, 'keyboard-document.png') });
  await page.keyboard.press('ArrowLeft'); assert.equal(await resident.isChecked(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('input[type=file]').evaluate(el => el === document.activeElement), true);
  assert.ok(await page.locator('input[type=file]').evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
  assert.equal(await page.getByRole('tablist').count(), 0);
  console.log(`Synthetic accessibility screenshots: ${screenshots}`);
  assert.deepEqual(errors, []);
  // Separate browser contexts control their own clock before any application timer exists.
  // Never wait two wall-clock minutes or alter production timeout configuration for the test.
  mode = 'demo';
  for (const scenario of ['eth_requestAccounts', 'eth_accounts', 'personal_sign', 'stop'] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); t.after(() => context.close());
    const waitingPage = await context.newPage(); const waitingErrors: string[] = []; waitingPage.on('pageerror', e => waitingErrors.push(e.message));
    await waitingPage.clock.install();
    const blocked = scenario === 'stop' ? 'personal_sign' : scenario;
    await waitingPage.addInitScript(({ blocked, wallet }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>(); let released = false;
      const w = window as unknown as { ethereum: unknown; pendingWalletKind?: string; releasePendingWallet?: () => void };
      w.ethereum = {
        on(event: string, fn: (value: unknown) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
        removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
        async request(args: { method: string }) {
          const result = args.method === 'personal_sign' ? 'synthetic-wallet-signature' : [wallet];
          if (args.method === blocked && !released) {
            w.pendingWalletKind = blocked;
            return new Promise(resolve => { w.releasePendingWallet = () => { released = true; resolve(result); }; });
          }
          return result;
        },
      };
    }, { blocked, wallet });
    let posted = 0;
    await waitingPage.route('**/*', async route => {
      const request = route.request(), url = request.url();
      if (!url.startsWith(base)) return route.abort();
      if (!url.startsWith(base + '/api/')) return route.continue();
      const path = new URL(url).pathname;
      const reply = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/kyc/status') return reply(cfg());
      assert.equal(path, '/api/kyc/wallet', 'waiting must not invoke ID, bank or issuance');
      if (request.method() === 'GET') return reply({ message: 'synthetic challenge', token: 'synthetic-token' });
      posted++; const serverTime = Date.now();
      return reply({ address: wallet, walletProof: 'synthetic-proof', requestId: walletRequestId,
        serverTime, walletExpiresAt: serverTime + 1800000 });
    });
    await waitingPage.goto(base + '/verify/sandbox');
    await waitingPage.getByRole('button', { name: 'Matching details' }).click();
    await waitingPage.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor();
    await waitingPage.getByRole('checkbox').check(); await waitingPage.getByRole('button', { name: 'Connect and sign', exact: true }).click();
    await waitingPage.waitForFunction(() => !!(window as unknown as { pendingWalletKind?: string }).pendingWalletKind);
    if (scenario === 'stop') await waitingPage.getByRole('button', { name: 'Stop waiting', exact: true }).click();
    else await waitingPage.clock.fastForward(scenario === 'eth_accounts' ? 10001 : 120001);
    const notice = scenario === 'stop' ? 'Stopped waiting for the wallet.' : 'Wallet did not respond in time.';
    await waitingPage.getByRole('alert').filter({ hasText: notice }).waitFor();
    assert.equal(await waitingPage.getByRole('button', { name: 'Waiting for the wallet…', exact: true }).count(), 0);
    assert.equal(await waitingPage.getByRole('checkbox').isChecked(), false); assert.equal(posted, 0);
    await waitingPage.evaluate(() => (window as unknown as { releasePendingWallet: () => void }).releasePendingWallet());
    await waitingPage.clock.runFor(50);
    if (scenario === 'stop') await waitingPage.clock.fastForward(120001);
    assert.equal(posted, 0, 'late permission/account/signature must not reach wallet verification');
    assert.equal(await waitingPage.getByRole('button', { name: 'Signed', exact: true }).count(), 0);
    await waitingPage.getByRole('alert').filter({ hasText: notice }).waitFor();
    // Only an explicit new sample/consent/connect may ask the now-responsive wallet again.
    await waitingPage.getByRole('button', { name: 'Matching details' }).click();
    await waitingPage.getByRole('status').filter({ hasText: 'Profile loaded.' }).waitFor();
    await waitingPage.getByRole('checkbox').check(); await waitingPage.getByRole('button', { name: 'Connect and sign', exact: true }).click();
    await waitingPage.getByRole('button', { name: 'Signed', exact: true }).waitFor(); assert.equal(posted, 1);
    assert.deepEqual(waitingErrors, []); await context.close();
  }
});
