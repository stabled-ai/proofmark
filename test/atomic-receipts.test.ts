import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { packAttrs, unpackAttrs } from '../pipeline/attrs.js';
import { buildSourceRoster } from '../pipeline/roster-source.js';
import { Store } from '../worker/store.js';

const PRECOMPILE = '0x0000000000000000000000000000000000000FD2';
const key = (index: number) => ethers.HDNodeWallet.fromPhrase(
  'test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${index}`,
).privateKey;
const artifact = (file: string, name = file) => JSON.parse(
  readFileSync(new URL(`../out/${file}.sol/${name}.json`, import.meta.url), 'utf8'),
);

test('mixed and governed-correction receipts stay identical through source, worker, ASC and roster replay', { timeout: 90000 }, async t => {
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'atomic receipt integration cleanup failed');
  });
  async function freePort() {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  }
  async function chain(chainId: number) {
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId),
      '--timestamp', '1800000000', '--silent'], { stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
    const provider = issuanceProvider(url); cleanups.push(() => provider.destroy());
    for (let attempt = 0; ; attempt++) {
      try { await provider.getBlockNumber(); break; }
      catch { if (attempt >= 30 || child.exitCode !== null) throw new Error('isolated Anvil unavailable'); await delay(100); }
    }
    return { url, provider };
  }
  const sourceChain = await chain(11155111), hubChain = await chain(102031);
  const sourceHeaders = issuanceProvider(sourceChain.url); cleanups.push(() => sourceHeaders.destroy());
  const sourceOwner = new ethers.Wallet(key(0), sourceChain.provider), hubOwner = new ethers.Wallet(key(0), hubChain.provider);
  const deploymentTxs = new Map<string, string>();
  async function deploy(file: string, signer: ethers.Wallet, args: unknown[] = [], name = file, library?: string) {
    const compiled = artifact(file, name); let bytes = compiled.bytecode.object as string;
    for (const libraries of Object.values(compiled.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
      for (const [libraryName, offsets] of Object.entries(libraries)) {
        assert.equal(libraryName, 'EvmV1Decoder'); assert.ok(library);
        for (const offset of offsets) {
          assert.equal(offset.length, 20); const start = 2 + offset.start * 2;
          bytes = bytes.slice(0, start) + library.slice(2) + bytes.slice(start + 40);
        }
      }
    }
    const deployed = await new ethers.ContractFactory(compiled.abi, bytes, signer).deploy(...args);
    await deployed.waitForDeployment();
    const address = await deployed.getAddress();
    deploymentTxs.set(address, deployed.deploymentTransaction()!.hash);
    return new ethers.Contract(address, compiled.abi, signer);
  }
  const source = await deploy('ComplianceSource', sourceOwner, [sourceOwner.address]);
  const sourceDeploymentTx = deploymentTxs.get(await source.getAddress())!;
  const composer = await deploy('T10ComposingIssuer', sourceOwner);
  await (await source.setIssuer(await composer.getAddress(), true)).wait();
  await (await source.setEpochPublisher(await composer.getAddress(), true)).wait();
  await (await source.setIssuer(sourceOwner.address, true)).wait();
  const correctionApprover = new ethers.Wallet(key(1), sourceChain.provider);
  await (await source.setDenialCorrectionApprover(correctionApprover.address, true)).wait();
  const decoder = await deploy('EvmV1Decoder', hubOwner);
  await hubChain.provider.send('anvil_setCode', [PRECOMPILE, artifact('MockBlockProver').deployedBytecode.object]);
  const asc = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], 'ProofmarkASC', await decoder.getAddress());
  await (await asc.configureSource(1, await source.getAddress())).wait();

  const duplicate = ethers.Wallet.createRandom().address, revoked = ethers.Wallet.createRandom().address;
  const corrected = ethers.Wallet.createRandom().address;
  const sourceTime = (await sourceChain.provider.getBlock('latest'))!.timestamp;
  const attrs = (methods: number) => packAttrs({ kind: 1, assurance: 3, regime: 1, jurisdiction: 410,
    methods, issuedAt: sourceTime, expiry: sourceTime + 86400, epoch: 1 });
  const duplicateReceipt = await (await composer.issueTwice(await source.getAddress(), duplicate, attrs(1), attrs(2))).wait();
  const revokedReceipt = await (await composer.issueThenRevoke(await source.getAddress(), revoked, attrs(1))).wait();
  const firstRoot = ethers.id('t10-first-root'), secondRoot = ethers.id('t10-second-root');
  const epochReceipt = await (await composer.publishTwice(
    await source.getAddress(), sourceTime, sourceTime + 86400, firstRoot, secondRoot,
  )).wait();
  const initialCorrectionSubjectReceipt = await (await source.issue(
    corrected, attrs(4), ethers.id('initial-correction-claims'), ethers.id('initial-correction-evidence'),
  )).wait();
  const denialReceipt = await (await source.deny(corrected, 7, 1)).wait();
  const correctionId = await source.nextDenialCorrectionId();
  await (await source.proposeDenialCorrection(corrected, attrs(8), ethers.id('replacement-claims'),
    ethers.id('replacement-evidence'), ethers.id('synthetic-reviewed-correction'))).wait();
  await (await source.connect(correctionApprover).approveDenialCorrection(correctionId)).wait();
  await sourceChain.provider.send('evm_increaseTime', [3600]);
  await sourceChain.provider.send('evm_mine', []);
  const correctionReceipt = await (await source.executeDenialCorrection(correctionId)).wait();
  assert.ok(duplicateReceipt && revokedReceipt && epochReceipt && initialCorrectionSubjectReceipt && denialReceipt && correctionReceipt);
  assert.deepEqual(duplicateReceipt.logs.map(log => source.interface.parseLog(log)?.name), ['MarkIssued', 'MarkIssued']);
  assert.deepEqual(revokedReceipt.logs.map(log => source.interface.parseLog(log)?.name), ['MarkIssued', 'MarkRevoked']);
  assert.deepEqual(epochReceipt.logs.map(log => source.interface.parseLog(log)?.name), [
    'RosterIssuerAuthorized', 'RosterEpochPublished', 'RosterIssuerAuthorized', 'RosterEpochPublished',
  ]);
  assert.deepEqual(correctionReceipt.logs.map(log => source.interface.parseLog(log)?.name), [
    'SanctionDenialCorrected', 'MarkIssued',
  ]);
  assert.equal(duplicateReceipt.index, 0); assert.equal(revokedReceipt.index, 0); assert.equal(epochReceipt.index, 0);
  // Anvil's finalized tag trails the head; make every composed receipt eligible for the
  // production worker's finalized/hash-pinned scan, not merely latest-block visible.
  await sourceChain.provider.send('anvil_mine', ['0x50']);
  const latestSource = (await sourceChain.provider.getBlock('latest'))!;
  const finalizedSource = (await sourceChain.provider.getBlock('finalized'))!;
  assert.ok(finalizedSource.number >= epochReceipt.blockNumber);
  const latestHub = (await hubChain.provider.getBlock('latest'))!;
  if (latestHub.timestamp <= latestSource.timestamp) {
    await hubChain.provider.send('evm_setNextBlockTimestamp', [latestSource.timestamp + 1]);
    await hubChain.provider.send('evm_mine', []);
  }

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encodeReceipt = (receipt: ethers.TransactionReceipt) => coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', coder.encode(
    ['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
    [receipt.status, receipt.gasUsed, receipt.logs.map(log => [log.address, [...log.topics], log.data]), '0x'],
  )]]);
  const receipts = new Map([
    duplicateReceipt, revokedReceipt, epochReceipt, initialCorrectionSubjectReceipt, denialReceipt, correctionReceipt,
  ].map(receipt => [receipt.hash, receipt]));
  const serviceErrors: unknown[] = [];
  const service = createServer(async (request, response) => {
    try {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/v1/attested-height/1') {
        response.end(JSON.stringify({ attestedHeight: latestSource.number })); return;
      }
      const match = request.url?.match(/^\/api\/v1\/proof-by-tx\/1\/(0x[0-9a-fA-F]{64})$/);
      if (match) {
        const receipt = receipts.get(match[1]); assert.ok(receipt, `unexpected proof request ${match[1]}`);
        response.end(JSON.stringify({ chainKey: 1, headerNumber: receipt.blockNumber, txBytes: encodeReceipt(receipt),
          merkleProof: { root: ethers.ZeroHash, siblings: [] },
          continuityProof: { lowerEndpointDigest: ethers.ZeroHash, roots: [] } })); return;
      }
      assert.equal(request.url, '/hub'); let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const forward = async (call: { id: number; method: string; params: unknown[] }) => {
        try { return { jsonrpc: '2.0', id: call.id, result: await hubChain.provider.send(call.method, call.params) }; }
        catch (error: any) { return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: error?.message ?? 'fixture RPC failure' } }; }
      };
      response.end(JSON.stringify(Array.isArray(input) ? await Promise.all(input.map(forward)) : await forward(input)));
    } catch (error) {
      serviceErrors.push(error); response.writeHead(500); response.end('{"error":"FIXTURE_FAILED"}');
    }
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const serviceUrl = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  cleanups.push(() => new Promise<void>(resolve => { service.close(() => resolve()); service.closeAllConnections(); }));

  const dir = mkdtempSync(join(tmpdir(), 'proofmark-atomic-receipts-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'worker.json'), workerWallet = new ethers.Wallet(key(4), hubChain.provider);
  const initialState = new Store(statePath); initialState.bindScope({ sourceChainId: 11155111, hubChainId: 102031, chainKey: 1,
    source: (await source.getAddress()).toLowerCase(), asc: (await asc.getAddress()).toLowerCase(), signer: workerWallet.address.toLowerCase(),
    startBlock: duplicateReceipt.blockNumber }); initialState.initializeHubSigner(0);
  const worker = spawn(process.execPath, ['--import', 'tsx', 'worker/index.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, DOTENV_CONFIG_PATH: join(dir, 'absent.env'), SOURCE_CHAIN_RPC_URL: sourceChain.url,
    CREDITCOIN_RPC_URL: `${serviceUrl}/hub`, PROOF_BUILDER_URL: serviceUrl, WORKER_PRIVATE_KEY: workerWallet.privateKey,
    WORKER_SIGNER_ADDRESS: workerWallet.address,
    SOURCE_CONTRACT_ADDRESS: await source.getAddress(), ASC_CONTRACT_ADDRESS: await asc.getAddress(), SOURCE_CHAIN_KEY: '1',
    WORKER_START_BLOCK: String(duplicateReceipt.blockNumber), WORKER_CONFIRMATIONS: '1', WORKER_HUB_CONFIRMATIONS: '1',
    WORKER_POLL_MS: '25', WORKER_CONCURRENCY: '3', WORKER_STATE_PATH: statePath, WORKER_HEALTH_PORT: '',
    WORKER_HEALTH_MAX_SCAN_AGE_MS: '',
  } });
  let output = ''; worker.stdout.on('data', chunk => output = (output + chunk).slice(-8000));
  worker.stderr.on('data', chunk => output = (output + chunk).slice(-8000));
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
  cleanups.push(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await exited; });
  for (let attempt = 0; ; attempt++) {
    assert.equal(worker.exitCode, null, output);
    try {
      const store = new Store(statePath);
      if ([...receipts.keys()].every(hash => store.get(hash)?.state === 'done')) break;
    } catch { /* state file is not created before preflight */ }
    if (attempt >= 300) throw new Error(`worker did not finish atomic receipts: ${output}`);
    await delay(40);
  }
  worker.kill('SIGTERM'); assert.deepEqual(await exited, { code: 0, signal: null }, output);
  const state = new Store(statePath);
  assert.deepEqual([
    state.get(duplicateReceipt.hash) && { action: state.get(duplicateReceipt.hash)!.action, eventName: state.get(duplicateReceipt.hash)!.eventName,
      logCount: state.get(duplicateReceipt.hash)!.logCount },
    state.get(revokedReceipt.hash) && { action: state.get(revokedReceipt.hash)!.action, eventName: state.get(revokedReceipt.hash)!.eventName,
      logCount: state.get(revokedReceipt.hash)!.logCount },
    state.get(epochReceipt.hash) && { action: state.get(epochReceipt.hash)!.action, eventName: state.get(epochReceipt.hash)!.eventName,
      logCount: state.get(epochReceipt.hash)!.logCount },
    state.get(correctionReceipt.hash) && { action: state.get(correctionReceipt.hash)!.action,
      eventName: state.get(correctionReceipt.hash)!.eventName, logCount: state.get(correctionReceipt.hash)!.logCount },
  ], [
    { action: 0, eventName: 'MarkIssued', logCount: 2 },
    { action: 0, eventName: 'MarkIssued+MarkRevoked', logCount: 2 },
    { action: 3, eventName: 'RosterEpochPublished', logCount: 2 },
    { action: 5, eventName: 'SanctionDenialCorrected+MarkIssued', logCount: 2 },
  ]);
  const mark = await asc.getMark(duplicate);
  assert.equal(Number(mark.methods), 2); assert.equal(mark.claimsRoot, ethers.zeroPadValue('0x02', 32));
  assert.equal(Number(await asc.lastAppliedLogIndex(duplicate)), 1);
  assert.equal(Number((await asc.getMark(revoked)).status), 2); assert.equal(await asc.tombstone(revoked), true);
  assert.equal(Number(await asc.lastAppliedLogIndex(revoked)), 1);
  assert.equal(Number(await asc.latestEpoch()), 2); assert.equal(await asc.epochRoots(1), firstRoot); assert.equal(await asc.epochRoots(2), secondRoot);
  assert.equal(await asc.permanentDenial(corrected), false);
  assert.equal(Number((await asc.getMark(corrected)).status), 1);
  assert.equal(Number((await asc.getMark(corrected)).methods), 8);
  assert.equal(await asc.lastDenialCorrectionApprover(corrected), correctionApprover.address);
  assert.deepEqual(serviceErrors, []);

  const snapshot = await buildSourceRoster(sourceChain.provider, { source: await source.getAddress(), chainId: 11155111n,
    deploymentTx: sourceDeploymentTx, confirmations: 1, headerReader: sourceHeaders,
    cutoffBlock: finalizedSource.number, expectedCutoffHash: finalizedSource.hash! });
  assert.equal(snapshot.tree.entries.length, 2);
  const duplicateEntry = snapshot.tree.entries.find(entry => entry.subject === ethers.getAddress(duplicate))!;
  const correctedEntry = snapshot.tree.entries.find(entry => entry.subject === ethers.getAddress(corrected))!;
  assert.equal(unpackAttrs(duplicateEntry.attrs).methods, 2);
  assert.equal(duplicateEntry.claimsRoot, ethers.zeroPadValue('0x02', 32));
  assert.equal(unpackAttrs(correctedEntry.attrs).methods, 8);
  assert.equal(correctedEntry.claimsRoot, ethers.id('replacement-claims'));
  assert.deepEqual(snapshot.excluded, [{ subject: ethers.getAddress(revoked), reason: 'latest ordinary source event is revoke' }]);
});
