import 'server-only';

import { SumsubClient, SumsubError, applySumsubWebhookFence, retainSumsubWebhookFence,
  type SumsubEvidenceCandidate } from '@pipeline/providers/sumsub.js';
import type { SumsubDecision } from '@pipeline/providers/sumsub.js';
import { RedisSumsubStateStore, SumsubStateError } from '@pipeline/providers/sumsub-redis.js';
import { InMemorySumsubStateStore, type SumsubSessionRecord, type SumsubStateStore } from '@pipeline/providers/sumsub-state.js';
import { SUMSUB_SANDBOX_TEST_IDENTITY_POLICY, SUMSUB_SANDBOX_TEST_RETENTION_POLICY,
  sumsubSandboxTestProcessingPolicy } from '@pipeline/providers/sumsub-sandbox-policy.js';
import { ProcessingPolicyError, authorizeProcessing, policyBinding, processingConsentStatement,
  type ProcessingPolicyBindingV1, type ProcessingPolicyV1 } from '@pipeline/privacy-processing-policy.js';
import { RetentionPolicyError, assertRetentionBinding, retentionConsentStatement, retentionPolicyBinding,
  type RetentionPolicyBindingV1, type RetentionPolicyV1 } from '@pipeline/retention-policy.js';
import { consentTextHash } from '@pipeline/privacy-processing-policy.js';
import { getAddress, isAddress, verifyMessage, type Hex } from 'viem';
import { ConfigError, TokenError, newNonce, open, seal, siweMessage, type SiweFields } from './kyc-server';
import { processingPolicyContext } from './privacy-processing-policy-server';
import { retentionPolicyContext } from './retention-policy-server';
import { identityPolicyForIssuance } from './identity-policy-server';
import { privateJson } from './private-response';

const env = (name: string) => process.env[name]?.trim() || undefined;
const ALL_ENV = [
  'SUMSUB_ENVIRONMENT', 'SUMSUB_SANDBOX_APP_TOKEN', 'SUMSUB_SANDBOX_SECRET_KEY', 'SUMSUB_SANDBOX_WEBHOOK_SECRET',
  'SUMSUB_SANDBOX_LEVEL_NAME', 'SUMSUB_PRODUCTION_APP_TOKEN', 'SUMSUB_PRODUCTION_SECRET_KEY',
  'SUMSUB_PRODUCTION_WEBHOOK_SECRET', 'SUMSUB_PRODUCTION_LEVEL_NAME', 'SUMSUB_PROCESSING_RECIPIENT',
  'SUMSUB_EVIDENCE_HMAC_KEY', 'SUMSUB_STATE_REDIS_REST_URL', 'SUMSUB_STATE_REDIS_REST_TOKEN',
  'SUMSUB_STATE_KEY', 'SUMSUB_STATE_TTL_SECONDS', 'SUMSUB_STATE_NAMESPACE', 'SUMSUB_STATE_MODE', 'SUMSUB_LOCAL_TEST',
  'SUMSUB_SDK_TTL_SECONDS',
  'SUMSUB_WEBHOOK_MAX_AGE_SECONDS', 'SUMSUB_SANDBOX_TEST_MODE', 'IDENTITY_POLICY_JSON', 'PROCESSING_POLICY_JSON',
  'RETENTION_POLICY_JSON', 'KYC_DEMO', 'SERVER_TOKEN_KEY', 'SERVER_TOKEN_KEY_ID',
] as const;

type ProviderProof = {
  externalUserId: string; environment: 'sandbox' | 'production'; levelName: string;
  walletAddress: string; flowId: string; identityPolicyId: string;
  processingPolicyFingerprint: string; retentionPolicyFingerprint: string;
};

type SumsubWalletFlow = {
  provider: 'sumsub';
  environment: 'sandbox' | 'production';
  address: string;
  flowId: string;
  consentVersion: string;
  consentStatementHash: string;
  processingPolicy: ProcessingPolicyBindingV1;
  retentionPolicy: RetentionPolicyBindingV1;
  at: number;
};

type SumsubChallenge = SiweFields & {
  provider: 'sumsub';
  environment: 'sandbox' | 'production';
  testOnly: boolean;
};

