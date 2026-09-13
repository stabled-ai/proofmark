import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { AbiCoder, keccak256 } from 'ethers';

const issuer = '0x' + '11'.repeat(20);
const assertOutput = (mode: string, input: string, ...expected: string[]) => spawnSync(process.execPath,
  ['script/assert-demo-output.mjs', mode, 'synthetic-assertion', ...expected], { input, encoding: 'utf8', timeout: 5000 });

test('cast assertions parse full scalar/tuple values and reject misleading substrings', () => {
  assert.equal(assertOutput('scalar', '65572 [6.557e4]\n', '65572').status, 0);
  assert.equal(assertOutput('scalar', issuer.toUpperCase().replace('0X', '0x'), issuer).status, 0);
  for (const invalid of ['false', 'true extra', 'not true', 'true\nfalse', '{"result":true}']) {
    assert.notEqual(assertOutput('scalar', invalid, 'true').status, 0);
  }
  assert.equal(assertOutput('tuple', `65572 [6.557e4]\n2\n${issuer}\ntrue`, '65572', '2', issuer, 'true').status, 0);
  assert.notEqual(assertOutput('tuple', `65572\n1\n${issuer}\ntrue`, '65572', '2', issuer, 'true').status, 0);
  assert.notEqual(assertOutput('tuple', '1\n2\n3', '1', '2').status, 0);
});

test('runtime and revert assertions require exact bytes, not presence or a matching selector alone', () => {
  assert.equal(assertOutput('runtime', '0x6000', keccak256('0x6000')).status, 0);
  assert.notEqual(assertOutput('runtime', '0x', keccak256('0x')).status, 0);
  assert.notEqual(assertOutput('runtime', '0x6001', keccak256('0x6000')).status, 0);
  const data = '0x17887111' + AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [issuer, 2]).slice(2);
  assert.equal(assertOutput('revert', `execution reverted, data: ${data}`, data).status, 0);
  assert.notEqual(assertOutput('revert', 'execution reverted: 0x17887111', data).status, 0);
  assert.notEqual(assertOutput('revert', data.slice(0, -1) + '3', data).status, 0);
});

test('source receipt requires mined success, exact transaction and contract, not a printed status line', () => {
  const hash = '0x' + 'ab'.repeat(32);
  const receipt = { status: '0x1', transactionHash: hash, to: issuer, blockHash: '0x' + 'cd'.repeat(32), blockNumber: '0x10' };
  assert.equal(assertOutput('receipt', JSON.stringify(receipt), hash, issuer).status, 0);
  for (const overrides of [{ status: '0x0' }, { to: '0x' + '22'.repeat(20) }, { blockNumber: null }, { transactionHash: '0x' + '33'.repeat(32) }]) {
    assert.notEqual(assertOutput('receipt', JSON.stringify({ ...receipt, ...overrides }), hash, issuer).status, 0);
  }
});

