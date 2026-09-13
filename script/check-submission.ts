/** Static, offline assertions for claims that appear in the public submission. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootTestFiles, testSourceFingerprint, verifyTestEvidence } from '../pipeline/test-evidence.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--docs-only')) throw new Error('usage: check:submission [--docs-only]');
const docsOnly = args[0] === '--docs-only';
const deployment = JSON.parse(read('deployments/cc3-testnet.json')) as {
  release?: string;
  contracts: Record<string, string>;
  roles?: Record<string, string>;
  governance?: Record<string, string>;
};

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  const state = condition ? 'PASS' : 'FAIL';
  console.log(`${state}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

const readme = read('README.md');
const dorahacks = read('docs/submission/dorahacks.md');
const integrationSummary = read('docs/submission/integration-summary.md');
const strictCommands = read('docs/demo-video/commands-v2.sh');
const submissionVerifier = read('scripts/verify-submission.sh');
const narration = read('docs/demo-video/NARRATION.md');

check('default deployment manifest identifies the v2 release', deployment.release === 'v2-live', deployment.release ?? 'missing');
for (const [name, address] of Object.entries(deployment.contracts)) {
  check(`${name} address in README`, readme.includes(address), address);
  if (['ProofmarkASC', 'ProofmarkRegistry', 'ComplianceSource', 'GatedRwaNote'].includes(name)) {
    check(`${name} address in strict read-only commands`, strictCommands.includes(address), address);
  }
}

const roleAddresses = Object.values({ ...(deployment.roles ?? {}), ...(deployment.governance ?? {}) }).map(value => value.toLowerCase());
check('v2 manifest separates operational and governance roles',
  roleAddresses.length >= 9 && new Set(roleAddresses).size === roleAddresses.length,
  `${new Set(roleAddresses).size}/${roleAddresses.length} distinct`);

check('README names USC and the native proof boundary',
  readme.includes('Universal Smart Contracts (USC)')
  && readme.includes('verifyAndEmit')
  && readme.includes('BlockProver'));
check('README discloses the hosted sandbox boundary',
  readme.includes('hosted sandbox') && readme.includes('demo:id') && readme.includes('demo:bank'));
check('DoraHacks copy leads with the cross-chain READ thesis',
  dorahacks.includes('One READ for every chain') && dorahacks.includes('isVerified(wallet, policyId)'));
check('USC integration copy names the SDK, contracts package and BlockProver',
  integrationSummary.includes('@gluwa/usc-sdk')
  && integrationSummary.includes('@gluwa/usc-contracts')
  && integrationSummary.includes('BlockProver'));
check('standalone integration summary remains present', integrationSummary.trim().length > 0);

const narrationWords = narration
  .split('\n')
  .filter((line) => line.startsWith('> '))
  .map((line) => line.slice(2))
  .join(' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean).length;
check('narration stays inside the 450-word budget', narrationWords <= 450, `${narrationWords}/450 words`);
check('submission verifier is read-only',
  submissionVerifier.includes('export RECORD=0')
  && !submissionVerifier.includes('RECORD=1'));

if (docsOnly) {
  console.log('NOT CHECKED  test execution evidence (--docs-only); no test-count or release-readiness claim');
} else {
  try {
    const files = rootTestFiles(repo);
    const evidence = verifyTestEvidence(JSON.parse(read('artifacts/test-evidence/latest.json')), testSourceFingerprint(repo), files);
    check('actual local test execution matches current source and complete test-file set', true,
      `Solidity ${evidence.solidity.passed}; TypeScript/ABI ${evidence.typescript.passed}; ${evidence.sourceFingerprint}`);
  } catch {
    check('actual local test execution evidence', false, 'missing, failed, expired or source changed; run npm run test:evidence');
  }
}

if (failures) {
  console.error(`\n${failures} submission assertion(s) failed.`);
  process.exit(1);
}
console.log('\nPASS public documentation checks' + (docsOnly ? ' only.' : ' and source-bound local test evidence.'));
console.log('NOT VERIFIED: current USC materialisation, hosted cutover, video, external reproduction, legal approval or customer adoption.');
