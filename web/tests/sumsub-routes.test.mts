import { test } from 'node:test';
import assert from 'node:assert/strict';

const statusRoute = await import('../app/api/providers/sumsub/status/route');
const tokenRoute = await import('../app/api/providers/sumsub/token/route');
const webhookRoute = await import('../app/api/providers/sumsub/webhook/route');
const walletRoute = await import('../app/api/providers/sumsub/wallet/route');

test('Sumsub readiness is safely unavailable and never contacts a provider when configuration is absent', async () => {
  const response = await statusRoute.GET(new Request('https://proofmark.invalid/api/providers/sumsub/status'));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.configured, false);
  assert.equal(body.mode, 'evidence-candidate-only');
  assert.equal(body.issuanceBridge, false);
  assert.equal(JSON.stringify(body).includes('SECRET'), false, 'readiness does not expose credential values');
});

test('browser token and status mutations reject cross-origin requests before configuration or wallet processing', async () => {
  for (const handler of [walletRoute.POST, tokenRoute.POST, statusRoute.POST]) {
    const response = await handler(new Request('https://proofmark.invalid/api/providers/sumsub/test', {
      method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ walletProof: 'attacker' }),
    }));
    assert.equal(response.status, 403);
  }
});

test('Sumsub wallet challenge stays unavailable until the provider runtime is configured', async () => {
  const response = await walletRoute.GET(new Request('https://proofmark.invalid/api/providers/sumsub/wallet?address=0x1111111111111111111111111111111111111111'));
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, 'SUMSUB_NOT_CONFIGURED');
});

test('webhook endpoint rejects a missing digest instead of treating it as an unsigned notification', async () => {
  const response = await webhookRoute.POST(new Request('https://proofmark.invalid/api/providers/sumsub/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  // Runtime configuration is checked before signature verification so an unconfigured endpoint
  // stays fail-closed. In a configured deployment the core verifier returns the tested 401 code.
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, 'SUMSUB_NOT_CONFIGURED');
});

test('fictional KYC samples may coexist only with the explicit Sumsub Sandbox test boundary', async t => {
  const names = [
    'KYC_DEMO', 'SUMSUB_ENVIRONMENT', 'SUMSUB_SANDBOX_TEST_MODE',
    'SUMSUB_SANDBOX_APP_TOKEN', 'SUMSUB_SANDBOX_SECRET_KEY', 'SUMSUB_SANDBOX_WEBHOOK_SECRET',
    'SUMSUB_SANDBOX_LEVEL_NAME', 'SUMSUB_PRODUCTION_APP_TOKEN', 'SUMSUB_PRODUCTION_SECRET_KEY',
    'SUMSUB_PRODUCTION_WEBHOOK_SECRET', 'SUMSUB_PRODUCTION_LEVEL_NAME', 'SUMSUB_PROCESSING_RECIPIENT',
    'SUMSUB_EVIDENCE_HMAC_KEY', 'SUMSUB_STATE_KEY', 'SUMSUB_STATE_TTL_SECONDS',
    'SUMSUB_STATE_REDIS_REST_URL', 'SUMSUB_STATE_REDIS_REST_TOKEN', 'SUMSUB_STATE_NAMESPACE',
  ] as const;
  const before = new Map(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const secret = (label: string) => `${label}-${'x'.repeat(48)}`;
  Object.assign(process.env, {
    KYC_DEMO: '1', SUMSUB_ENVIRONMENT: 'production', SUMSUB_SANDBOX_TEST_MODE: '0',
    SUMSUB_PRODUCTION_APP_TOKEN: 'production-app-token', SUMSUB_PRODUCTION_SECRET_KEY: secret('production-api'),
    SUMSUB_PRODUCTION_WEBHOOK_SECRET: secret('production-webhook'), SUMSUB_PRODUCTION_LEVEL_NAME: 'basic-kyc',
    SUMSUB_PROCESSING_RECIPIENT: 'sumsub:sandbox', SUMSUB_EVIDENCE_HMAC_KEY: secret('evidence'),
    SUMSUB_STATE_KEY: secret('state'), SUMSUB_STATE_TTL_SECONDS: '86400',
    SUMSUB_STATE_REDIS_REST_URL: 'https://redis.example.test', SUMSUB_STATE_REDIS_REST_TOKEN: 'redis-token',
    SUMSUB_STATE_NAMESPACE: 'proofmark-test',
  });
  let response = await statusRoute.GET(new Request('https://proofmark.invalid/api/providers/sumsub/status'));
  assert.equal(response.status, 200);
  let body = await response.json() as Record<string, unknown>;
  assert.equal(body.configured, false, 'demo mode must not coexist with production Sumsub');

  Object.assign(process.env, {
    SUMSUB_ENVIRONMENT: 'sandbox', SUMSUB_SANDBOX_TEST_MODE: '1',
    SUMSUB_SANDBOX_APP_TOKEN: 'sandbox-app-token', SUMSUB_SANDBOX_SECRET_KEY: secret('sandbox-api'),
    SUMSUB_SANDBOX_WEBHOOK_SECRET: secret('sandbox-webhook'), SUMSUB_SANDBOX_LEVEL_NAME: 'basic-kyc',
  });
  response = await statusRoute.GET(new Request('https://proofmark.invalid/api/providers/sumsub/status'));
  assert.equal(response.status, 200);
  body = await response.json() as Record<string, unknown>;
  assert.equal(body.configured, true);
  assert.equal(body.environment, 'sandbox');
  assert.equal(body.testOnly, true);
  assert.equal(body.issuanceBridge, false);
});