type SumsubPolicies = {
  testOnly: boolean;
  identity: ReturnType<typeof identityPolicyForIssuance>;
  processing: {
    policy: Readonly<ProcessingPolicyV1>;
    binding: ProcessingPolicyBindingV1;
    consentStatement: string;
  };
  retention: {
    policy: Readonly<RetentionPolicyV1>;
    binding: RetentionPolicyBindingV1;
    consentStatement: string;
  };
};

let built: { client: SumsubClient; store: SumsubStateStore } | null = null;

function required(name: string): string {
  const value = env(name); if (!value) throw new ConfigError('Sumsub provider is not configured', [name]); return value;
}

export function sumsubRuntime(): { client: SumsubClient; store: SumsubStateStore } {
  if (built) return built;
  const environment = required('SUMSUB_ENVIRONMENT');
  if (environment !== 'sandbox' && environment !== 'production') throw new ConfigError('SUMSUB_ENVIRONMENT must be sandbox or production', ['SUMSUB_ENVIRONMENT']);
  // The public demo may expose both fictional guided samples and Sumsub's official Sandbox test
  // documents. Never let KYC_DEMO weaken the boundary around production Sumsub processing.
  if (env('KYC_DEMO') === '1' && (environment !== 'sandbox' || env('SUMSUB_SANDBOX_TEST_MODE') !== '1')) {
    throw new ConfigError('Sumsub production processing is disabled while KYC_DEMO is enabled',
      ['KYC_DEMO', 'SUMSUB_ENVIRONMENT', 'SUMSUB_SANDBOX_TEST_MODE']);
  }
  const prefix = environment === 'sandbox' ? 'SUMSUB_SANDBOX' : 'SUMSUB_PRODUCTION';
  const appToken = required(`${prefix}_APP_TOKEN`), secretKey = required(`${prefix}_SECRET_KEY`);
  const webhookSecret = required(`${prefix}_WEBHOOK_SECRET`), levelName = required(`${prefix}_LEVEL_NAME`);
  const evidenceHmacKey = required('SUMSUB_EVIDENCE_HMAC_KEY'), stateKey = required('SUMSUB_STATE_KEY');
  const secrets = [appToken, secretKey, webhookSecret, evidenceHmacKey, stateKey];
  if (new Set(secrets).size !== secrets.length) throw new ConfigError('Sumsub credentials and custody keys must be distinct',
    [`${prefix}_APP_TOKEN`, `${prefix}_SECRET_KEY`, `${prefix}_WEBHOOK_SECRET`, 'SUMSUB_EVIDENCE_HMAC_KEY', 'SUMSUB_STATE_KEY']);
  const sdkTtl = Number(env('SUMSUB_SDK_TTL_SECONDS') ?? 600);
  const webhookAge = Number(env('SUMSUB_WEBHOOK_MAX_AGE_SECONDS') ?? 600) * 1000;
  const stateTtl = Number(required('SUMSUB_STATE_TTL_SECONDS'));
  const client = new SumsubClient({ environment, appToken, secretKey, webhookSecret, levelName,
    processingRecipient: required('SUMSUB_PROCESSING_RECIPIENT'), evidenceHmacKey,
    sdkTokenTtlSeconds: sdkTtl, maxWebhookAgeMs: webhookAge });
  const memory = env('SUMSUB_STATE_MODE') === 'memory';
  if (memory && (environment !== 'sandbox' || env('SUMSUB_SANDBOX_TEST_MODE') !== '1'
    || env('SUMSUB_LOCAL_TEST') !== '1' || env('VERCEL') === '1')) {
    throw new ConfigError('memory state is restricted to local Sumsub sandbox testing', ['SUMSUB_STATE_MODE']);
  }
  const store = memory ? new InMemorySumsubStateStore()
    : new RedisSumsubStateStore(required('SUMSUB_STATE_REDIS_REST_URL'), required('SUMSUB_STATE_REDIS_REST_TOKEN'),
      stateKey, stateTtl, fetch, env('SUMSUB_STATE_NAMESPACE') ?? 'proofmark');
  built = { client, store }; return built;
}

