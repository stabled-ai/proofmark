import { privateJson } from '@/lib/private-response';
import { issuanceRequestId } from '@/lib/issuance-request';
import { TokenError, assertSameFlow, flowFromWalletToken, getAdapter, open, type FlowBinding } from '@/lib/kyc-server';
import { publicConfigFailure } from '@/lib/public-errors';
import { guardError, guardRequest } from '@/lib/request-guard';
import { BODY_LIMITS, readJsonObject } from '@/lib/request-body';
import { getEngine } from '@/lib/aml-server';
import { runIssuance } from '@pipeline/issue.js';
import { Methods } from '@pipeline/methods.js';
import type { BankAccountResult, IdDocumentResult } from '@pipeline/adapters/kr.js';
import { buildEvidenceRecord, issuanceEvidenceSink } from '@/lib/evidence-vault';
import { issuanceBudget, issuanceFingerprint, issuanceJournal, issuancePolicyObservation, issuanceTarget, issuanceTrackingStatus, issuanceTransport } from '@/lib/issuance-server';
import { IssuanceJournalError, type IssuanceEntry, type IssuanceJournal } from '@pipeline/issuance-journal.js';
import { IssuanceBudgetError } from '@pipeline/issuance-budget.js';
import { advanceIssuance } from '@pipeline/issuance-delivery.js';
import { issuanceProgress } from '@pipeline/issuance-status.js';
import { identityPolicyForIssuance } from '@/lib/identity-policy-server';
import { unpackAttrs } from '@pipeline/attrs.js';
import { authorizeCurrentProcessing } from '@/lib/privacy-processing-policy-server';
import type { ProcessingPolicyEvidenceV1 } from '@pipeline/privacy-processing-policy.js';
import { authorizeCurrentRetention } from '@/lib/retention-policy-server';

const fail = (e: unknown, requestId?: string) => {
  const guarded = guardError(e); if (guarded) return guarded;
  const configured = publicConfigFailure(e, requestId); if (configured) return configured;
  if (e instanceof IssuanceJournalError) return privateJson({ error: e.code, code: e.code, resumable: true, requestId }, {
    status: e.code === 'NOT_FOUND' ? 404 : ['REQUEST_BUSY', 'SIGNER_BUSY', 'REVISION_CONFLICT', 'LEASE_LOST'].includes(e.code) ? 409 : 503,
  });
  if (e instanceof IssuanceBudgetError) return privateJson({ error: e.code, code: e.code, resumable: true, requestId }, {
    status: ['DAILY_GAS_BUDGET_EXCEEDED', 'DAILY_TRANSACTION_BUDGET_EXCEEDED'].includes(e.code) ? 429 : 503,
  });
  if (e instanceof TokenError) return privateJson({ error: e.message }, { status: 400 });
  return privateJson({ error: 'internal issuance error', requestId }, { status: 500 });
};

