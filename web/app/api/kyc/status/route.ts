import { privateJson } from '@/lib/private-response';
import { getAdapter, serverTokenStatus } from '@/lib/kyc-server';
import { KR_BANKS } from '@pipeline/adapters/kr.js';
import { getEngine } from '@/lib/aml-server';
import { evidenceVaultStatus } from '@/lib/evidence-vault';
import { bankStateStore } from '@/lib/bank-state';
import { issuanceBudgetStatus, issuanceJournalStatus, issuanceTrackingStatus } from '@/lib/issuance-server';
import { guardError, guardRequest } from '@/lib/request-guard';
import { handleIssuanceRequest } from '@/lib/issuance-route';
import { processingPolicyStatus } from '@/lib/privacy-processing-policy-server';
import { retentionPolicyStatus } from '@/lib/retention-policy-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which vendors this deployment has, so the page can say what will and will not run. */
export async function GET(req: Request) {
  try {
    guardRequest(req, { bucket: 'kyc-status', limit: 30, windowMs: 60_000 });
    return statusResponse();
  } catch (error) {
    return guardError(error) ?? privateJson({ error: 'Verification service status is unavailable.', code: 'STATUS_UNAVAILABLE' }, { status: 503 });
  }
}

/** Wallet-authenticated, request-specific snapshot. The forced action prevents a caller from
 * turning this read endpoint into resume/retry by changing the JSON body. */
export async function POST(req: Request) { return handleIssuanceRequest(req, 'status'); }

function statusResponse() {
  const { status } = getAdapter();
  const { meta } = getEngine();
  const processingPolicy = processingPolicyStatus(status.demo);
  let bankState: { configured: boolean; mode: string; error?: string };
  try { bankState = { configured: true, mode: bankStateStore(status.bank.vendor === 'demo:bank').mode }; }
  catch { bankState = { configured: false, mode: 'none', error: 'shared bank state must be configured before contacting an external bank' }; }
  return privateJson({
    ...status,
    regimeScope: 'vendor-configuration-only; issued regime requires complete live ID and bank results',
    banks: KR_BANKS,
    vault: evidenceVaultStatus(),
    bankState,
    issuanceJournal: issuanceJournalStatus(),
    issuanceBudget: issuanceBudgetStatus(),
    issuanceTracking: issuanceTrackingStatus(),
    tokenKey: serverTokenStatus(),
    processingPolicy,
    retentionPolicy: retentionPolicyStatus(status.demo, processingPolicy.customerId ?? ''),
    screening: { builtAt: meta.builtAt, sourceUpdatedAt: meta.sourceUpdatedAt, listVersions: meta.listVersions, sourceSnapshot: meta.provenance },
  });
}