function sandboxTestMode(client: SumsubClient): boolean {
  const enabled = env('SUMSUB_SANDBOX_TEST_MODE') === '1';
  if (enabled && client.environment !== 'sandbox') {
    throw new ConfigError('SUMSUB_SANDBOX_TEST_MODE is valid only with Sumsub sandbox credentials', ['SUMSUB_SANDBOX_TEST_MODE', 'SUMSUB_ENVIRONMENT']);
  }
  return enabled;
}

function currentPolicies(client: SumsubClient): SumsubPolicies {
  const testOnly = sandboxTestMode(client);
  if (testOnly) {
    const policy = sumsubSandboxTestProcessingPolicy(client.processingRecipient);
    return {
      testOnly,
      identity: SUMSUB_SANDBOX_TEST_IDENTITY_POLICY,
      processing: { policy, binding: policyBinding(policy), consentStatement: processingConsentStatement(policy) },
      retention: { policy: SUMSUB_SANDBOX_TEST_RETENTION_POLICY,
        binding: retentionPolicyBinding(SUMSUB_SANDBOX_TEST_RETENTION_POLICY),
        consentStatement: retentionConsentStatement(SUMSUB_SANDBOX_TEST_RETENTION_POLICY) },
    };
  }
  const identity = identityPolicyForIssuance(false);
  const processing = processingPolicyContext(false);
  const retention = retentionPolicyContext(false, processing.policy.customerId);
  return { testOnly, identity, processing, retention };
}

function assertPolicies(policies: SumsubPolicies, processing: ProcessingPolicyBindingV1, retention: RetentionPolicyBindingV1,
  client: SumsubClient): void {
  try {
    authorizeProcessing(policies.processing.policy, processing, { stage: 'id_document', recipient: client.processingRecipient,
      data: ['identity_document_image', 'identity_fields', 'biometric_template', 'screening_result', 'credential_metadata'] });
  } catch (error) {
    if (error instanceof ProcessingPolicyError && error.code === 'PROCESSING_POLICY_CHANGED') throw new TokenError(error.message);
    throw new ConfigError('the current processing policy does not authorize this Sumsub request', ['PROCESSING_POLICY_JSON']);
  }
  try { assertRetentionBinding(policies.retention.policy, retention); }
  catch (error) {
    if (error instanceof RetentionPolicyError && error.code === 'RETENTION_POLICY_CHANGED') throw new TokenError(error.message);
    throw new ConfigError('the current retention policy does not authorize this Sumsub request', ['RETENTION_POLICY_JSON']);
  }
}

function sumsubFlowFromWalletToken(token: unknown): SumsubWalletFlow & { exp: number } {
  const flow = open<SumsubWalletFlow>('sumsub-wallet', token);
  if (flow.provider !== 'sumsub' || !flow.flowId || !flow.address
    || (flow.environment !== 'sandbox' && flow.environment !== 'production')
    || !flow.processingPolicy || flow.processingPolicy.schema !== 'proofmark-processing-policy-binding-v1'
    || !flow.retentionPolicy || flow.retentionPolicy.schema !== 'proofmark-retention-policy-binding-v1'
    || !/^0x[0-9a-fA-F]{64}$/.test(flow.consentStatementHash)
    || flow.consentVersion !== flow.processingPolicy.noticeVersion) {
    throw new TokenError('Sumsub wallet token has no current provider flow and consent binding');
  }
  return flow;
}

function authorizeWallet(walletProof: unknown, client: SumsubClient) {
  const wallet = sumsubFlowFromWalletToken(walletProof);
  if (wallet.environment !== client.environment) throw new TokenError('Sumsub wallet token belongs to a different environment');
  const policies = currentPolicies(client);
  const identity = policies.identity;
  if (identity.biometrics.mode !== 'authorized' || !identity.biometrics.checks.includes('face_match')
    || !identity.biometrics.checks.includes('liveness')) {
    throw new ConfigError('this Sumsub document-and-liveness flow requires prior face-match and liveness authorization', ['IDENTITY_POLICY_JSON']);
  }
  assertPolicies(policies, wallet.processingPolicy, wallet.retentionPolicy, client);
  return { wallet, identity };
}

