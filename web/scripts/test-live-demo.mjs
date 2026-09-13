#!/usr/bin/env node
/**
 * Production smoke for every public Proofmark demo surface.
 *
 * Read-only by default. --provider-session creates one disposable Sumsub Sandbox session and
 * launches the hosted SDK, but submits no document and cannot issue a Proofmark credential.
 */
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const providerSession = args.includes('--provider-session');
const guidedKyc = args.includes('--guided-kyc');
const positional = args.filter(value => !value.startsWith('--'));
if (positional.length !== 1) {
  console.error('usage: node web/scripts/test-live-demo.mjs <https-origin> [--provider-session] [--guided-kyc]');
  process.exit(2);
}
const BASE = positional[0].replace(/\/+$/, '');
let origin;
try { origin = new URL(BASE); } catch { console.error('invalid base URL'); process.exit(2); }
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
  console.error('base URL must be an HTTPS origin without credentials, query, hash or path');
  process.exit(2);
}

const failures = [];
const blocked = [];
let passes = 0;
const pass = (name, detail = '') => { passes++; console.log(`PASS     ${name}${detail ? `: ${detail}` : ''}`); };
const fail = (name, error) => { const detail = error instanceof Error ? error.message : String(error); failures.push({ name, detail }); console.log(`FAIL     ${name}: ${detail}`); };
const block = (name, detail) => { blocked.push({ name, detail }); console.log(`BLOCKED  ${name}: ${detail}`); };
async function check(name, action) {
  try { const detail = await action(); pass(name, detail); } catch (error) { fail(name, error); }
}
async function response(path, init = {}) {
  return fetch(`${BASE}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000), ...init });
}
async function json(path, init = {}) {
  const result = await response(path, init);
  const body = await result.json().catch(() => null);
  return { result, body };
}
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const trainingCases = [
  ['full-match', 'BLOCK'],
  ['name-only', 'REVIEW'],
  ['dob-conflict', 'REVIEW'],
  ['no-match', 'ALLOW'],
];
const screeningCases = [
  ['Name and birth date', 'BLOCK', { fullName: 'Kim Jong Un', dateOfBirth: '1984-01-08', nationality: 'KP', residence: 'KP', walletAddress: '' }],
  ['Similar name', 'REVIEW', { fullName: 'Choi Yeong-ho', dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '' }],
  ['Listed wallet', 'BLOCK', { fullName: 'Totally Unrelated Person', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US', walletAddress: '0x252a8bd2319d8a555b872990601221b3a2053bce' }],
  ['Name search', 'ALLOW', { fullName: 'Park Seo-jun', dateOfBirth: '1990-05-05', nationality: 'KR', residence: 'KR', walletAddress: '' }],
];
const control = '0x00000000000000000000000000000000DeaDBeef';

console.log(`Live demo target: ${BASE}`);
console.log(`Provider session: ${providerSession ? 'enabled; creates one disposable sandbox session' : 'disabled; read-only run'}`);
console.log(`Guided KYC: ${guidedKyc ? 'enabled; creates one disposable Sepolia test issuance' : 'disabled; no issuance'}`);
console.log('');

let liveChain;
let kycStatus;
let providerStatus;

await check('public pages', async () => {
  for (const path of ['/', '/demo', '/screening', '/onchain', '/verify', '/verify/provider']) {
    const result = await response(path);
    assert.equal(result.status, 200, `${path} returned ${result.status}`);
    assert.match(result.headers.get('content-type') ?? '', /^text\/html/);
  }
  return '6/6 pages returned HTML 200';
});

for (const [scenario, expected] of trainingCases) {
  await check(`education ${scenario}`, async () => {
    const { result, body } = await json('/api/demo/screen', post({ scenario }));
    assert.equal(result.status, 200);
    assert.ok(object(body));
    assert.equal(body.scenario, scenario);
    assert.equal(body.trainingDecision, expected);
    assert.equal(body.scope, 'synthetic-training-only');
    assert.equal(body.officialListsChecked, false);
    assert.equal(body.eligibleForIssuance, false);
    assert.equal(body.credentialCreated, false);
    return expected;
  });
}

await check('education input boundary', async () => {
  for (const body of [{ scenario: 'unknown' }, { scenario: 'full-match', fullName: 'not accepted' }]) {
    const result = await response('/api/demo/screen', post(body));
    assert.equal(result.status, 400);
  }
  const result = await response('/api/demo/screen', { ...post({ scenario: 'full-match' }), headers: { 'content-type': 'application/json', origin: 'https://invalid.example' } });
  assert.equal(result.status, 403);
  return 'unknown, extra personal field and cross-origin requests were rejected';
});

await check('on-chain issued wallet', async () => {
  const { result, body } = await json('/api/onchain');
  assert.equal(result.status, 200);
  assert.ok(object(body) && object(body.mark) && object(body.registry) && object(body.epoch));
  assert.equal(body.mark.status, 1);
  assert.equal(body.tombstone, false);
  assert.equal(body.epoch.fresh, true);
  assert.equal(body.policies?.length, 2);
  assert.ok(body.policies.every(policy => ['consistent', 'unavailable', 'unexplained'].includes(policy.diagnosis)));
  liveChain = body;
  return `block ${body.blockNumber}; policy diagnoses ${body.policies.map(policy => policy.diagnosis).join(', ')}`;
});

await check('on-chain unverified control', async () => {
  const { result, body } = await json(`/api/onchain?subject=${control}`);
  assert.equal(result.status, 200);
  assert.equal(body.subject.toLowerCase(), control.toLowerCase());
  assert.equal(body.mark.status, 0);
  assert.equal(body.tombstone, false);
  assert.ok(body.policies.every(policy => policy.verified === false));
  return 'no credential and both registry booleans false';
});

await check('on-chain invalid input', async () => {
  const { result, body } = await json('/api/onchain?subject=invalid');
  assert.equal(result.status, 400);
  assert.equal(body.error, 'Invalid subject address');
  return 'invalid address rejected';
});

await check('screening metadata', async () => {
  const { result, body } = await json('/api/screen');
  assert.equal(result.status, 200);
  assert.ok(object(body?.listCounts));
  assert.deepEqual(Object.keys(body.listCounts).sort(), ['EU_FSF', 'OFAC_SDN', 'UN_CONSOLIDATED']);
  assert.ok(Object.values(body.listCounts).every(count => Number.isSafeInteger(count) && count > 0));
  return `${Object.values(body.listCounts).reduce((sum, count) => sum + count, 0).toLocaleString()} records loaded`;
});

for (const [name, expected, payload] of screeningCases) {
  await check(`screening ${name}`, async () => {
    const { result, body } = await json('/api/screen', post(payload));
    assert.equal(result.status, 200);
    assert.equal(body.decision, expected);
    assert.match(body.evidenceDigest, /^0x[0-9a-f]{64}$/i);
    assert.ok(Array.isArray(body.hits));
    if (name === 'Listed wallet') assert.equal(body.hits[0]?.matchType, 'wallet');
    return `${expected}; ${body.hits.length} potential match(es)`;
  });
}

await check('screening input boundary', async () => {
  assert.equal((await response('/api/screen', post({ fullName: '' }))).status, 400);
  assert.equal((await response('/api/screen', post({ fullName: 'Sample', nationality: 410 }))).status, 400);
  assert.equal((await response('/api/screen', { ...post({ fullName: 'Sample' }), headers: { 'content-type': 'application/json', origin: 'https://invalid.example' } })).status, 403);
  return 'missing name, non-string field and cross-origin requests were rejected';
});

await check('verification configuration', async () => {
  const { result, body } = await json('/api/kyc/status');
  assert.equal(result.status, 200);
  assert.ok(object(body));
  kycStatus = body;
  return `demo=${body.demo}; id=${body.id?.vendor ?? 'unconfigured'}; bank=${body.bank?.vendor ?? 'unconfigured'}`;
});

await check('Sumsub configuration', async () => {
  const { result, body } = await json('/api/providers/sumsub/status');
  assert.equal(result.status, 200);
  assert.ok(object(body));
  assert.equal(body.mode, 'evidence-candidate-only');
  providerStatus = body;
  assert.equal(body.configured, true);
  assert.equal(body.environment, 'sandbox');
  assert.equal(body.testOnly, true);
  assert.equal(body.issuanceBridge, false);
  return 'sandbox evidence-only mode is configured';
});

const browser = await chromium.launch({ headless: true });
try {
  await check('browser education journey', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); const calls = []; const errors = [];
    page.on('request', request => { if (request.url().startsWith(`${BASE}/api/`)) calls.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { Object.defineProperty(window, 'ethereum', { get() { throw new Error('wallet-free demo accessed a wallet'); } }); });
    await page.goto(`${BASE}/demo`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    assert.equal(calls.length, 0, 'the initial page made an API call');
    await page.getByRole('button', { name: 'Start demo', exact: true }).click();
    await page.locator('[data-demo-chain="loaded"]').waitFor();
    for (const [scenario, expected] of trainingCases) {
      const label = { 'full-match': 'Full identity match', 'name-only': 'Name only', 'dob-conflict': 'Different birth date', 'no-match': 'No match' }[scenario];
      if (scenario !== 'full-match') await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      await page.locator(`[data-demo-training="${expected}"]`).waitFor();
    }
    const policyCards = page.locator('[data-demo-policy]');
    assert.equal(await policyCards.count(), 2);
    for (const policy of liveChain.policies) {
      const expected = policy.diagnosis === 'consistent' ? policy.verified ? 'PASS' : 'FAIL' : `CHAIN ${policy.verified ? 'TRUE' : 'FALSE'}`;
      assert.equal(await page.locator(`[data-demo-policy="${policy.id}"]`).getAttribute('data-demo-verdict'), expected);
    }
    assert.equal(await page.getByText('The sample could not be checked. Please try again.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('The credential could not be retrieved. Please try again.', { exact: true }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    await context.close();
    return '4 scenarios, live credential and 2 policy cards rendered at 390px';
  });

  await check('browser screening presets', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const metadata = page.waitForResponse(result => result.request().method() === 'GET' && new URL(result.url()).pathname === '/api/screen');
    await page.goto(`${BASE}/screening`, { waitUntil: 'domcontentloaded' });
    assert.equal((await metadata).status(), 200);
    await page.locator('details').filter({ has: page.locator('summary', { hasText: 'Use an example' }) }).locator('summary').click();
    for (const [name, expected] of screeningCases) {
      await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await page.locator(`[data-screening-decision="${expected}"]`).waitFor();
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    await context.close();
    return '4 production-list presets rendered with expected decisions at 390px';
  });

  await check('browser wallet lookup', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}/onchain`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Credential on file', exact: true }).waitFor();
    await page.getByRole('link', { name: /Unverified wallet/ }).click();
    await page.getByRole('heading', { name: 'No credential found', exact: true }).waitFor();
    assert.equal(await page.locator('[data-result="FAIL"]').count(), 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    await context.close();
    return 'issued and unverified sample wallets rendered at 390px';
  });

  await check('browser verification availability', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${BASE}/verify`, { waitUntil: 'domcontentloaded' });
    if (kycStatus.demo && kycStatus.id?.demo && kycStatus.bank?.demo) {
      await page.getByRole('button', { name: /^Matching details/ }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^Matching details/ }).count(), 1);
    } else {
      await page.getByText('Identity verification is temporarily unavailable. Please try again later.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Matching details', exact: true }).count(), 0);
    }
    await page.close();
    return kycStatus.demo ? 'synthetic profiles are visible' : 'unavailable state is rendered without accepting sample data';
  });

  const guidedCase = async (label, expected) => {
    const wallet = Wallet.createRandom();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); const errors = [];
    page.setDefaultTimeout(45_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__proofmarkGuidedSign', async hexMessage => wallet.signMessage(Buffer.from(hexMessage.slice(2), 'hex')));
    await page.addInitScript(address => {
      const listeners = new Map();
      window.ethereum = {
        on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); },
        removeListener(event, listener) { listeners.get(event)?.delete(listener); },
        async request(request) {
          if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [address];
          if (request.method === 'personal_sign') return window.__proofmarkGuidedSign(request.params[0]);
          throw new Error(`unsupported disposable wallet method ${request.method}`);
        },
      };
    }, wallet.address);
    try {
      await page.goto(`${BASE}/verify`, { waitUntil: 'domcontentloaded' });
      const sampleButton = page.getByRole('button', { name: new RegExp(`^${label}`) });
      await sampleButton.click();
      await page.getByRole('button', { name: new RegExp(`^${label}`), pressed: true }).waitFor();
      const walletStep = page.getByRole('region', { name: 'Connect your wallet', exact: true });
      await walletStep.getByRole('checkbox').check();
      await walletStep.getByRole('button', { name: 'Connect and sign', exact: true }).click();
      await walletStep.getByText('Connected', { exact: true }).waitFor();
      await page.getByRole('img', { name: 'Synthetic training sample — not an identity document', exact: true }).waitFor();

      const idReply = page.waitForResponse(result => result.request().method() === 'POST'
        && new URL(result.url()).pathname === '/api/kyc/id');
      await page.getByRole('button', { name: 'Check sample document', exact: true }).click();
      const idResponse = await idReply; const idBody = await idResponse.json();
      assert.equal(idResponse.status(), 200);
      if (expected === 'document-rejected') {
        assert.equal(idBody.status, 'rejected');
        await page.getByText('This document could not be verified.', { exact: false }).waitFor();
        assert.deepEqual(errors, []);
        return 'document rejection rendered from the production API';
      }
      assert.equal(idBody.status, 'verified');
      await page.getByText('Verified', { exact: true }).first().waitFor();

      const bankReply = page.waitForResponse(result => result.request().method() === 'POST'
        && new URL(result.url()).pathname === '/api/kyc/bank');
      await page.getByRole('button', { name: 'Check sample account', exact: true }).click();
      const bankResponse = await bankReply; const bankBody = await bankResponse.json();
      if (expected === 'holder-mismatch') {
        assert.equal(bankResponse.status(), 422);
        assert.equal(bankBody.code, 'HOLDER_MISMATCH');
        await page.getByText('The bank account holder does not match the declared identity.', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        return 'account-holder mismatch rendered from the production API';
      }
      assert.equal(bankResponse.status(), 200);
      assert.match(bankBody.demoCode, /^\d{4}$/);
      await page.getByLabel(/^Code/).fill(bankBody.demoCode);
      const confirmReply = page.waitForResponse(result => result.request().method() === 'POST'
        && new URL(result.url()).pathname === '/api/kyc/bank');
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      assert.equal((await confirmReply).status(), 200);
      await page.getByText('Sample checked', { exact: true }).waitFor();

      const issueReply = page.waitForResponse(result => result.request().method() === 'POST'
        && new URL(result.url()).pathname === '/api/kyc/issue', { timeout: 120_000 });
      await page.getByRole('button', { name: 'Submit verification', exact: true }).click();
      let issueResponse = await issueReply; let issueBody = await issueResponse.json();
      for (let attempt = 0; attempt < 3 && issueResponse.status() === 200
        && issueBody.issuance?.phase === 'prepared' && !issueBody.onchain?.txHash; attempt++) {
        const resumeReply = page.waitForResponse(result => result.request().method() === 'POST'
          && new URL(result.url()).pathname === '/api/kyc/issue', { timeout: 120_000 });
        await page.getByRole('button', { name: 'Resume original request', exact: true }).click();
        issueResponse = await resumeReply;
        issueBody = await issueResponse.json();
      }
      for (let attempt = 0; attempt < 12 && issueResponse.status() === 200
        && issueBody.issuance?.phase === 'submitted'; attempt++) {
        await page.waitForTimeout(10_000);
        const resumeReply = page.waitForResponse(result => result.request().method() === 'POST'
          && new URL(result.url()).pathname === '/api/kyc/issue', { timeout: 120_000 });
        await page.getByRole('button', { name: 'Resume original request', exact: true }).click();
        issueResponse = await resumeReply;
        issueBody = await issueResponse.json();
      }
      assert.equal(issueResponse.status(), 200,
        `issuance HTTP ${issueResponse.status()}; code=${issueBody.code ?? issueBody.error ?? 'none'}; resumable=${String(issueBody.resumable)}`);
      assert.match(issueBody.requestId, /^0x[0-9a-f]{64}$/i);
      assert.match(issueBody.onchain?.txHash, /^0x[0-9a-f]{64}$/i,
        `issuance phase=${issueBody.issuance?.phase ?? 'missing'}; status=${issueBody.status ?? 'missing'}; sent=${String(issueBody.onchain?.sent)}; error=${issueBody.reason ?? issueBody.issuance?.lastError ?? 'none'}`);
      assert.equal(issueBody.onchain?.sent, true);
      assert.ok(['source-confirmed', 'materialized'].includes(issueBody.issuance?.phase));
      assert.deepEqual(errors, []);
      return `${issueBody.issuance.phase}; Sepolia transaction ${issueBody.onchain.txHash}`;
    } finally { await context.close(); }
  };

  if (guidedKyc && kycStatus?.demo && kycStatus.id?.demo && kycStatus.bank?.demo) {
    await check('guided KYC rejected document', () => guidedCase('Rejected document', 'document-rejected'));
    await check('guided KYC account mismatch', () => guidedCase('Account mismatch', 'holder-mismatch'));
    await check('guided KYC matching details', () => guidedCase('Matching details', 'success'));
  } else if (!guidedKyc) {
    block('guided KYC production cases', 'rerun with --guided-kyc to execute all three cases and create one testnet issuance');
  }

  if (providerSession && providerStatus?.configured) {
    await check('browser Sumsub sandbox session', async () => {
      const wallet = Wallet.createRandom();
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage(); const errors = []; const apiTrace = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', result => {
        const url = new URL(result.url());
        if (url.origin === BASE && url.pathname.startsWith('/api/providers/sumsub/')) {
          apiTrace.push(`${result.request().method()} ${url.pathname} ${result.status()}`);
        }
      });
      await page.exposeFunction('__proofmarkSign', async hexMessage => wallet.signMessage(Buffer.from(hexMessage.slice(2), 'hex')));
      await page.addInitScript(address => {
        const listeners = new Map();
        window.ethereum = {
          on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); },
          removeListener(event, listener) { listeners.get(event)?.delete(listener); },
          async request(request) {
            if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [address];
            if (request.method === 'personal_sign') return window.__proofmarkSign(request.params[0]);
            throw new Error(`unsupported disposable wallet method ${request.method}`);
          },
        };
      }, wallet.address);
      await page.goto(`${BASE}/verify/provider`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
      const consent = page.locator('[data-provider-consent]');
      await consent.waitFor();
      assert.match(await consent.innerText(), /Sumsub Sandbox integration test only/);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Sign and continue', exact: true }).click();
      try {
        await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor({ timeout: 45_000 });
        await page.locator('#sumsub-websdk-container iframe').first().waitFor({ timeout: 45_000 });
      } catch {
        const safeStatus = (await page.locator('[role="status"]').innerText()).trim();
        throw new Error(`provider launch did not finish; ${apiTrace.join(', ') || 'no provider API response'}${safeStatus ? `; ${safeStatus}` : ''}`);
      }
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return text.includes('Ready to verify') || text.includes('Current provider status is unavailable. No approval or eligibility is confirmed.');
      }, undefined, { timeout: 30_000 });
      const pageText = await page.locator('body').innerText();
      assert.match(await page.locator('body').innerText(), /does not currently issue a Proofmark credential/);
      assert.deepEqual(errors, []);
      await context.close();
      return pageText.includes('Ready to verify')
        ? 'wallet consent, real API token, hosted SDK and not-started status succeeded'
        : 'wallet consent, real API token and hosted SDK succeeded; pre-applicant status failed closed';
    });
  } else if (!providerSession) {
    block('browser Sumsub sandbox session', 'rerun with --provider-session to create one disposable provider session');
  }
} finally {
  await browser.close();
}

if (!(kycStatus?.demo && kycStatus.id?.demo && kycStatus.bank?.demo)) {
  const reason = `KYC_DEMO=${String(kycStatus?.demo)}; id=${kycStatus?.id?.vendor ?? 'unconfigured'}; bank=${kycStatus?.bank?.vendor ?? 'unconfigured'}`;
  block('guided KYC matching details', reason);
  block('guided KYC rejected document', reason);
  block('guided KYC account mismatch', reason);
}

console.log('');
console.log(`Summary: ${passes} passed, ${failures.length} failed, ${blocked.length} blocked.`);
if (failures.length) process.exitCode = 1;
else if (blocked.length) process.exitCode = 2;
