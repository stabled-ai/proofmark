import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foundrySummary, nodeSummary, rootTestFiles, testSourceFingerprint, verifyTestEvidence, type TestEvidence } from '../pipeline/test-evidence.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const startedAt = Date.now();
const fingerprint = testSourceFingerprint(repo);
const files = rootTestFiles(repo);
function run(program: string, args: string[]): string {
  const result = spawnSync(program, args, { cwd: repo, encoding: 'utf8', timeout: 180_000, maxBuffer: 30_000_000 });
  if (result.error || result.status !== 0) {
    const diagnostics = result.stdout?.split('\n').flatMap((line) => {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: { file?: string; name?: string; success?: boolean; counts?: unknown; details?: unknown };
        };
        if (event.type === 'test:fail') {
          return [JSON.stringify({ type: event.type, file: event.data?.file, name: event.data?.name, details: event.data?.details })];
        }
        if (event.type === 'test:summary' && event.data?.success === false) {
          return [JSON.stringify({ type: event.type, file: event.data.file, counts: event.data.counts })];
        }
      } catch {
        // Ignore non-JSON reporter output and retain the concise stderr tail below.
      }
      return [];
    }) ?? [];
    console.error(diagnostics.join('\n'));
    console.error(result.stderr?.slice(-4000));
    throw new Error(`test command failed; no passing evidence produced: ${program}`);
  }
  return result.stdout;
}
console.log('Running complete Foundry and root TypeScript/ABI test suites; no network deployment.');
const solidity = foundrySummary(run('forge', ['test', '--json']));
// Several integration files launch isolated Anvil or worker processes. Bounding file-level
// concurrency keeps the complete suite deterministic on small CI runners without reducing coverage.
const typescript = nodeSummary(run(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2',
  '--test-reporter=./script/test-summary-reporter.mjs', ...files]));
if (testSourceFingerprint(repo) !== fingerprint) throw new Error('source changed while tests ran; evidence discarded');
const evidence: TestEvidence = { version: 1, sourceFingerprint: fingerprint, startedAt, completedAt: Date.now(),
  nodeVersion: process.version, forgeVersion: execFileSync('forge', ['--version'], { encoding: 'utf8' }).trim(), solidity, typescript, testFiles: files };
verifyTestEvidence(evidence, fingerprint, files);
const outputRoot = join(repo, 'artifacts/test-evidence'); mkdirSync(outputRoot, { recursive: true });
const runDir = mkdtempSync(join(outputRoot, 'run-'));
const path = join(runDir, 'report.json');
writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const latest = join(runDir, 'latest.tmp'); writeFileSync(latest, readFileSync(path), { flag: 'wx', mode: 0o600 });
renameSync(latest, join(outputRoot, 'latest.json'));
console.log(`PASS local test evidence: Solidity ${solidity.passed}, TypeScript ${typescript.passed}; ${path}`);
console.log('Unsigned local execution evidence only; not deployment, external CI, legal or submission approval.');