function proofFor(record: SumsubSessionRecord): ProviderProof {
  return { externalUserId: record.externalUserId, environment: record.environment, levelName: record.levelName,
    walletAddress: record.walletAddress, flowId: record.flowId, identityPolicyId: record.identityPolicyId,
    processingPolicyFingerprint: record.processingPolicyFingerprint, retentionPolicyFingerprint: record.retentionPolicyFingerprint };
}

function assertRecord(record: SumsubSessionRecord, proof: ProviderProof, wallet: SumsubWalletFlow & { exp: number }, client: SumsubClient) {
  if (proof.flowId !== wallet.flowId || proof.walletAddress?.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new TokenError('Sumsub provider token belongs to a different wallet verification flow');
  }
  if (record.environment !== client.environment || proof.environment !== client.environment || record.levelName !== client.levelName
    || proof.levelName !== client.levelName || record.externalUserId !== proof.externalUserId
    || record.walletAddress.toLowerCase() !== wallet.address.toLowerCase() || record.flowId !== wallet.flowId
    || record.identityPolicyId !== proof.identityPolicyId
    || record.processingPolicyFingerprint !== wallet.processingPolicy.fingerprint
    || proof.processingPolicyFingerprint !== wallet.processingPolicy.fingerprint
    || record.retentionPolicyFingerprint !== wallet.retentionPolicy.fingerprint
    || proof.retentionPolicyFingerprint !== wallet.retentionPolicy.fingerprint) throw new TokenError('Sumsub session binding mismatch');
}

/** Webhooks have no browser token, but policy withdrawal must still stop provider reads. The
 * stored fingerprints are compared with today's approved manifests before contacting Sumsub. */
function authorizeStoredRecord(record: SumsubSessionRecord, client: SumsubClient): void {
  const policies = currentPolicies(client);
  const identity = policies.identity;
  if (identity.policyId !== record.identityPolicyId || identity.biometrics.mode !== 'authorized'
    || !identity.biometrics.checks.includes('face_match') || !identity.biometrics.checks.includes('liveness')) {
    throw new ConfigError('the identity policy no longer authorizes this provider session', ['IDENTITY_POLICY_JSON']);
  }
  if (policies.processing.binding.fingerprint !== record.processingPolicyFingerprint) throw new TokenError('processing policy changed after provider consent');
  if (policies.retention.binding.fingerprint !== record.retentionPolicyFingerprint) throw new TokenError('retention policy changed after provider consent');
  assertPolicies(policies, policies.processing.binding, policies.retention.binding, client);
}

function consentStatement(policies: SumsubPolicies): string {
  const scope = policies.testOnly
    ? 'Sumsub Sandbox integration test only. Use official Sumsub test documents and do not submit real personal data. This flow cannot issue a Proofmark credential.'
    : 'Sumsub hosted identity verification.';
  return `${scope} ${policies.processing.consentStatement} ${policies.retention.consentStatement}`;
}

export function createSumsubWalletChallenge(requestUrl: string, rawAddress: string) {
  if (!isAddress(rawAddress)) throw new TokenError('address is not an Ethereum address');
  const url = new URL(requestUrl);
  const { client } = sumsubRuntime();
  const policies = currentPolicies(client);
  const address = getAddress(rawAddress);
  const now = new Date();
  const fields: SumsubChallenge = {
    provider: 'sumsub', environment: client.environment, testOnly: policies.testOnly,
    domain: url.host, address, uri: `${url.origin}/verify/provider`, nonce: newNonce(),
    issuedAt: now.toISOString(), expirationTime: new Date(now.getTime() + 10 * 60_000).toISOString(),
    processingPolicy: policies.processing.binding, retentionPolicy: policies.retention.binding,
    statement: consentStatement(policies),
  };
  return { message: siweMessage(fields), token: seal('sumsub-siwe', fields, 600),
    processingPolicy: policies.processing.binding, retentionPolicy: policies.retention.binding,
    environment: client.environment, testOnly: policies.testOnly };
}

