import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as portProbe } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../../pipeline/issuance-evm';
import { EvidenceVault } from '../../pipeline/vault';
import { buildSourceRoster } from '../../pipeline/roster-source';
import { rosterApprovalData } from '../../pipeline/roster-authorization';
import { encodeRosterWitness } from '../../pipeline/roster-witness';
import { atomicFile } from '../../aml/snapshot-store';
import { currentGeneration } from '../../aml/loader';
import { readIndex } from '../../aml/index-format';
import { syntheticDriverPng } from '../../deploy/demo-driver-utils.mjs';
import { builtFrontend, browserIssuance } from './browser-issuance-fixture.mjs';

const exec = promisify(execFile), nativeFetch = globalThis.fetch;
const container = process.env.TEST_REDIS_CONTAINER;
if (!container || !/^proofmark-bank-test-[a-zA-Z0-9-]+$/.test(container)) throw new Error('Use npm run test:issuance-e2e');
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));

test('PM-T35-02 real browser/API uses the activated official AML snapshot and two local EVMs through the current witness gate', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'proofmark-local-issuance-e2e-')), cwd = process.cwd();
  t.after(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); });
  for (const name of Object.keys(process.env)) if (/^(CODEF_|OPENBANKING_|BANK_STATE_|ISSUANCE_|ISSUER_|EVIDENCE_|SANCTIONS_|NEXT_PUBLIC_|VERCEL)/.test(name)) delete process.env[name];
  const secret = 'synthetic-local-e2e-only-key-at-least-32-characters';
  Object.assign(process.env, { KYC_DEMO: '1', KYC_DEMO_BITS: '1', EVIDENCE_HMAC_KEY: secret,
    SERVER_TOKEN_KEY: 'synthetic-browser-e2e-token-key-at-least-32-characters', SERVER_TOKEN_KEY_ID: 'browser-e2e-k1',
    EVIDENCE_VAULT_PATH: join(root, 'vault.enc'), EVIDENCE_VAULT_KEY: secret,
    ISSUANCE_JOURNAL_REDIS_REST_URL: 'https://synthetic-local-redis.test', ISSUANCE_JOURNAL_REDIS_REST_TOKEN: 'fictional-token',
    ISSUANCE_JOURNAL_KEY: secret, ISSUANCE_JOURNAL_NAMESPACE: 'local-e2e', ISSUANCE_CONFIRMATIONS: '1', SANCTIONS_MAX_AGE_HOURS: '168',
    ISSUANCE_SOURCE_EXPECTED_SECONDS: '1-30', ISSUANCE_HUB_EXPECTED_SECONDS: '1-60', ISSUANCE_TRACKING_TIMEOUT_SECONDS: '120',
    ISSUANCE_SUPPORT_URL: 'https://support.example.test/issuance' });
  Object.assign(process.env, { ISSUANCE_GAS_BUDGET_KEY: `${secret}-budget`, ISSUANCE_DAILY_GAS_LIMIT: '1000000',
    ISSUANCE_DAILY_TRANSACTION_LIMIT: '10' });
  let loseSignedSave = false, saveCount = 0, lostSaves = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url) !== new URL(process.env.ISSUANCE_JOURNAL_REDIS_REST_URL!).href) throw new Error('unexpected external fetch in isolated integration');
    const args = JSON.parse(String(init?.body));
    const { stdout } = await exec('docker', ['exec', container!, 'redis-cli', '--json', ...args.map(String)], { maxBuffer: 2000000 });
    if (loseSignedSave && args[3 + Number(args[2])] === 'save' && ++saveCount === 2) {
      assert.equal(JSON.parse(stdout)[0], 'ok'); // Real Redis committed the signed payload before the reply is lost.
      loseSignedSave = false; lostSaves++; throw new Error('synthetic response loss after committed signed-payload save');
    }
    return Response.json({ result: JSON.parse(stdout) });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = nativeFetch; });
  const now = Date.now();
  // Use the exact currently activated repository artifact, not a three-row lookalike corpus.
  // T-27 owns the official full-GET observation; this test proves the same bytes reach the
  // visitor's actual issuance request and the epoch bound to the resulting roster.
  const activatedRaw = readFileSync(join(currentGeneration(join(cwd, '..', 'data', 'raw')), 'sanctions-index.json.gz'));
  const bakedWeb = readFileSync(join(cwd, 'data', 'sanctions-index.json.gz'));
  assert.equal(ethers.sha256(bakedWeb), ethers.sha256(activatedRaw),
    'CLI and built web must use the same activated sanctions artifact');
  const official = readIndex(bakedWeb, now).meta;
  assert.ok(official.counts.OFAC_SDN > 10_000 && official.counts.UN_CONSOLIDATED > 500 && official.counts.EU_FSF > 5_000,
    `activated corpus is not the complete three-source fixture: ${JSON.stringify(official.counts)}`);
  process.env.SANCTIONS_EXPECTED_SNAPSHOT_ID = official.provenance.snapshotId;
  atomicFile(join(root, 'data', 'sanctions-index.json.gz'), bakedWeb);

  async function chain(chainId: number) {
    const probe = portProbe(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--timestamp', String(Math.floor(now / 1000)), '--silent'], { stdio: 'ignore' });
    t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); } });
    const url = `http://127.0.0.1:${port}`, provider = issuanceProvider(url); t.after(() => provider.destroy());
    for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break; } catch { if (i >= 30 || child.exitCode !== null) throw new Error('local Anvil unavailable'); await delay(100); } }
    assert.equal((await provider.getNetwork()).chainId, BigInt(chainId)); return { provider, url };
  }
  const sourceChain = await chain(11155111), hubChain = await chain(102031);
  const sourceRpc = sourceChain.provider, hubRpc = hubChain.provider;
  // Distinct reader object exercises the current dual-surface API. This isolated fixture still
  // points both readers at one Anvil and is not evidence of independently operated headers.
  const sourceHeaderRpc = issuanceProvider(sourceChain.url); t.after(() => sourceHeaderRpc.destroy());
  const key = (n: number) => ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${n}`).privateKey;
  const owner = new ethers.Wallet(key(0), sourceRpc), issuer = new ethers.Wallet(key(1), sourceRpc), hubOwner = new ethers.Wallet(key(0), hubRpc);
  const deployments = new Map<string, string>();
  async function deploy(name: string, signer: ethers.Wallet, args: unknown[] = [], library?: string) {
    const a = artifact(name); let bytes: string = a.bytecode.object;
    for (const libraries of Object.values(a.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
      for (const [name, offsets] of Object.entries(libraries)) {
        assert.equal(name, 'EvmV1Decoder'); assert.ok(library);
        for (const o of offsets) { assert.equal(o.length, 20); const start = 2 + o.start * 2; bytes = bytes.slice(0, start) + library.slice(2) + bytes.slice(start + 40); }
      }
    }
    const c = await new ethers.ContractFactory(a.abi, bytes, signer).deploy(...args); await c.waitForDeployment();
    deployments.set(await c.getAddress(), c.deploymentTransaction()!.hash); return new ethers.Contract(await c.getAddress(), a.abi, signer);
  }
  const source = await deploy('ComplianceSource', owner, [owner.address]);
  // Same development deployer/nonce can produce the same ADDRESS on another chain.
  // Capture the source hash now, before any hub deployment can reuse that map key.
  const sourceDeploymentTx = deployments.get(await source.getAddress())!;
  await (await source.setIssuer(issuer.address, true)).wait(); await (await source.setEpochPublisher(owner.address, true)).wait();
  const decoder = await deploy('EvmV1Decoder', hubOwner);
  // Native inclusion/continuity verifier is explicitly a local mock, NOT a live cross-chain proof.
  await hubRpc.send('anvil_setCode', ['0x0000000000000000000000000000000000000FD2', artifact('MockBlockProver').deployedBytecode.object]);
  const asc = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], await decoder.getAddress());
  await (await asc.configureSource(1, await source.getAddress())).wait();
  const registry = await deploy('ProofmarkRegistry', hubOwner, [await asc.getAddress()]);
  for (const regime of [1, 2]) {
    await (await registry.registerPolicy([65572, 2, regime === 1 ? 2592000 : 604800, regime, 410, issuer.address, true, false])).wait();
    await (await registry.freezePolicy(regime)).wait();
  }
  const note = await deploy('GatedRwaNote', hubOwner, ['Synthetic API test note', 'LAPI', await registry.getAddress(), 2, hubOwner.address]);
  Object.assign(process.env, { ISSUER_PRIVATE_KEY: issuer.privateKey, NEXT_PUBLIC_SOURCE: await source.getAddress(),
    NEXT_PUBLIC_ASC: await asc.getAddress(), NEXT_PUBLIC_REGISTRY: await registry.getAddress(), NEXT_PUBLIC_NOTE: await note.getAddress(),
    NEXT_PUBLIC_SEPOLIA_RPC: sourceChain.url, NEXT_PUBLIC_CC3_RPC: hubChain.url });
  const walletRoute = await import('../app/api/kyc/wallet/route'), idRoute = await import('../app/api/kyc/id/route');
  const bankRoute = await import('../app/api/kyc/bank/route'), issueRoute = await import('../app/api/kyc/issue/route');
  const statusRoute = await import('../app/api/kyc/status/route'), onchainRoute = await import('../app/api/onchain/route');
  const { issuanceBudget, issuanceJournal } = await import('../lib/issuance-server');
  const frontend = await builtFrontend(t, cwd, nativeFetch);
  process.chdir(root); // getEngine reads only this temporary synthetic generation.
  const routes: Record<string, (req: Request) => Promise<Response> | Response> = {
    'GET /api/kyc/status': statusRoute.GET, 'GET /api/kyc/wallet': walletRoute.GET, 'POST /api/kyc/wallet': walletRoute.POST,
    'POST /api/kyc/id': idRoute.POST, 'POST /api/kyc/bank': bankRoute.POST, 'POST /api/kyc/issue': issueRoute.POST,
    'POST /api/kyc/status': statusRoute.POST, 'GET /api/onchain': onchainRoute.GET };
  const failures: unknown[] = [];
  const droppedOutcomes: { requestId: string; hash: string }[] = [];
  let loseIssueResponse = false, lostHttpResponses = 0;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, 'http://localhost').pathname;
      if (!path.startsWith('/api/')) {
        // Only built page/assets; API requests NEVER enter the Next process or use canned responses.
        assert.equal(req.method, 'GET'); assert.ok(['/', '/verify/sandbox', '/onchain', '/design', '/icon.svg', '/favicon.ico'].includes(path) || path.startsWith('/_next/'), path);
        const response = await nativeFetch(frontend + req.url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length');
        res.writeHead(response.status, Object.fromEntries(headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const url = `http://${req.headers.host}${req.url}`, request = new Request(url, { method: req.method,
        headers: req.headers as Record<string, string>, ...(req.method === 'GET' ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }) });
      const route = routes[`${req.method} ${new URL(url).pathname}`]; assert.ok(route, 'unexpected local route');
      const response = await route(request);
      if (loseIssueResponse && new URL(url).pathname === '/api/kyc/issue') {
        assert.equal(response.status, 200); const outcome = await response.clone().json(); assert.equal(outcome.issuance.phase, 'source-confirmed');
        droppedOutcomes.push({ requestId: outcome.requestId, hash: outcome.onchain.txHash });
        // Chromium may transparently retry a closed reused socket. Keep every original
        // issue reply lost until the page observes failure; idempotency still owns the tx.
        lostHttpResponses++; res.destroy(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { failures.push(error); res.writeHead(500); res.end('local harness failure'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const base = `http://localhost:${(server.address() as { port: number }).port}`;
  async function request(path: string, init: RequestInit = {}, status = 200) {
    const response = await nativeFetch(base + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body)); assert.equal(response.headers.get('cache-control'), 'no-store'); return body;
  }
  const post = (path: string, body: object, status = 200) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, status);
  const status = await request('/api/kyc/status');
  assert.equal(status.issuanceJournal.configured, true); assert.equal(status.issuanceBudget.configured, true); assert.equal(status.bankState.mode, 'demo-memory');
  assert.equal(status.issuanceTracking.configured, true);
  assert.deepEqual(status.tokenKey, { configured: true, mode: 'versioned-dedicated', missing: [], currentKeyId: 'browser-e2e-k1' });
  const flowRequests = new Map<string, string>();
  async function proof(wallet: ethers.HDNodeWallet) {
    const challenge = await request(`/api/kyc/wallet?address=${wallet.address}`);
    const signed = await post('/api/kyc/wallet', { token: challenge.token, signature: await wallet.signMessage(challenge.message) });
    assert.match(signed.requestId, /^0x[0-9a-f]{64}$/); flowRequests.set(signed.walletProof, signed.requestId);
    return signed.walletProof as string;
  }
  async function enroll(fault: 'signed-save' | 'http-response') {
    const wallet = ethers.Wallet.createRandom().connect(hubRpc);
    const ui = fault === 'http-response' ? await browserIssuance(t, base, wallet) : null;
    const signed = ui ? await ui.sign() : null;
    const walletProof: string = signed ? signed.walletProof : await proof(wallet);
    if (signed) flowRequests.set(walletProof, signed.requestId);
    let payload: { walletProof: string; declared: { fullName: string; dateOfBirth: string; nationality: string; residence: string }; idProof: string; bankProof: string };
    if (ui) {
      await ui.page.getByRole('button', { name: 'Check sample document', exact: true }).click();
      const bankResponse = ui.page.waitForResponse(r => new URL(r.url()).pathname === '/api/kyc/bank' && r.request().postDataJSON()?.action === 'start');
      await ui.page.getByRole('button', { name: 'Check sample account', exact: true }).click();
      const actualBank = await bankResponse; assert.equal(actualBank.status(), 200); const bank = await actualBank.json();
      assert.match(bank.demoCode, /^\d{4}$/);
      await ui.page.getByRole('region', { name: 'Bank account', exact: true }).getByText(bank.demoCode, { exact: true }).waitFor();
      await ui.page.getByRole('region', { name: 'Bank account', exact: true }).getByLabel('Code', { exact: false }).fill(bank.demoCode);
      await ui.page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await ui.page.getByText('one-won code', { exact: true }).waitFor();
      assert.equal(ui.signatures(), 1); assert.equal(await ui.recoveryId(), null);
    } else {
      const form = new FormData();
      for (const [k, v] of Object.entries({ walletProof, syntheticSample: '1', action: 'verify', docType: 'RRC', fullName: 'PROOFMARK SAMPLE PERSON',
        birthDate: '20000101', rrn: '0001010000001', issueDate: '20240101' })) form.append(k, v);
      form.append('image', new Blob([syntheticDriverPng()], { type: 'image/png' }), 'synthetic-not-an-id.png');
      const id = await request('/api/kyc/id', { method: 'POST', body: form }); assert.equal(id.status, 'verified');
      const bank = await post('/api/kyc/bank', { walletProof, syntheticSample: true, action: 'start', startRequestId: crypto.randomUUID(),
        bankCode: '004', accountNumber: '12345678', birthDate: '000101', declaredName: 'PROOFMARK SAMPLE PERSON' });
      const verified = await post('/api/kyc/bank', { walletProof, syntheticSample: true, action: 'verify', challenge: bank.challenge, code: bank.demoCode });
      payload = { walletProof, declared: { fullName: 'PROOFMARK SAMPLE PERSON', dateOfBirth: '2000-01-01', nationality: 'KR', residence: 'KR' }, idProof: id.idProof, bankProof: verified.bankProof };
    }
    // Anvil has no independent block production between HTTP calls. Keep its latest block
    // ahead of the fixture wall clock so issuedAt validation in gas estimation is deterministic.
    const clock = Math.floor(Date.now() / 1000) + 10;
    if ((await sourceRpc.getBlock('latest'))!.timestamp < clock) {
      await sourceRpc.send('evm_setNextBlockTimestamp', [clock]); await sourceRpc.send('evm_mine', []);
    }
    const recoveryId = flowRequests.get(walletProof)!; // Available BEFORE issuance, without reading a token or journal.
    assert.equal(await issuanceJournal().get(recoveryId), null, 'wallet signing alone does not allocate an issuance record');
    const beforeNonce = await sourceRpc.getTransactionCount(issuer.address);
    if (fault === 'signed-save') {
      loseSignedSave = true; saveCount = 0;
      const failed = await post('/api/kyc/issue', payload!, 503);
      assert.equal(failed.code, 'JOURNAL_UNAVAILABLE'); assert.equal(failed.requestId, recoveryId); assert.equal(lostSaves, 1);
      assert.equal(await sourceRpc.getTransactionCount(issuer.address), beforeNonce, 'lost save acknowledgement must not broadcast');
    } else {
      loseIssueResponse = true;
      assert.ok(ui);
      const sent = ui.page.waitForRequest(r => new URL(r.url()).pathname === '/api/kyc/issue');
      await ui.page.getByRole('button', { name: 'Submit verification', exact: true }).click();
      payload = (await sent).postDataJSON(); assert.equal(payload.walletProof, walletProof);
      try { await ui.page.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor(); }
      catch { throw new Error(JSON.stringify({ alerts: await ui.page.getByRole('alert').allTextContents(), lostHttpResponses,
        issueActions: ui.calls.filter(c => c.path === '/api/kyc/issue'), harnessFailures: failures.map(String) })); }
      loseIssueResponse = false;
      assert.equal(await ui.recoveryId(), recoveryId, 'real UI kept the earlier wallet response ID despite losing the entire issue reply');
      assert.equal(ui.calls.filter(c => c.path === '/api/kyc/issue').length, 1, 'no automatic POST retry');
      assert.ok(lostHttpResponses >= 1);
      assert.equal(await sourceRpc.getTransactionCount(issuer.address), beforeNonce + 1, 'source transaction did commit before response loss');
    }
    const committed = (await issuanceJournal().get(recoveryId))!.entry;
    assert.ok(committed.transaction, JSON.stringify({ phase: committed.phase, lastError: committed.lastError })); assert.equal(committed.evidenceStored, true);
    if (ui) {
      assert.equal(droppedOutcomes.length, lostHttpResponses);
      for (const lost of droppedOutcomes) assert.deepEqual(lost, { requestId: recoveryId, hash: committed.transaction.hash });
    }
    if (fault === 'signed-save') {
      assert.equal(await sourceRpc.getTransactionReceipt(committed.transaction.hash), null);
      const unsignedVault = new EvidenceVault(process.env.EVIDENCE_VAULT_PATH!, secret);
      assert.equal(unsignedVault.get(recoveryId)!.sourceIssuance, undefined);
      assert.equal(unsignedVault.listForRescreen(Date.now() + 1, 1).some(record => record.id === recoveryId), false);
    }
    let refreshed: string;
    if (ui) {
      const count = ui.calls.filter(c => c.path === '/api/kyc/issue').length;
      await ui.page.reload();
      assert.equal(await ui.recoveryId(), recoveryId);
      assert.equal(await ui.page.getByRole('button', { name: 'Signed', exact: true }).count(), 0);
      const fresh = await ui.sign(); refreshed = fresh.walletProof; flowRequests.set(refreshed, fresh.requestId);
      assert.notEqual(refreshed, walletProof); assert.equal(ui.signatures(), 2);
      assert.equal(ui.calls.filter(c => c.path === '/api/kyc/issue').length, count, 'reload/signing must not recover automatically');
      assert.equal(await ui.recoveryId(), recoveryId);
      const review = ui.page.getByRole('region', { name: 'Review and submit', exact: true });
      assert.equal(await review.getByRole('button', { name: 'Submit verification', exact: true, includeHidden: true }).isDisabled(), true);
    } else refreshed = await proof(wallet);
    assert.notEqual(flowRequests.get(refreshed), recoveryId, 'new signature creates a different flow, not a different recovery target');
    const observed = ui ? await ui.recover('status') : await post('/api/kyc/status', { action: 'resume', requestId: recoveryId, walletProof: refreshed });
    assert.equal(observed.issuance.phase, fault === 'signed-save' ? 'prepared' : 'source-confirmed');
    assert.equal(observed.onchain.txHash, committed.transaction.hash);
    const issued = ui ? await ui.recover('resume') : await post('/api/kyc/issue', { action: 'resume', requestId: recoveryId, walletProof: refreshed });
    if (ui) {
      assert.deepEqual(ui.calls.filter(c => c.action !== undefined).map(c => c.action), ['issue', 'status', 'resume']);
      assert.deepEqual(ui.errors, []);
      await ui.page.getByRole('region', { name: 'Review and submit', exact: true })
        .getByText(issued.onchain.txHash, { exact: true }).waitFor({ state: 'attached' });
      console.log(`Connected browser: ${lostHttpResponses} source-confirmed replies lost; explicit issue/status/resume, two signatures, one source nonce.`);
      await ui.page.close();
    }
    assert.equal(issued.requestId, recoveryId); assert.equal(issued.onchain.txHash, committed.transaction.hash);
    assert.deepEqual(issued.claims, committed.outcome.status === 'ISSUED' ? committed.outcome.claims : []);
    assert.equal(issued.evidenceHash, committed.outcome.evidenceHash);
    assert.equal(await sourceRpc.getTransactionCount(issuer.address), beforeNonce + 1, 'recovery consumes exactly one source nonce');
    assert.equal(issued.status, 'ISSUED'); assert.equal(issued.issuance.phase, 'source-confirmed'); assert.equal(issued.regime, 2);
    assert.equal(issued.vault.stored, true); assert.equal(issued.policyPreview.production, false); assert.equal(issued.policyPreview.sandbox, true);
    const entry = (await issuanceJournal().get(issued.requestId))!.entry;
    assert.equal(entry.evidenceStored, true); assert.equal(entry.transaction!.hash, issued.onchain.txHash);
    assert.equal(ethers.keccak256(entry.transaction!.raw), issued.onchain.txHash);
    assert.equal(JSON.stringify(issued).includes(entry.transaction!.raw), false);
    const retainedVault = new EvidenceVault(process.env.EVIDENCE_VAULT_PATH!, secret);
    const retained = retainedVault.get(issued.requestId)!;
    assert.equal(retained.state, 'pending');
    assert.deepEqual(retained.sourceIssuance, { transactionHash: entry.transaction!.hash.toLowerCase(),
      chainId: entry.target.chainId, source: entry.target.source.toLowerCase(), observedAt: retained.sourceIssuance!.observedAt });
    assert.ok(retained.sourceIssuance!.observedAt >= retained.createdAt);
    assert.equal(retainedVault.listForRescreen(Date.now() + 1, 1).some(record => record.id === issued.requestId), true);
    const vaultCiphertext = readFileSync(process.env.EVIDENCE_VAULT_PATH!, 'utf8');
    assert.equal(vaultCiphertext.includes('PROOFMARK SAMPLE PERSON'), false); assert.equal(vaultCiphertext.includes(entry.transaction!.raw), false);
    const { stdout } = await exec('docker', ['exec', container!, 'redis-cli', '--raw', 'HGET', `{local-e2e:issuance}:request:${issued.requestId}`, 'payload']);
    assert.ok(stdout.length > 100); assert.equal(stdout.includes('PROOFMARK SAMPLE PERSON'), false); assert.equal(stdout.includes(entry.transaction!.raw), false);
    const nonce = await sourceRpc.getTransactionCount(issuer.address);
    const replay = await post('/api/kyc/issue', payload!); assert.equal(replay.onchain.txHash, issued.onchain.txHash);
    assert.deepEqual(replay.claims, issued.claims); assert.equal(replay.evidenceHash, issued.evidenceHash);
    assert.equal(await sourceRpc.getTransactionCount(issuer.address), nonce, 'same flow must not create a second source transaction');
    return { wallet, walletProof, issued, payload: payload! };
  }
  const alice = await enroll('signed-save'), bob = await enroll('http-response');
  const sourceReceipts = await Promise.all([alice, bob].map(actor => sourceRpc.getTransactionReceipt(actor.issued.onchain.txHash)));
  const expectedGas = sourceReceipts.reduce((total, receipt) => total + receipt!.gasUsed, 0n);
  assert.deepEqual(await issuanceBudget().status(issuer.address), { reservedGas: expectedGas, transactionCount: 2 });
  const foreignFlow = await proof(ethers.Wallet.createRandom());
  const nonceBeforeMixedFlow = await sourceRpc.getTransactionCount(issuer.address);
  await post('/api/kyc/issue', { ...alice.payload, walletProof: foreignFlow, bankProof: bob.payload.bankProof }, 400);
  assert.equal(await sourceRpc.getTransactionCount(issuer.address), nonceBeforeMixedFlow, 'mixed signed flows cannot issue');
  async function relay(receipt: ethers.TransactionReceipt, action: number) {
    const block = (await sourceRpc.getBlock(receipt.blockNumber))!;
    if ((await hubRpc.getBlock('latest'))!.timestamp <= block.timestamp) await hubRpc.send('evm_setNextBlockTimestamp', [block.timestamp + 1]);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const payload = coder.encode(['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'], [receipt.status, receipt.gasUsed, receipt.logs.map(l => [l.address, [...l.topics], l.data]), '0x']);
    const tx = await asc.execute(action, 1, receipt.blockNumber, coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', payload]]), ethers.zeroPadValue(ethers.toBeHex(receipt.index), 32), [], ethers.ZeroHash, []);
    assert.equal((await tx.wait()).status, 1);
  }
  for (const actor of [alice, bob]) {
    assert.equal((await request(`/api/onchain?subject=${actor.wallet.address}`)).mark.status, 0);
    await relay((await sourceRpc.getTransactionReceipt(actor.issued.onchain.txHash))!, 0);
    const refreshed = await proof(actor.wallet); // Recovery deliberately uses a NEW signed wallet flow, no ID/bank tokens.
    const nonce = await sourceRpc.getTransactionCount(issuer.address);
    const resumed = await post('/api/kyc/issue', { action: 'resume', requestId: actor.issued.requestId, walletProof: refreshed });
    assert.equal(resumed.issuance.phase, 'materialized'); assert.equal(resumed.onchain.txHash, actor.issued.onchain.txHash);
    assert.equal(resumed.progress.attestation.state, 'applied'); assert.equal(resumed.progress.policy.state, 'ineligible');
    assert.equal(resumed.assetAction.ready, false, 'CC3 materialization alone is not an asset-ready verdict');
    assert.equal(resumed.claimsRoot, actor.issued.claimsRoot); assert.deepEqual(resumed.claims, actor.issued.claims);
    assert.equal(await sourceRpc.getTransactionCount(issuer.address), nonce);
    const materialized = new EvidenceVault(process.env.EVIDENCE_VAULT_PATH!, secret).get(actor.issued.requestId)!;
    assert.equal(materialized.state, 'active');
    assert.equal(materialized.sourceIssuance!.transactionHash, actor.issued.onchain.txHash.toLowerCase());
    assert.equal(materialized.sourceIssuance!.hubMaterialized, true);
    assert.equal((await request(`/api/onchain?subject=${actor.wallet.address}`)).policies.find((p: { id: number }) => p.id === 2).verified, false);
  }
  await post('/api/kyc/issue', { action: 'status', requestId: alice.issued.requestId, walletProof: bob.walletProof }, 404);
  await sourceRpc.send('anvil_mine', ['0x41']);
  const snapshot = await buildSourceRoster(sourceRpc, { source: await source.getAddress(), chainId: 11155111n,
    deploymentTx: sourceDeploymentTx, confirmations: 1, headerReader: sourceHeaderRpc });
  assert.equal(snapshot.tree.entries.length, 2);
  const sourceCutoff = snapshot.manifest.cutoffTimestamp;
  const listVersion = Number.parseInt(official.provenance.snapshotId.slice(0, 8), 16);
  const validUntil = Math.min(sourceCutoff + 86400,
    Math.floor(Math.min(...Object.values(official.provenance.sources).map(source => Date.parse(source.checkedAt))) / 1000) + 86400);
  assert.ok(validUntil > sourceCutoff, 'activated official snapshot must leave a fresh epoch window');
  const approval = rosterApprovalData(11155111n, await source.getAddress(), { epoch: 1, root: snapshot.tree.root, listVersion,
    sourceCutoff, validUntil, snapshotId: `0x${official.provenance.snapshotId}`, publisher: owner.address });
  const m = approval.value, signature = await issuer.signTypedData(approval.domain, approval.types, m);
  await relay(await (await source.publishEpochForIssuers(m.epoch, m.root, m.listVersion, m.validUntil, m.sourceCutoff, m.snapshotId, [{ issuer: issuer.address, signature }])).wait(), 3);
  for (const actor of [alice, bob]) {
    const encoded = encodeRosterWitness({ rosterFormatVersion: 2, epochSchemaVersion: 2, rosterAuthVersion: 1, root: snapshot.tree.root, entries: snapshot.tree.entries }, actor.wallet.address);
    await (await registry.cacheRosterWitness(...encoded.args)).wait();
    const state = await request(`/api/onchain?subject=${actor.wallet.address}`);
    assert.equal(state.policies.find((p: { id: number }) => p.id === 2).verified, true);
    assert.equal(state.policies.find((p: { id: number }) => p.id === 1).verified, false);
    const tracked = await post('/api/kyc/status', { requestId: actor.issued.requestId, walletProof: actor.walletProof });
    const screenedOutcome = (await issuanceJournal().get(actor.issued.requestId))!.entry.outcome;
    assert.equal(screenedOutcome.status, 'ISSUED');
    if (screenedOutcome.status !== 'ISSUED') throw new Error('official-screened issuance unavailable');
    assert.equal(screenedOutcome.screeningSnapshotId, official.provenance.snapshotId);
    assert.equal(tracked.progress.source.state, 'confirmed'); assert.equal(tracked.progress.attestation.state, 'applied');
    assert.equal(tracked.progress.policy.state, 'eligible'); assert.deepEqual(tracked.assetAction.readyPolicyIds, [2]);
    assert.equal(tracked.assetAction.ready, true);
  }
  await hubRpc.send('anvil_setBalance', [alice.wallet.address, ethers.toQuantity(ethers.parseEther('1'))]);
  await (await note.mint(alice.wallet.address, 100n)).wait();
  const held = new ethers.Contract(await note.getAddress(), artifact('GatedRwaNote').abi, alice.wallet);
  assert.equal((await (await held.transfer(bob.wallet.address, 25n)).wait()).status, 1);
  assert.equal(await note.balanceOf(alice.wallet.address), 75n); assert.equal(await note.balanceOf(bob.wallet.address), 25n);
  const control = ethers.Wallet.createRandom().address;
  await assert.rejects(held.transfer.staticCall(control, 1n), (e: unknown) => (e as { data: string }).data === note.interface.encodeErrorResult('RecipientNotVerified', [control, 2]));
  await relay(await (await source.connect(issuer).getFunction('revoke')(bob.wallet.address, 2, 1)).wait(), 1);
  const denied = await held.transfer(bob.wallet.address, 1n, { gasLimit: 200000 });
  await assert.rejects(denied.wait(), (e: unknown) => (e as { receipt?: ethers.TransactionReceipt }).receipt?.status === 0);
  assert.equal(await note.balanceOf(alice.wallet.address), 75n); assert.equal(await note.balanceOf(bob.wallet.address), 25n);
  assert.equal((await request(`/api/onchain?subject=${bob.wallet.address}`)).policies.find((p: { id: number }) => p.id === 2).verified, false);
  assert.deepEqual(failures, []);
});