const ISO2 = /^[A-Z]{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Steps 3 to 6. JSON: { walletProof, declared, idProof?, bankProof? }.
 * Reconciliation, AML screening against the source lists, the claims commitment, attrs packing,
 * then journaled `ComplianceSource.issueOnce()` on Sepolia. The worker carries it to CC3.
 */
export async function handleIssuanceRequest(req: Request, forcedAction?: 'status') {
  let knownRequestId: string | undefined;
  try {
    guardRequest(req, { bucket: 'kyc-issue-request', limit: 120, windowMs: 10 * 60_000, maxBodyBytes: BODY_LIMITS.issue, sameOrigin: true });
    const body = await readJsonObject(req, BODY_LIMITS.issue);
    const wallet = flowFromWalletToken(body.walletProof);
    const action = forcedAction ?? String(body.action ?? 'issue');
    if (!['issue', 'resume', 'status', 'retry'].includes(action)) return privateJson({ error: 'action must be issue, resume, status or retry' }, { status: 400 });
    const derivedId = issuanceRequestId(wallet.address, wallet.flowId);
    const requestId = action === 'issue' ? derivedId : String(body.requestId ?? derivedId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) return privateJson({ error: 'invalid requestId' }, { status: 400 });
    knownRequestId = requestId;
    const journal = issuanceJournal();
    let snapshot = await journal.get(requestId);
    if (snapshot && snapshot.entry.wallet.toLowerCase() !== wallet.address.toLowerCase()) return privateJson({ error: 'request not found' }, { status: 404 });
    if (action !== 'issue') {
      if (!snapshot) return privateJson({ error: 'request not found', requestId }, { status: 404 });
      if (action !== 'status') {
        const processingPolicy = authorizeIssuanceProcessing(wallet.processingPolicy, process.env.KYC_DEMO === '1');
        const retentionPolicy = authorizeCurrentRetention(process.env.KYC_DEMO === '1', processingPolicy.customerId, wallet.retentionPolicy);
        if (!snapshot.entry.processingPolicy || snapshot.entry.processingPolicy.fingerprint !== processingPolicy.fingerprint) {
          throw new TokenError('the saved request belongs to a different processing policy; status remains available but it cannot be resumed');
        }
        if (!snapshot.entry.retentionPolicy
          || snapshot.entry.retentionPolicy.fingerprint !== wallet.retentionPolicy.fingerprint
          || snapshot.entry.retentionPolicy.policyId !== retentionPolicy.policyId) {
          throw new TokenError('the saved request belongs to a different retention policy; status remains available but it cannot be resumed');
        }
        snapshot = await resume(journal, requestId, action === 'retry');
      }
      return issueResponse(snapshot.entry);
    }
    const d = (body.declared ?? {}) as Record<string, unknown>;
    const declared = {
      fullName: String(d.fullName ?? '').trim(), dateOfBirth: String(d.dateOfBirth ?? '').trim(),
      nationality: String(d.nationality ?? '').trim().toUpperCase(), residence: String(d.residence ?? d.nationality ?? '').trim().toUpperCase(),
    };
    const identityPolicy = identityPolicyForIssuance(process.env.KYC_DEMO === '1');
    const processingPolicy = authorizeIssuanceProcessing(wallet.processingPolicy, process.env.KYC_DEMO === '1');
    const retentionPolicy = authorizeCurrentRetention(process.env.KYC_DEMO === '1', processingPolicy.customerId, wallet.retentionPolicy);
    const fingerprint = issuanceFingerprint({ declared, idProof: body.idProof ?? null, bankProof: body.bankProof ?? null,
      identityPolicy, processingPolicy, retentionPolicy: wallet.retentionPolicy });
    if (snapshot) {
      if (snapshot.entry.fingerprint !== fingerprint) return privateJson({ error: 'this request already has a different immutable payload; use resume for the original result', requestId }, { status: 409 });
      snapshot = await resume(journal, requestId);
      return issueResponse(snapshot.entry);
    }
    // Only new preparations consume the lower issuance quota. Status/resume do not recreate evidence.
    guardRequest(req, { bucket: 'kyc-new-issuance', limit: 5, windowMs: 60 * 60_000 });
    const sealedId = body.idProof ? open<IdDocumentResult & FlowBinding>('id', body.idProof) : null;
    const sealedBank = body.bankProof ? open<BankAccountResult & FlowBinding>('bank', body.bankProof) : null;
    if (sealedId) assertSameFlow(wallet, sealedId, 'document');
    if (sealedBank) assertSameFlow(wallet, sealedBank, 'bank');
    const idDocument = sealedId ? stripToken<IdDocumentResult>(sealedId) : null;
    const bankAccount = sealedBank ? stripToken<BankAccountResult>(sealedBank) : null;

    if (!declared.fullName || declared.fullName.length > 200) return privateJson({ error: 'declared.fullName must be 1–200 characters' }, { status: 400 });
    if (!ISO_DATE.test(declared.dateOfBirth)) return privateJson({ error: 'declared.dateOfBirth must be YYYY-MM-DD' }, { status: 400 });
    if (!ISO2.test(declared.nationality) || !ISO2.test(declared.residence)) return privateJson({ error: 'nationality and residence must be ISO-3166 alpha-2' }, { status: 400 });

    const { adapter } = getAdapter();
    const target = issuanceTarget();
    const { engine } = getEngine('issuance');

    const issueRequest = {
      wallet: wallet.address, declared, idDocument, bankAccount,
      walletControlProven: true, jurisdiction: 410, kind: 1, identityPolicy, processingPolicy,
      consentStatementHash: wallet.consentStatementHash, retentionPolicy: wallet.retentionPolicy,
    };
    const out = await runIssuance(issueRequest, adapter, engine);
    const assurance = out.status === 'ISSUED' ? unpackAttrs(out.attrs).assurance : 0;
    const now = Date.now();
    snapshot = await journal.create({ version: 1, requestId, wallet: wallet.address, fingerprint, consentVersion: wallet.consentVersion,
      processingPolicy, retentionPolicy: wallet.retentionPolicy,
      createdAt: now, prepareUntil: now + 15 * 60_000, phase: 'prepared', target, outcome: out, assurance,
      evidenceRecord: buildEvidenceRecord(requestId, issueRequest, out, wallet.consentVersion, processingPolicy, retentionPolicy, now),
      evidenceStored: false, revertedTransactions: [] });
    if (snapshot.entry.fingerprint !== fingerprint || snapshot.entry.wallet.toLowerCase() !== wallet.address.toLowerCase()) return privateJson({ error: 'request payload conflict', requestId }, { status: 409 });
    snapshot = await resume(journal, requestId);
    return issueResponse(snapshot.entry);
  } catch (e) { return fail(e, knownRequestId); }
}


async function resume(journal: IssuanceJournal, requestId: string, retryFailed = false) {
  const transport = issuanceTransport();
  try { return await advanceIssuance(journal, requestId, transport, issuanceEvidenceSink, { retryFailed, budget: issuanceBudget() }); }
  finally { transport.close(); }
}

async function issueResponse(entry: IssuanceEntry) {
  const out = entry.outcome;
  const confirmed = entry.phase === 'source-confirmed' || entry.phase === 'materialized';
  const required = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;
  const progress = issuanceProgress(entry, await issuancePolicyObservation(entry), issuanceTrackingStatus());
  return privateJson({
    status: out.status !== 'ISSUED' ? out.status : confirmed ? 'ISSUED' : entry.phase === 'failed' ? 'FAILED' : 'PREPARED',
    requestId: entry.requestId, subject: entry.wallet, evidenceHash: out.evidenceHash, evidence: out.evidence,
    reason: out.status !== 'ISSUED' ? out.reason : entry.lastError,
    issuance: { phase: entry.phase, preparedAt: entry.createdAt, prepareUntil: entry.prepareUntil,
      sourceConfirmedAt: entry.sourceConfirmation?.confirmedAt, materializedAt: entry.materializedAt,
      lastError: entry.lastError, resumable: entry.phase !== 'materialized' },
    ...(out.status === 'ISSUED' ? {
      attrs: out.attrs, claimsRoot: out.claimsRoot, claims: out.claims, methods: out.methods,
      methodsHex: '0x' + out.methods.toString(16), methodNames: out.methodNames, regime: out.regime, assurance: entry.assurance, expiry: out.expiry,
      policyPreview: { scope: 'attributes-only; not an on-chain verdict',
        production: (out.methods & required) === required && entry.assurance >= 2 && out.regime === 1,
        sandbox: (out.methods & required) === required && entry.assurance >= 2 && out.regime === 2 },
    } : {}),
    vault: { stored: !!entry.evidenceRecord && entry.evidenceStored, mode: entry.evidenceRecord ? 'file' : 'none', recordId: entry.requestId },
    journal: { stored: true, mode: 'redis-encrypted', retention: 'pending until reconciliation; completed records expire after 24 hours' },
    processingPolicy: entry.processingPolicy ?? null,
    retentionPolicy: entry.evidenceRecord?.retentionPolicy ?? null,
    progress: { source: progress.source, attestation: progress.attestation, policy: progress.policy,
      nextAction: progress.nextAction, timing: progress.timing },
    assetAction: progress.assetAction,
    onchain: { sent: !!entry.broadcastAcceptedAt || confirmed, txHash: entry.transaction?.hash, requestId: entry.requestId,
      issuer: entry.target.issuer, blockNumber: entry.sourceConfirmation?.blockNumber ?? null,
      reverted: entry.lastError === 'SOURCE_REVERTED', submissionUnconfirmed: entry.phase === 'submitted' && !entry.broadcastAcceptedAt },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

function authorizeIssuanceProcessing(binding: Parameters<typeof authorizeCurrentProcessing>[1], demo: boolean): ProcessingPolicyEvidenceV1 {
  const evidence = authorizeCurrentProcessing(demo, binding, {
    stage: 'issuance_processing', recipient: 'proofmark:issuer',
    data: ['identity_fields', 'account_holder_name', 'claim_openings', 'screening_result'],
  });
  authorizeCurrentProcessing(demo, binding, {
    stage: 'recovery_journal', recipient: 'proofmark:journal',
    data: ['wallet_address', 'claim_openings', 'evidence_record', 'signed_transaction'],
  });
  if (!demo) authorizeCurrentProcessing(false, binding, {
    stage: 'evidence_vault', recipient: 'proofmark:vault', data: ['identity_fields', 'claim_openings', 'evidence_record'],
  });
  authorizeCurrentProcessing(demo, binding, {
    stage: 'onchain_publication', recipient: 'public:blockchains',
    data: ['wallet_address', 'credential_metadata', 'commitments'],
  });
  return evidence;
}

function stripToken<T extends object>(t: T & FlowBinding & { exp: number }): T {
  const { exp: _exp, typ: _typ, flowId: _flowId, walletAddress: _walletAddress, ...rest } =
    t as T & FlowBinding & { exp: number; typ?: string };
  void _exp; void _typ; void _flowId; void _walletAddress;
  return rest as T;
}