export async function verifySumsubWalletChallenge(requestUrl: string, token: unknown, signature: unknown) {
  const fields = open<SumsubChallenge>('sumsub-siwe', token);
  const url = new URL(requestUrl);
  const { client } = sumsubRuntime();
  const policies = currentPolicies(client);
  if (fields.provider !== 'sumsub' || fields.environment !== client.environment || fields.testOnly !== policies.testOnly
    || fields.domain !== url.host || new URL(fields.uri).origin !== url.origin || fields.uri !== `${url.origin}/verify/provider`
    || !fields.processingPolicy || !fields.retentionPolicy || fields.statement !== consentStatement(policies)) {
    throw new TokenError('Sumsub wallet message origin, policy, or environment changed');
  }
  assertPolicies(policies, fields.processingPolicy, fields.retentionPolicy, client);
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new TokenError('signature must be a 65-byte hex string');
  }
  const message = siweMessage(fields);
  const valid = await verifyMessage({ address: fields.address as `0x${string}`, message, signature: signature as Hex }).catch(() => false);
  if (!valid) throw new TokenError('the signature does not match the wallet');
  const now = Date.now();
  const walletProof = seal('sumsub-wallet', { provider: 'sumsub', environment: client.environment,
    address: fields.address, flowId: fields.nonce, consentVersion: policies.processing.policy.notice.version,
    processingPolicy: policies.processing.binding, retentionPolicy: policies.retention.binding,
    consentStatementHash: consentTextHash(fields.statement), at: now }, 30 * 60);
  const flow = sumsubFlowFromWalletToken(walletProof);
  return { address: fields.address, walletProof, walletExpiresAt: flow.exp, serverTime: now,
    processingPolicy: policies.processing.binding, retentionPolicy: policies.retention.binding,
    environment: client.environment, testOnly: policies.testOnly };
}

export async function createSumsubSdkToken(walletProof: unknown, providerProof?: unknown) {
  const { client, store } = sumsubRuntime(); const { wallet, identity } = authorizeWallet(walletProof, client);
  const externalUserId = client.makeExternalUserId(wallet.address, wallet.flowId);
  const now = Date.now();
  const record: SumsubSessionRecord = { version: 1, revision: 1, externalUserId, environment: client.environment,
    walletAddress: wallet.address, flowId: wallet.flowId, levelName: client.levelName, identityPolicyId: identity.policyId,
    processingPolicyFingerprint: wallet.processingPolicy.fingerprint, retentionPolicyFingerprint: wallet.retentionPolicy.fingerprint,
    createdAt: now, expiresAt: wallet.exp };
  const created = await store.create(record);
  if (created === 'conflict') throw new TokenError('Sumsub session conflicts with a prior wallet flow');
  if (providerProof !== undefined) {
    const proof = open<ProviderProof>('sumsub-provider', providerProof); const saved = await store.get(externalUserId);
    if (!saved) throw new TokenError('Sumsub session is unavailable'); assertRecord(saved, proof, wallet, client);
  }
  const token = await client.createSdkToken(externalUserId);
  return { accessToken: token.token, expiresIn: token.expiresIn, environment: client.environment, levelName: client.levelName,
    providerProof: seal('sumsub-provider', proofFor(record), Math.min(30 * 60, Math.max(1, Math.floor((wallet.exp - now) / 1000)))) };
}

export async function currentSumsubStatus(walletProof: unknown, providerToken: unknown): Promise<SumsubEvidenceCandidate> {
  const { client, store } = sumsubRuntime(); const { wallet, identity } = authorizeWallet(walletProof, client);
  const proof = open<ProviderProof>('sumsub-provider', providerToken);
  const record = await store.get(proof.externalUserId); if (!record) throw new TokenError('Sumsub session is unavailable');
  assertRecord(record, proof, wallet, client);
  if (identity.policyId !== record.identityPolicyId) throw new TokenError('identity policy changed; start a new provider flow');
  const current = retainSumsubWebhookFence(await client.evaluate({ walletAddress: record.walletAddress, flowId: record.flowId,
    externalUserId: record.externalUserId, processingPolicyFingerprint: record.processingPolicyFingerprint,
    retentionPolicyFingerprint: record.retentionPolicyFingerprint }), record.latest);
  return store.saveObservation(record.externalUserId, current, record.revision);
}

