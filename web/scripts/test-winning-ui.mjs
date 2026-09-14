/** Production-build browser smoke for the wallet-free demo and provider boundary. All evidence is intercepted fixture data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const SOURCE = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'44'.repeat(32)}`;
const NOTICE = `Proofmark provider verification fixture\n\nProcessing: hosted identity review\nRetention: fixture policy v1\nWallet: ${ADDRESS}`;

function trainingFixture(scenario = 'full-match') {
  return {
    schema: 'proofmark-synthetic-screening/v1', scope: 'synthetic-training-only', scenario,
    dataset: { label: 'Fictional training corpus — not an official sanctions list', sha256: 'a'.repeat(64), entries: 1 },
    subject: { name: 'Zorvax Quenlith', dateOfBirth: '2000-01-01', nationality: 'KR' },
    fixture: { name: 'Zorvax Quenlith', datesOfBirth: ['2000-01-01'], nationalities: ['KR'] },
    trainingDecision: 'BLOCK', explanation: 'A fictional full identity match reached the training block rule.',
    comparisons: [{ score: 1, dateOfBirth: 'match', nationality: 'match' }], engineVersion: 'fixture-engine', executedAt: 1_700_000_000_000,
    officialListsChecked: false, eligibleForIssuance: false, credentialCreated: false,
  };
}

function policy(id, overrides = {}) {
  return {
    id, name: id === 1 ? 'KR VASP production' : 'KR sandbox pilot', verified: id === 2,
    frozen: true, requireRoster: id === 2, requireAll: 0x90025, minAssurance: 2,
    requiredRegime: id, maxAge: id === 1 ? 86_400 : 604_800,
    diagnosis: 'consistent', reasonCodes: id === 1 ? ['WRONG_REGIME'] : [], decisionMark: { methods: 0x90025 },
    ...overrides,
  };
}

function chainFixture() {
  return {
    subject: ADDRESS, blockNumber: 1_234_567, tombstone: false,
    observation: { blockHash: HASH, timestamp: 1_700_000_000 },
    mark: { methods: 0x90025, methodsHex: '0x90025', status: 1, regime: 2, assurance: 2, jurisdiction: 410, origin: 2 },
    asc: { sourceContract: SOURCE, expectedChainKey: 1 },
    epoch: { fresh: true, latestEpoch: 2, validUntil: 1_800_000_000 },
    policies: [policy(1), policy(2)],
  };
}

async function startProduction(t) {
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd, stdio: 'ignore' });
  t.after(async () => { if (app.exitCode === null) { app.kill('SIGTERM'); await new Promise(resolve => app.once('exit', resolve)); } });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(base + '/demo')).ok) break; throw new Error('not ready'); }
    catch { if (app.exitCode !== null || attempt >= 100) throw new Error('built Next application did not start'); await delay(100); }
  }
  return base;
}

test('winning UI fails closed and keeps provider approval separate from eligibility', { timeout: 60_000 }, async t => {
  const base = await startProduction(t);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());

  // Demo: no automatic API call, no wallet access, explicit unavailable/malformed states, then one credential/two policies.
  const demoContext = await browser.newContext({ viewport: { width: 390, height: 844 } }); t.after(() => demoContext.close());
  const demoPage = await demoContext.newPage(); const demoErrors = []; const demoCalls = [];
  demoPage.on('pageerror', error => demoErrors.push(error.message));
  await demoPage.addInitScript({ content: `Object.defineProperty(window, 'ethereum', { get() { throw new Error('wallet-free demo accessed a wallet'); } });` });
  let demoMode = 'unavailable';
  await demoPage.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (!url.startsWith(base)) return route.abort();
    if (!url.startsWith(base + '/api/')) return route.continue();
    const path = new URL(url).pathname; demoCalls.push(path);
    if (path === '/api/demo/screen') {
      const scenario = request.postDataJSON().scenario;
      if (demoMode === 'unavailable') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(trainingFixture(scenario)) });
    }
    if (path === '/api/onchain') {
      if (demoMode === 'unavailable') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      if (demoMode === 'malformed') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ policies: [{ verified: true }] }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(chainFixture()) });
    }
    throw new Error(`unexpected demo API ${path}`);
  });
  await demoPage.goto(base + '/demo');
  assert.match(await demoPage.getByRole('heading', { level: 1 }).innerText(), /Explore Proofmark/i);
  assert.deepEqual(demoCalls, [], 'first render must not call screening, chain, wallet or provider APIs');
  assert.match(await demoPage.locator('body').innerText(), /No wallet connection needed/);
  assert.match(await demoPage.locator('body').innerText(), /Demo uses sample identities and a separate testnet credential/);
  assert.match(await demoPage.locator('body').innerText(), /does not verify your identity or grant access/);
  await demoPage.getByRole('button', { name: 'Start demo', exact: true }).click();
  await demoPage.getByText('The credential could not be retrieved. Please try again.', { exact: true }).waitFor();
  assert.equal(await demoPage.locator('[data-demo-policy]').count(), 0);

  demoMode = 'malformed'; await demoPage.getByRole('button', { name: 'Try again', exact: true }).click();
  await demoPage.locator('[data-demo-training="BLOCK"]').waitFor();
  await demoPage.getByText('The credential could not be retrieved. Please try again.', { exact: true }).waitFor();
  assert.equal(await demoPage.locator('[data-demo-policy]').count(), 0, 'malformed 200 must not paint a verdict');
  assert.match(await demoPage.locator('[data-demo-training]').innerText(), /Sample screening/);
  assert.match(await demoPage.locator('body').innerText(), /does not verify your identity or grant access/);

  demoMode = 'fixture'; await demoPage.getByRole('button', { name: 'Try again', exact: true }).click();
  await demoPage.locator('[data-demo-chain="loaded"]').waitFor();
  assert.equal(await demoPage.locator('[data-demo-policy]').count(), 2);
  assert.equal(await demoPage.locator('[data-demo-policy="1"]').getAttribute('data-demo-verdict'), 'FAIL');
  assert.equal(await demoPage.locator('[data-demo-policy="2"]').getAttribute('data-demo-verdict'), 'PASS');
  assert.match(await demoPage.locator('[data-demo-policy="1"]').innerText(), /Production access requires verification through an approved production provider/i);
  assert.match(await demoPage.locator('[data-demo-policy="1"]').innerText(), /Not eligible/);
  assert.match(await demoPage.locator('[data-demo-policy="2"]').innerText(), /Eligible/);
  const networkDetails = demoPage.locator('details').filter({ has: demoPage.locator('summary', { hasText: 'Network details' }) });
  assert.equal(await networkDetails.getAttribute('open'), null, 'network diagnostics must be collapsed initially');
  await networkDetails.locator('summary').click();
  assert.match(await networkDetails.innerText(), /No application transaction was submitted/);
  await networkDetails.locator('summary').click();
  assert.ok(await demoPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'demo must not overflow at 390px');
  assert.deepEqual(demoErrors, []);

  const homePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await homePage.goto(base);
  const verificationCard = homePage.locator('.verification-start');
  await verificationCard.getByText('Global verification', { exact: true }).waitFor();
  assert.equal(await verificationCard.getByText('South Korea', { exact: true }).count(), 0);
  assert.equal(await verificationCard.getByRole('link', { name: 'Start verification', exact: true }).getAttribute('href'), '/verify/provider');
  await homePage.close();

  // Screening: unavailable metadata must leave a usable form; malformed verdicts cannot appear as successful results.
  const screeningPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const screeningErrors = []; let metadataMode = 'unavailable', screeningMode = 'malformed';
  screeningPage.on('pageerror', error => screeningErrors.push(error.message));
  await screeningPage.route('**/api/screen', route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: metadataMode === 'unavailable' ? 503 : 200,
      contentType: 'application/json', body: JSON.stringify({ error: 'internal-screening-detail', listCounts: null }) });
    if (screeningMode === 'unavailable') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"internal-screening-detail"}' });
    if (screeningMode === 'malformed') return route.fulfill({ contentType: 'application/json', body: '{"decision":"ALLOW"}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      decision: 'ALLOW', reviewReason: null, riskBand: 0, hits: [], methodsHex: '0x1', evidenceDigest: HASH, elapsedMs: 8,
      engineVersion: 'fixture-engine', listVersions: { OFAC_SDN: 1 }, listCounts: { OFAC_SDN: 12 },
      methodGroups: [{ group: 'Performed checks', note: '', items: [{ key: 'SANCTIONS_SCREENED', label: 'Sanctions lists', set: true }] }],
    }) });
  });
  for (const mode of ['unavailable', 'malformed']) {
    metadataMode = mode;
    await screeningPage.goto(base + '/screening');
    await screeningPage.getByRole('heading', { name: 'Sanctions screening', exact: true }).waitFor();
    assert.equal(await screeningPage.getByRole('button', { name: 'Run screening', exact: true }).isDisabled(), true);
    assert.doesNotMatch(await screeningPage.locator('body').innerText(), /internal-screening-detail|\d+ records/);
  }
  const screen = screeningPage.getByRole('button', { name: 'Run screening', exact: true });
  const screeningAlert = screeningPage.locator('form').getByRole('alert');
  await screeningPage.getByLabel('Wallet address', { exact: false }).fill(ADDRESS);
  assert.equal(await screen.isDisabled(), true, 'a wallet without a full name must not submit');
  await screeningPage.getByLabel('Full name', { exact: false }).fill('Sample Person');
  await screeningPage.getByLabel('Nationality', { exact: false }).fill('kr');
  assert.equal(await screeningPage.getByLabel('Nationality', { exact: false }).inputValue(), 'KR');
  await screeningPage.getByLabel('Full name', { exact: false }).press('Enter');
  await screeningAlert.waitFor();
  assert.equal(await screeningPage.locator('[data-screening-decision]').count(), 0, 'malformed 200 must not display an ALLOW result');
  assert.match(await screeningAlert.innerText(), /Screening could not be completed/);
  screeningMode = 'valid'; await screen.click();
  await screeningPage.locator('[data-screening-decision="ALLOW"]').waitFor();
  assert.match(await screeningPage.locator('body').innerText(), /12 records/);
  const screeningDetails = screeningPage.locator('details').filter({ has: screeningPage.locator('summary', { hasText: 'Screening details' }) });
  assert.equal(await screeningDetails.getAttribute('open'), null);
  screeningMode = 'unavailable'; await screen.click();
  await screeningAlert.waitFor();
  assert.equal(await screeningPage.locator('[data-screening-decision]').count(), 0, 'a failed retry must clear the previous successful result');
  assert.doesNotMatch(await screeningPage.locator('body').innerText(), /internal-screening-detail/);
  assert.ok(await screeningPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'screening must not overflow at 390px');
  assert.deepEqual(screeningErrors, []);
  await screeningPage.close();

  const verificationEntry = await fetch(base + '/verify', { redirect: 'manual' });
  assert.equal(verificationEntry.status, 307);
  assert.equal(new URL(verificationEntry.headers.get('location'), base).pathname, '/verify/provider');

  // Provider unavailable: readiness check only, no external SDK fetch and no fallback success.
  const unavailablePage = await browser.newPage(); const unavailableExternal = [];
  await unavailablePage.route('**/*', route => {
    const url = route.request().url();
    if (url === base + '/api/providers/sumsub/status') return route.fulfill({ contentType: 'application/json', body: '{"configured":false,"mode":"evidence-candidate-only"}' });
    if (!url.startsWith(base)) { unavailableExternal.push(url); return route.abort(); }
    return route.continue();
  });
  const providerResponse = await unavailablePage.goto(base + '/verify/provider');
  await unavailablePage.getByRole('heading', { name: 'Verification is temporarily unavailable' }).waitFor();
  assert.deepEqual(unavailableExternal, [], 'unconfigured provider must not request an external SDK');
  assert.equal(await unavailablePage.getByRole('button', { name: 'Connect wallet', exact: true }).count(), 0);
  assert.equal(await unavailablePage.locator('#sumsub-websdk-container').count(), 0, 'unconfigured provider must not start a verification session');
  assert.match(await unavailablePage.locator('body').innerText(), /does not currently issue a Proofmark credential or enable asset access/);
  assert.match(providerResponse.headers()['content-security-policy'], /https:\/\/static\.sumsub\.com/);
  assert.match(providerResponse.headers()['permissions-policy'], /camera=\(self "https:\/\/api\.sumsub\.com"\)/);
  await unavailablePage.close();

  // Configured fixture: exact notice, wallet binding, fake SDK, evidence-only approval and account-change clearing.
  const providerPage = await browser.newPage({ viewport: { width: 390, height: 844 } }); const providerErrors = [], external = [], apiCalls = [];
  providerPage.on('pageerror', error => providerErrors.push(error.message));
  await providerPage.addInitScript({ content: `
    const listeners = new Map(); window.__walletCalls = []; window.__walletRejectOnce = false; window.__sdk = { initialized: 0, launched: 0, destroyed: 0 };
    window.ethereum = {
      on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
      removeListener(event, fn) { listeners.get(event)?.delete(fn); },
      async request(args) { window.__walletCalls.push(args); if (args.method === 'eth_requestAccounts') { if (window.__walletRejectOnce) { window.__walletRejectOnce = false; throw new Error('PRIVATE_WALLET_DIAGNOSTIC'); } window.__emitWallet('accountsChanged', []); return [${JSON.stringify(ADDRESS)}]; } if (args.method === 'eth_accounts') return [${JSON.stringify(ADDRESS)}]; if (args.method === 'personal_sign') return 'fixture-signature'; throw new Error('unexpected wallet request'); }
    };
    window.__emitWallet = (event, value) => { for (const fn of [...(listeners.get(event) || [])]) fn(value); };
    window.snsWebSdk = { init(token) { if (token !== 'fixture-access-token') throw new Error('wrong token'); window.__sdk.initialized++; const builder = {
      withConf() { return builder; }, withOptions() { return builder; }, on() { return builder; },
      build() { return { launch(selector) { window.__sdk.launched++; document.querySelector(selector).dataset.fakeSdk = 'launched'; }, destroy() { window.__sdk.destroyed++; } }; }
    }; return builder; } };
  ` });
  await providerPage.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (!url.startsWith(base)) {
      external.push(url);
      if (url === 'https://static.sumsub.com/idensic/static/sns-websdk-builder.js') return route.fulfill({ contentType: 'application/javascript', body: '/* fixture: window.snsWebSdk already installed */' });
      return route.abort();
    }
    if (!url.startsWith(base + '/api/')) return route.continue();
    const path = new URL(url).pathname; apiCalls.push(`${request.method()} ${path}`);
    const reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'GET' && path === '/api/providers/sumsub/status') return reply({ configured: true, environment: 'sandbox', mode: 'evidence-candidate-only' });
    if (request.method() === 'GET' && path === '/api/providers/sumsub/wallet') return reply({ message: NOTICE, token: 'fixture-challenge' });
    if (request.method() === 'POST' && path === '/api/providers/sumsub/wallet') {
      assert.deepEqual(request.postDataJSON(), { token: 'fixture-challenge', signature: 'fixture-signature' }); const serverTime = Date.now();
      return reply({ address: ADDRESS, walletProof: 'fixture-wallet-proof', serverTime, walletExpiresAt: serverTime + 300_000 });
    }
    if (request.method() === 'POST' && path === '/api/providers/sumsub/token') {
      assert.deepEqual(request.postDataJSON(), { walletProof: 'fixture-wallet-proof' });
      return reply({ accessToken: 'fixture-access-token', providerProof: 'fixture-provider-proof', environment: 'sandbox' });
    }
    if (request.method() === 'POST' && path === '/api/providers/sumsub/status') {
      assert.deepEqual(request.postDataJSON(), { walletProof: 'fixture-wallet-proof', providerProof: 'fixture-provider-proof' });
      return reply({ schema: 'proofmark-sumsub-evidence-v1', provider: 'sumsub', environment: 'sandbox', subject: ADDRESS,
        decision: 'approved', methods: 0, jurisdiction: null, methodMapping: 'pending-step-evidence', observedAt: Date.now() });
    }
    throw new Error(`unexpected provider API ${request.method()} ${path}`);
  });
  await providerPage.goto(base + '/verify/provider');
  await providerPage.evaluate(() => { window.__walletRejectOnce = true; });
  await providerPage.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await providerPage.getByText('Wallet request was declined or unavailable. Review or dismiss any open wallet prompt before reconnecting.', { exact: true }).waitFor();
  assert.doesNotMatch(await providerPage.locator('body').innerText(), /PRIVATE_WALLET_DIAGNOSTIC|Wallet session changed/);
  await providerPage.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  const consent = providerPage.locator('[data-provider-consent]'); await consent.waitFor(); assert.equal(await consent.innerText(), NOTICE);
  const sign = providerPage.getByRole('button', { name: 'Sign and continue', exact: true }); assert.equal(await sign.isDisabled(), true);
  await providerPage.getByRole('checkbox').check(); await sign.click();
  await providerPage.locator('#sumsub-websdk-container[data-fake-sdk="launched"]').waitFor();
  const walletCalls = await providerPage.evaluate(() => window.__walletCalls);
  const signed = walletCalls.find(call => call.method === 'personal_sign'); assert.ok(signed);
  const decoded = Buffer.from(signed.params[0].slice(2), 'hex').toString('utf8'); assert.equal(decoded, NOTICE);
  await providerPage.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await providerPage.getByText('Identity review approved', { exact: true }).waitFor();
  assert.match(await providerPage.locator('body').innerText(), /no asset eligibility is granted/i);
  assert.deepEqual(external, ['https://static.sumsub.com/idensic/static/sns-websdk-builder.js'], 'only the intercepted fake SDK URL may leave origin');
  await providerPage.evaluate(other => window.__emitWallet('accountsChanged', [other]), OTHER_ADDRESS);
  await providerPage.getByText('Wallet account changed or became unavailable.', { exact: true }).waitFor();
  assert.equal(await providerPage.getByText('Identity review approved', { exact: true }).count(), 0);
  assert.equal(await providerPage.getByRole('button', { name: 'Connect wallet', exact: true }).count(), 1);
  assert.equal(await providerPage.evaluate(() => window.__sdk.destroyed), 1);
  assert.ok(apiCalls.includes('POST /api/providers/sumsub/status'));
  assert.deepEqual(providerErrors, []);
});
