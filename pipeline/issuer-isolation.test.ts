import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertIssuerReleaseProfile } from './issuer-isolation.js';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b1';

test('legacy scope-v0 release cannot be presented as isolated with two issuers', () => {
  assert.throws(
    () => assertIssuerReleaseProfile({
      mode: 'independent-issuer-scoped',
      stableIssuers: [A, B],
      policyIssuers: [A, B],
    }),
    /SCOPED_ISSUER_PROTOCOL_NOT_IMPLEMENTED/,
  );
});

test('release guard requires a product decision and rejects unknown modes', () => {
  assert.throws(
    () => assertIssuerReleaseProfile({ mode: undefined, stableIssuers: [A], policyIssuers: [A] }),
    /ISSUER_ISOLATION_DECISION_REQUIRED/,
  );
  assert.throws(
    () => assertIssuerReleaseProfile({ mode: 'multi', stableIssuers: [A], policyIssuers: [A] }),
    /INVALID_ISSUER_MODE/,
  );
});

test('legacy single-issuer profile pins every consumer policy to one stable identity', () => {
  assert.doesNotThrow(() => assertIssuerReleaseProfile({
    mode: 'single-issuer',
    stableIssuers: [A],
    policyIssuers: [A, A.toUpperCase().replace('0X', '0x')],
  }));
  assert.throws(
    () => assertIssuerReleaseProfile({ mode: 'single-issuer', stableIssuers: [A, B], policyIssuers: [A] }),
    /SINGLE_ISSUER_REQUIRES_ONE_STABLE_IDENTITY/,
  );
  assert.throws(
    () => assertIssuerReleaseProfile({ mode: 'single-issuer', stableIssuers: [A], policyIssuers: [A, B] }),
    /SINGLE_ISSUER_POLICY_MUST_PIN_STABLE_IDENTITY/,
  );
  assert.throws(
    () => assertIssuerReleaseProfile({ mode: 'single-issuer', stableIssuers: [A], policyIssuers: [] }),
    /SINGLE_ISSUER_POLICY_MUST_PIN_STABLE_IDENTITY/,
  );
  assert.throws(
    () => assertIssuerReleaseProfile({ mode: 'single-issuer', stableIssuers: [A], policyIssuers: [ethersZero] }),
    /INVALID_POLICY_ISSUER/,
  );
});

const ethersZero = '0x0000000000000000000000000000000000000000';

test('issuer mode CLI is fail-closed and reports only the release profile', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = (...args: string[]) => spawnSync(
    process.execPath,
    ['--import', 'tsx', 'script/check-issuer-mode.ts', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ISSUER_ISOLATION_DECISION_REQUIRED/);
  const scoped = run('independent-issuer-scoped', A);
  assert.equal(scoped.status, 1);
  assert.match(scoped.stderr, /SCOPED_ISSUER_PROTOCOL_NOT_IMPLEMENTED/);
  const single = run('single-issuer', A);
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout, /scopeVersion=0; one pinned stable issuer/);
});

test('deployment preflight invokes the guard before its first transaction and records the mode', () => {
  const source = readFileSync(new URL('../script/deploy.sh', import.meta.url), 'utf8');
  const guard = source.indexOf('script/check-issuer-mode.ts');
  const transactionBoundary = source.indexOf('Sending real transactions now');
  assert.notEqual(guard, -1);
  assert.ok(guard < transactionBoundary);
  assert.match(source, /need PROOFMARK_ISSUER_MODE/);
  assert.match(source, /"issuerMode": "\$PROOFMARK_ISSUER_MODE"/);
});