export async function acceptSumsubWebhook(raw: Uint8Array, headers: Headers): Promise<{ accepted: boolean; reason?: string; status?: SumsubDecision }> {
  const { client, store } = sumsubRuntime(); const webhook = client.verifyWebhook(raw, headers);
  // Dashboard test deliveries prove URL and HMAC configuration only. They never read or mutate session state.
  if (webhook.testMode) return { accepted: false, reason: 'test' };
  const record = await store.get(webhook.externalUserId);
  if (!record || record.environment !== client.environment || record.levelName !== client.levelName) throw new SumsubError('SUMSUB_WEBHOOK_SUBJECT_UNKNOWN', 404);
  authorizeStoredRecord(record, client);
  // Re-evaluate before claiming. A transient upstream failure therefore leaves the event retryable.
  const fetched = await client.evaluate({ walletAddress: record.walletAddress, flowId: record.flowId,
    externalUserId: record.externalUserId, processingPolicyFingerprint: record.processingPolicyFingerprint,
    retentionPolicyFingerprint: record.retentionPolicyFingerprint });
  if (!client.matchesApplicant(fetched, webhook.applicantId)) throw new SumsubError('SUMSUB_WEBHOOK_APPLICANT_MISMATCH', 409);
  const current = retainSumsubWebhookFence(applySumsubWebhookFence(fetched, webhook), record.latest);
  const claim = await store.applyWebhook(record.externalUserId, webhook.digest, webhook.createdAtMs, fetched.applicantIdHash, current);
  if (claim === 'duplicate' || claim === 'stale') return { accepted: false, reason: claim };
  if (claim !== 'fresh') throw new SumsubError('SUMSUB_WEBHOOK_CONFLICT', 409);
  const committed = await store.get(record.externalUserId);
  if (!committed?.latest) throw new SumsubStateError('SUMSUB_STATE_UNAVAILABLE');
  return { accepted: true, status: committed.latest.decision };
}

export function sumsubConfigStatus() {
  try {
    const { client } = sumsubRuntime();
    const policies = currentPolicies(client);
    const identity = policies.identity;
    if (identity.biometrics.mode !== 'authorized' || !identity.biometrics.checks.includes('face_match') || !identity.biometrics.checks.includes('liveness')) {
      throw new ConfigError('Sumsub biometric checks are not authorized', ['IDENTITY_POLICY_JSON']);
    }
    assertPolicies(policies, policies.processing.binding, policies.retention.binding, client);
    return { configured: true, provider: 'sumsub', environment: client.environment,
      levelName: client.levelName, sdk: 'websdk-2', mode: 'evidence-candidate-only', testOnly: policies.testOnly,
      methods: 'pending-step-evidence', issuanceBridge: false, missing: [] as string[] };
  }
  catch (error) { return { configured: false, provider: 'sumsub', environment: null, levelName: null, sdk: 'websdk-2',
    mode: 'evidence-candidate-only', testOnly: false, methods: 'pending-step-evidence', issuanceBridge: false,
    missing: error instanceof ConfigError ? error.missing.filter(name => (ALL_ENV as readonly string[]).includes(name)) : [] }; }
}

export function sumsubPublicError(error: unknown): Response {
  if (error instanceof ConfigError) return privateJson({ error: 'Sumsub provider is not configured for an approved processing flow.', code: 'SUMSUB_NOT_CONFIGURED', missing: error.missing }, { status: 503 });
  if (error instanceof TokenError) return privateJson({ error: error.message, code: 'SUMSUB_SESSION_INVALID' }, { status: 400 });
  if (error instanceof SumsubError) return privateJson({ error: 'Sumsub provider request could not be confirmed.', code: error.code }, { status: error.status });
  if (error instanceof SumsubStateError) return privateJson({ error: 'Sumsub session state is unavailable.', code: error.code }, { status: 503 });
  return privateJson({ error: 'Sumsub provider request failed.', code: 'SUMSUB_INTERNAL' }, { status: 500 });
}