function harness(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-demo-assert-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['cast', 'curl', 'npx', 'bash']) {
    const path = join(dir, name); copyFileSync('test/fixtures/demo-command-stub.mjs', path); chmodSync(path, 0o700);
  }
  const deployment = JSON.parse(readFileSync('deployments/cc3-testnet.json', 'utf8'));
  deployment.runtimeCodeHashes = Object.fromEntries(Object.keys(deployment.runtimeCodeHashes)
    .map(name => [name, keccak256('0x6000')]));
  deployment.demo.primaryIssuance.sourceConfirmations = 6;
  const deploymentPath = join(dir, 'deployment.json');
  writeFileSync(deploymentPath, JSON.stringify(deployment));
  // .mjs syntax remains valid through the no-extension Node executable fixtures.
  const env = { PATH: `${dir}:${process.env.PATH}`, RECORD: '0', SCENES: '6 7 8',
    SEP: 'https://synthetic-source.test', CC3: 'https://synthetic-hub.test', DEMO_TEST_LOG: join(dir, 'calls.jsonl'),
    PROOFMARK_DEPLOYMENT_MANIFEST: deploymentPath,
    DEMO_EXPECTED_ISSUER: issuer, DEMO_ASC_CODEHASH: keccak256('0x6000'), DEMO_SOURCE_CODEHASH: keccak256('0x6000'),
    DEMO_REGISTRY_CODEHASH: keccak256('0x6000'), DEMO_NOTE_CODEHASH: keccak256('0x6000'),
    SEPOLIA_TX: '0x' + '12'.repeat(32), DEMO_ISSUANCE_SUBJECT: '0x' + '22'.repeat(20),
    DEMO_ISSUANCE_TX_TO: '0xfb46D722CD70F1ed399616a9B4745E60B9220609',
    DEMO_ISSUANCE_ATTRS: '0x' + '34'.repeat(32), DEMO_ISSUANCE_CLAIMS_ROOT: '0x' + '56'.repeat(32),
    DEMO_ISSUANCE_EVIDENCE_HASH: '0x' + '78'.repeat(32), DEMO_SOURCE_CONFIRMATIONS: '6' };
  const run = (extra: Record<string, string> = {}, wrapper = false) => spawnSync('/bin/bash',
    [wrapper ? 'scripts/verify-submission.sh' : 'docs/demo-video/commands-v2.sh'],
    { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  const calls = () => readFileSync(env.DEMO_TEST_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { run, calls };
}

test('actual scene shell succeeds on synthetic expected values without any write command', t => {
  const h = harness(t); const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /read-only scene checks complete/);
  assert.ok(h.calls().every(call => !call.args.includes('send') && !call.args.includes('--private-key')));
  for (const call of h.calls().filter(call => call.program === 'cast' && ['call', 'code'].includes(call.args[0]))) {
    assert.equal(call.args[call.args.indexOf('--block') + 1], call.args.includes('https://synthetic-source.test') ? '200' : '100');
  }
  const blocks = h.calls().filter(call => call.program === 'cast' && call.args[0] === 'block');
  assert.deepEqual(blocks.map(call => call.args[1]), ['latest', 'latest', '100', '200']);
});

test('strict read-only scene rejects missing anchors and either chain reorg before final success', t => {
  const h = harness(t);
  for (const fault of ['missing-block', 'wrong-height', 'hub-reorg', 'source-reorg']) {
    const result = h.run({ DEMO_TEST_FAULT: fault, SCENES: '8' });
    assert.notEqual(result.status, 0, fault);
    assert.doesNotMatch(result.stdout, /read-only scene checks complete/);
  }
});

test('block parser binds exact height and hash and withholds malformed upstream content', () => {
  const hash = '0x' + 'ab'.repeat(32);
  const run = (input: string | Buffer, args = ['pin']) => spawnSync(process.execPath,
    ['script/demo-block.mjs', ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(run(JSON.stringify({ number: '0x10', hash })).stdout.trim(), `16 ${hash}`);
  assert.equal(run(JSON.stringify({ number: 16, hash }), ['check', '16', hash]).status, 0);
  assert.notEqual(run(JSON.stringify({ number: 17, hash }), ['check', '16', hash]).status, 0);
  for (const bad of ['null', '{"PRIVATE":', Buffer.from([0xff]), 'PRIVATE'.repeat(350000),
    JSON.stringify({ number: null, hash }), JSON.stringify({ number: '1e3', hash }),
    JSON.stringify({ number: '9007199254740992', hash }), JSON.stringify({ number: 1, hash: '0x' + '00'.repeat(32) })]) {
    const result = run(bad); assert.notEqual(result.status, 0);
    assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'FAIL: DEMO_BLOCK_ANCHOR_INVALID_OR_CHANGED');
  }
});

test('installed cast propagates explicit heights to actual JSON-RPC call and code requests', async t => {
  const calls: { method: string; params: unknown[] }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const answer = (call: { id: number; method: string; params: unknown[] }) => {
      calls.push(call);
      const result = call.method === 'eth_chainId' ? '0x18e8f'
        : call.method === 'eth_getTransactionCount' ? '0x0'
        : call.method === 'eth_call' ? AbiCoder.defaultAbiCoder().encode(['bool'], [true])
        : call.method === 'eth_getCode' ? '0x6000' : undefined;
      return result === undefined ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'UNEXPECTED_READ' } }
        : { jsonrpc: '2.0', id: call.id, result };
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn('cast', [...args, '--rpc-url', rpc], {
      env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
  const call = await run(['call', issuer, 'synthetic()(bool)', '--block', '100']);
  assert.equal(call.code, 0, call.output + JSON.stringify(calls));
  const code = await run(['code', issuer, '--block', '200']); assert.equal(code.code, 0, code.output);
  assert.deepEqual(calls.filter(call => call.method === 'eth_call').map(call => call.params[1]), ['0x64']);
  assert.deepEqual(calls.filter(call => call.method === 'eth_getCode').map(call => call.params[1]), ['0xc8']);
  assert.ok(calls.every(call => ['eth_call', 'eth_getCode', 'eth_chainId', 'eth_getTransactionCount'].includes(call.method)));
});

test('wrong network/runtime/source/version/frozen policy/issuer/verdict fail the actual shell', t => {
  const h = harness(t);
  for (const fault of ['chain', 'runtime', 'source-key', 'source', 'legacy', 'unfrozen', 'policy', 'issuer', 'verdict']) {
    const result = h.run({ DEMO_TEST_FAULT: fault, SCENES: '6' });
    assert.notEqual(result.status, 0, `must reject ${fault}: ${result.stdout}`);
  }
});

test('scene 7 alone still checks deployment and rejects the wrong revert or false allowed transfer', t => {
  const h = harness(t);
  for (const fault of ['source-key', 'revert', 'allowed-transfer']) {
    assert.notEqual(h.run({ DEMO_TEST_FAULT: fault, SCENES: '7' }).status, 0, fault);
  }
  assert.notEqual(h.run({ DEMO_ASC_CODEHASH: '', SCENES: '7' }).status, 0);
  assert.notEqual(h.run({ SCENES: 'nonexistent' }).status, 0);
});

test('API scene semantics reject allow results and wrong configured source despite HTTP success', t => {
  const h = harness(t);
  assert.equal(h.run({ SCENES: '2 3', CC3_BLOCK: '999', CC3_BLOCK_HASH: 'inherited-untrusted-pin' }).status, 0);
  assert.ok(h.calls().every(call => call.program !== 'cast'), 'API-only scenes never use inherited block pins');
  assert.notEqual(h.run({ SCENES: '2', DEMO_TEST_FAULT: 'screen' }).status, 0);
  assert.notEqual(h.run({ SCENES: '3', DEMO_TEST_FAULT: 'status' }).status, 0);
});

test('real submission wrapper overrides inherited RECORD=1 before invoking real scene checks', t => {
  const h = harness(t); const result = h.run({ RECORD: '1', DEMO_SUBJECT_A_KEY: 'synthetic-key-must-not-be-used' }, true);
  assert.equal(result.status, 0, result.stderr);
  const calls = h.calls();
  const scene = calls.find(call => call.program === 'bash' && call.args[0] === 'docs/demo-video/commands-v2.sh');
  assert.ok(!calls.some(call => call.program === 'bash' && call.args[0] === 'docs/demo-video/commands.sh'));
  assert.equal(scene?.record, '0');
  assert.ok(calls.some(call => call.program === 'cast' && call.args[0] === 'receipt'), 'submission includes issuance lineage scene');
  assert.ok(calls.filter(call => call.program === 'cast').every(call => call.record === '0'));
  assert.ok(calls.every(call => !call.args.includes('send') && !call.args.includes('--private-key')
    && !JSON.stringify(call.args).includes('synthetic-key-must-not-be-used')));
});

test('source issuance scene requires expected fields, depth, exact subject and unchanged receipt block before final success', t => {
  const h = harness(t);
  assert.equal(h.run({ SCENES: '4' }).status, 0);
  for (const fault of ['receipt-empty', 'receipt-subject', 'receipt-reorg']) {
    const result = harness(t).run({ SCENES: '4', DEMO_TEST_FAULT: fault });
    assert.notEqual(result.status, 0, fault); assert.doesNotMatch(result.stdout, /read-only scene checks complete/);
    if (fault === 'receipt-reorg') assert.match(result.stdout, /PASS: exact source issuance event/, 'initial receipt block check passed before the final mismatch');
  }
  for (const overrides of [{ DEMO_ISSUANCE_SUBJECT: '' }, { DEMO_SOURCE_CONFIRMATIONS: '12' }, { SEPOLIA_TX: '' }] as Record<string, string>[]) {
    assert.notEqual(h.run({ SCENES: '4', ...overrides }).status, 0);
  }
});
