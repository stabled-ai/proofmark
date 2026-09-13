#!/usr/bin/env node
// Synthetic shell-boundary test only. Never connects to an RPC or submits a transaction.
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const program = basename(process.argv[1]);
appendFileSync(process.env.DEMO_TEST_LOG, JSON.stringify({ program, args, record: process.env.RECORD }) + '\n');
const fault = process.env.DEMO_TEST_FAULT;
const SRC = '0xfb46D722CD70F1ed399616a9B4745E60B9220609';
const ASC = '0x8c29A966a30d9083B760451245aECEbBE1E2d2F4';
const REG = '0x5752897b1edaD4fe50908B38c4ddA5f376a43110';
const CONTROL = '0x00000000000000000000000000000000DeaDBeef';
if (program === 'npx') process.exit(0); // Test wrapper routing only, not the mocked downstream verifiers.
if (program === 'bash') {
  if (args[0] === 'scripts/check-demo-urls.sh') process.exit(0);
  const run = spawnSync('/bin/bash', args, { stdio: 'inherit', env: process.env }); process.exit(run.status ?? 1);
}
if (program === 'curl') {
  if (args.some(arg => arg.endsWith('/api/screen'))) {
    console.log(JSON.stringify({ decision: fault === 'screen' ? 'ALLOW' : 'BLOCK', riskBand: 5,
      hits: [{ listId: 'OFAC_SDN', entryId: '20157', corroborated: true }] }));
  } else console.log(JSON.stringify({ demo: true, sandboxBits: true,
    id: { configured: true, vendor: 'demo:id', live: false }, bank: { configured: true, vendor: 'demo:bank', live: false },
    issuer: { configured: true, address: fault === 'status' ? CONTROL : SRC }, issuanceJournal: { configured: true } }));
  process.exit(0);
}
if (program !== 'cast') throw new Error('unexpected synthetic program');
if (args[0] === 'send' || args.includes('--private-key')) throw new Error('WRITE ATTEMPT IN READ-ONLY TEST');
if (args[0] === 'chain-id') {
  console.log(fault === 'chain' ? '1' : args.includes('https://synthetic-source.test') ? '11155111' : '102031'); process.exit(0);
}
if (args[0] === 'block') {
  const source = args.includes('https://synthetic-source.test'), receiptBlock = source && args[1] === '190';
  const number = receiptBlock ? 190 : source ? 200 : 100;
  const changed = args[1] !== 'latest' && fault === (source ? 'source-reorg' : 'hub-reorg');
  const receiptChanged = receiptBlock && fault === 'receipt-reorg'
    && readFileSync(process.env.DEMO_TEST_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(call => call.program === 'cast' && call.args[0] === 'block' && call.args[1] === '190').length > 1;
  console.log(JSON.stringify(fault === 'missing-block' ? null : {
    number: fault === 'wrong-height' && args[1] !== 'latest' ? number + 1 : number,
    hash: '0x' + (changed || receiptChanged ? 'cc' : receiptBlock ? 'dd' : source ? 'bb' : 'aa').repeat(32),
  })); process.exit(0);
}
if (args[0] === 'receipt') {
  const hash = process.env.SEPOLIA_TX, blockHash = '0x' + 'dd'.repeat(32);
  const subject = fault === 'receipt-subject' ? CONTROL : process.env.DEMO_ISSUANCE_SUBJECT;
  const log = { address: SRC, transactionHash: hash, blockHash, blockNumber: '0xbe', transactionIndex: '0x2',
    logIndex: '0x5', removed: false, topics: [
      '0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3',
      '0x' + subject.slice(2).toLowerCase().padStart(64, '0'), process.env.DEMO_ISSUANCE_ATTRS,
      '0x' + process.env.DEMO_EXPECTED_ISSUER.slice(2).toLowerCase().padStart(64, '0'),
    ], data: process.env.DEMO_ISSUANCE_CLAIMS_ROOT + process.env.DEMO_ISSUANCE_EVIDENCE_HASH.slice(2) };
  console.log(JSON.stringify({ transactionHash: hash, to: process.env.DEMO_ISSUANCE_TX_TO, status: '0x1', blockHash,
    blockNumber: '0xbe', transactionIndex: '0x2', logs: fault === 'receipt-empty' ? [] : [log] })); process.exit(0);
}
if (args[0] === 'call' || args[0] === 'code') {
  const expected = args.includes('https://synthetic-source.test') ? '200' : '100';
  if (args.filter(arg => arg === '--block').length !== 1 || args[args.indexOf('--block') + 1] !== expected) {
    throw new Error('UNPINNED READ IN STRICT SCENE');
  }
}
if (args[0] === 'code') { console.log(fault === 'runtime' ? '0x6001' : '0x6000'); process.exit(0); }
if (args[0] === 'abi-encode') { console.log('0x' + CONTROL.slice(2).toLowerCase().padStart(64, '0') + '2'.padStart(64, '0')); process.exit(0); }
if (args[0] !== 'call') throw new Error(`unexpected cast operation ${args[0]}`);
const sig = args[2]; const params = args.slice(3);
let output;
if (sig.startsWith('TRANSACTION_PROCESSING_VERSION')) output = fault === 'legacy' ? '1' : '2';
else if (/^(ROSTER_FORMAT_VERSION|POLICY_SCHEMA_VERSION|EPOCH_SCHEMA_VERSION)/.test(sig)) output = '2';
else if (/^(ROSTER_AUTH_VERSION|ROSTER_WITNESS_VERSION|policyKind)/.test(sig)) output = '1';
else if (sig.startsWith('ATTRS_SCHEMA_VERSION')) output = '0';
else if (sig.startsWith('isIssuer')) output = 'true';
else if (sig.startsWith('expectedChainKey')) output = fault === 'source-key' ? '9' : '1';
else if (sig.startsWith('sourceContract')) output = fault === 'source' ? CONTROL : SRC;
else if (sig.startsWith('ASC()')) output = ASC;
else if (sig.startsWith('REGISTRY()')) output = REG;
else if (sig.startsWith('POLICY_ID()')) output = '2';
else if (sig.startsWith('policyFrozen')) output = fault === 'unfrozen' ? 'false' : 'true';
else if (sig.startsWith('policies')) output = ['65572 [6.557e4]', '2', params[0] === '1' ? '2592000 [2.592e6]' : '604800 [6.048e5]',
  fault === 'policy' ? '0' : params[0], '410', fault === 'issuer' ? CONTROL : process.env.DEMO_EXPECTED_ISSUER, 'true', 'true'].join('\n');
else if (sig.startsWith('isVerified')) output = fault === 'verdict' ? 'true' : params[0].toLowerCase() === CONTROL.toLowerCase() || params[1] === '1' ? 'false' : 'true';
else if (sig.startsWith('canTransfer')) output = params[1].toLowerCase() === CONTROL.toLowerCase() ? 'false' : 'true';
else if (sig.startsWith('transfer') && params[0].toLowerCase() === CONTROL.toLowerCase()) {
  console.error('execution reverted, data: ' + (fault === 'revert' ? '0x118cdaa7' : '0x17887111')
    + CONTROL.slice(2).toLowerCase().padStart(64, '0') + '2'.padStart(64, '0')); process.exit(1);
} else if (sig.startsWith('transfer')) output = fault === 'allowed-transfer' ? 'false' : 'true';
else if (sig.startsWith('tombstone')) output = 'false';
else if (sig.startsWith('balanceOf')) output = '60000000000000000000 [6e19]';
else if (sig.startsWith('getMark')) output = '(1, 1, 1, 3, 2, 410, 1638439, 1, 2, 1, 0x00, 0x00, ' + process.env.DEMO_EXPECTED_ISSUER + ')';
else throw new Error(`unexpected signature ${sig}`);
console.log(output);
