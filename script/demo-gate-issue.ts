/**
 * Issue two demo-regime marks satisfying the pilot's attribute requirements. New GatedRwaNote
 * deployments ALSO require an authorized fresh roster and cached holder witnesses; issuance
 * alone does not open that gate. This command is not the complete fresh-roster lifecycle.
 *
 * What this is, stated plainly: both subjects go through the real issuance pipeline — the same
 * reconciliation, the same sanctions screening against the real OFAC/UN/EU lists, the same claim
 * commitment and attrs packing that `/verify` runs — but the two regulatory checks are answered by
 * the built-in demo vendors (`pipeline/adapters/demo.ts`). No institution is queried. The adapter
 * runs with `sandboxBits: true`, so the resulting mark carries regime KR_FSC_NONFACE_SANDBOX and
 * the evidence names `demo:id` and `demo:bank` with `live: false`. The mark discloses its own
 * provenance; the production policy rejects their sandbox regime.
 *
 * Both issuances are emitted by a single `ComplianceSource.issueBatch()` transaction on Sepolia, so
 * they ride one cross-chain round trip: the ASC applies every MarkIssued log in a source
 * transaction in one `execute()`.
 *
 * Run from the repository root, which is where `.env` and `data/raw/` resolve:
 *
 *     npx tsx script/demo-gate-issue.ts             # screen, pack, and send issueBatch
 *     npx tsx script/demo-gate-issue.ts --dry-run   # everything except the transaction
 *
 * Reads from the root .env: ISSUER_PRIVATE_KEY (a dedicated ComplianceSource issuer), EVIDENCE_HMAC_KEY,
 * SOURCE_CHAIN_RPC_URL, SOURCE_CONTRACT_ADDRESS, DEMO_SUBJECT_A_KEY, DEMO_SUBJECT_B_KEY.
 * Keys stay in that file; nothing here prints one.
 */
import 'dotenv/config';
import { ethers } from 'ethers';

import { loadLists } from '../aml/loader.js';
import { ListBackedAmlEngine } from '../aml/engine.js';
import { KrAdapter, type BankAccountResult, type IdDocumentResult } from '../pipeline/adapters/kr.js';
import { DemoIdDocumentVendor, DemoBankAccountVendor } from '../pipeline/adapters/demo.js';
import { runIssuance, toIssueCall, type IssueOutcome } from '../pipeline/issue.js';
import { Methods } from '../pipeline/methods.js';
import { SYNTHETIC_INDIVIDUAL_NONFACE_POLICY } from '../pipeline/identity-policy.js';

/** Both policies require these bits and assurance; policy #2 additionally pins sandbox regime 2. */
const PILOT_REQUIRE_ALL = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;
const PILOT_MIN_ASSURANCE = 2;
/** KR_FSC_NONFACE_SANDBOX. Demo vendors cannot produce anything else. */
const EXPECTED_REGIME = 2;

const SOURCE_ABI = [
  'function issueBatch((address subject, bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash)[] items)',
];

interface Persona {
  label: string;
  keyVar: 'DEMO_SUBJECT_A_KEY' | 'DEMO_SUBJECT_B_KEY';
  fullName: string;
  /** YYYYMMDD */
  birthDate: string;
  rrn: string;
  issueDate: string;
  bankCode: string;
  accountNumber: string;
}

/**
 * Innocuous personas. The demo ID vendor rejects a name containing "FAKE" and a document number of
 * one repeated digit; the demo bank hands back a different holder for an account ending in "99".
 * These trip none of those, and the sanctions screening below is the real one — if it returns
 * REVIEW or DENIED for a persona that is a real screening decision, and the fix is a different
 * persona, never a forced bit.
 */
const PERSONAS: Persona[] = [
  { label: 'A', keyVar: 'DEMO_SUBJECT_A_KEY', fullName: 'Kim Mina',  birthDate: '19900315', rrn: '9003152345678', issueDate: '20200101', bankCode: '004', accountNumber: '001122334401' },
  { label: 'B', keyVar: 'DEMO_SUBJECT_B_KEY', fullName: 'Lee Junho', birthDate: '19880722', rrn: '8807221234567', issueDate: '20190601', bankCode: '004', accountNumber: '001122334402' },
];

const req = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`environment variable ${name} is not set (check the root .env)`);
  return v;
};

const isoDob = (ymd8: string) => `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6, 8)}`;
/** YYYYMMDD -> YYMMDD, the real-name number the bank checks the holder against. */
const ymd6 = (ymd8: string) => ymd8.slice(2);

async function issueOne(
  persona: Persona,
  adapter: KrAdapter,
  engine: ListBackedAmlEngine,
  issuanceNowMs: number,
): Promise<{ wallet: string; out: Extract<IssueOutcome, { status: 'ISSUED' }> }> {
  const wallet = new ethers.Wallet(req(persona.keyVar)).address;

  // Step 1, ID document. The demo authority is asked the same question CODEF asks Government24.
  const image = new TextEncoder().encode(`proofmark-demo-document|${persona.label}|${persona.rrn}`);
  const idOutcome = await adapter.idVendor!.verify({
    docType: 'RRC',
    image,
    fullName: persona.fullName,
    birthDate: persona.birthDate,
    rrn: persona.rrn,
    issueDate: persona.issueDate,
  });
  if (idOutcome.kind !== 'verified') throw new Error(`${persona.label}: the ID vendor asked for a second leg, which the demo vendor never does`);
  const { kind: _kind, ...idDocument } = idOutcome;
  void _kind;

  // Step 2, bank account: holder name against the real-name number, then one won with a code.
  const holder = await adapter.bankVendor!.holderName({
    bankCode: persona.bankCode,
    accountNumber: persona.accountNumber,
    birthDate: ymd6(persona.birthDate),
    declaredName: persona.fullName,
  });
  if (!holder.holderName) throw new Error(`${persona.label}: the bank returned no holder for this account`);
  const won = await adapter.bankVendor!.oneWonTransfer({
    bankCode: persona.bankCode,
    accountNumber: persona.accountNumber,
    holderName: holder.holderName,
  });
  if (!won.authCode) throw new Error(`${persona.label}: the one-won transfer returned no code`);
  const bankAccount: BankAccountResult = {
    bankCode: persona.bankCode,
    holderName: holder.holderName,
    holderVerified: true,
    oneWonVerified: true,
    vendor: adapter.bankVendor!.name,
    live: adapter.bankVendor!.live,
    ref: won.ref ?? holder.ref,
  };

  // The issuer's own grade, computed exactly as web/app/api/kyc/issue/route.ts computes it.
  const counts = (r: { live: boolean }) => r.live || adapter.sandboxBits;
  const idOk = counts(idDocument as IdDocumentResult) && idDocument.authenticityChecked && idDocument.authentic;
  const bankOk = counts(bankAccount) && bankAccount.holderVerified && bankAccount.oneWonVerified;
  const assurance = idOk && bankOk ? 3 : 1;

  const declared = {
    fullName: persona.fullName,
    dateOfBirth: isoDob(persona.birthDate),
    nationality: 'KR',
    residence: 'KR',
  };

  const out = await runIssuance(
    { wallet, declared, idDocument: idDocument as IdDocumentResult, bankAccount, walletControlProven: true, jurisdiction: 410, kind: 1, assurance,
      identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY },
    adapter,
    engine,
    issuanceNowMs,
  );

  if (out.status !== 'ISSUED') {
    // A REVIEW or DENIED here is the screening engine's decision and it stands.
    throw new Error(`${persona.label}: issuance returned ${out.status} (${out.reason}). This is a real screening decision — change the persona, never the bits.`);
  }
  if ((out.methods & PILOT_REQUIRE_ALL) !== PILOT_REQUIRE_ALL) {
    throw new Error(`${persona.label}: methods 0x${out.methods.toString(16)} does not carry pilot policy 2's required 0x${PILOT_REQUIRE_ALL.toString(16)}`);
  }
  if (assurance < PILOT_MIN_ASSURANCE) throw new Error(`${persona.label}: assurance ${assurance} is below pilot policy 2's minimum ${PILOT_MIN_ASSURANCE}`);
  if (out.regime !== EXPECTED_REGIME) {
    throw new Error(`${persona.label}: regime ${out.regime} is not KR_FSC_NONFACE_SANDBOX (${EXPECTED_REGIME}); a demo vendor must never produce a production regime`);
  }

  console.log(`${persona.label}  ${wallet}`);
  console.log(`   status      ${out.status}`);
  console.log(`   regime      ${out.regime} KR_FSC_NONFACE_SANDBOX`);
  console.log(`   assurance   ${assurance}`);
  console.log(`   methods     0x${out.methods.toString(16)}  ${out.methodNames.join(', ')}`);
  console.log(`   attrs       ${out.attrs}`);
  console.log(`   claimsRoot  ${out.claimsRoot}`);
  console.log(`   evidence    ${out.evidenceHash}`);
  console.log(`   expiry      ${new Date(out.expiry * 1000).toISOString()}`);
  return { wallet, out };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Source validators, not the local workstation, decide whether issuedAt is in the future.
  // Anchor both records to an observed source block so clock skew cannot invalidate the batch.
  const provider = new ethers.JsonRpcProvider(req('SOURCE_CHAIN_RPC_URL'));
  const sourceHead = await provider.getBlock('latest');
  if (!sourceHead) throw new Error('latest source block is unavailable');
  const issuanceNowMs = Math.min(Date.now(), sourceHead.timestamp * 1000);
  console.log(`source time anchor: block ${sourceHead.number}, ${new Date(issuanceNowMs).toISOString()}\n`);

  // Demo vendors on both axes, with the sandbox switch on. The regime discloses it.
  const adapter = new KrAdapter(new DemoIdDocumentVendor(), new DemoBankAccountVendor(), { sandboxBits: true });

  // The real screening engine, over the real lists in data/raw/.
  const { entries, listVersions, counts, provenance, maxAgeHours } = await loadLists('data/raw', 'issuance');
  console.log(`lists: OFAC ${counts.OFAC_SDN}, UN ${counts.UN_CONSOLIDATED}, EU ${counts.EU_FSF} = ${entries.length} entries\n`);
  const engine = new ListBackedAmlEngine({
    entries,
    listVersions,
    provenance,
    maxAgeHours,
    evidenceKey: req('EVIDENCE_HMAC_KEY'),
    keyId: 'demo-gate-k1',
  });

  const issued = [];
  for (const persona of PERSONAS) issued.push(await issueOne(persona, adapter, engine, issuanceNowMs));

  const items = issued.map(({ wallet, out }) => toIssueCall(wallet, out));
  console.log(`\nissueBatch items: ${items.map((i) => i.subject).join(', ')}`);

  if (dryRun) {
    console.log('--dry-run: nothing sent.');
    provider.destroy();
    return;
  }

  const signer = new ethers.Wallet(req('ISSUER_PRIVATE_KEY'), provider);
  const source = new ethers.Contract(req('SOURCE_CONTRACT_ADDRESS'), SOURCE_ABI, signer);

  const sentAt = new Date();
  const tx = await source.issueBatch(items.map((i) => [i.subject, i.attrs, i.claimsRoot, i.evidenceHash]));
  console.log(`\nSepolia issueBatch  ${tx.hash}`);
  console.log(`   sent at    ${sentAt.toISOString()}`);
  const receipt = await tx.wait();
  const minedAt = new Date();
  console.log(`   block      ${receipt.blockNumber}`);
  console.log(`   status     ${receipt.status === 1 ? 'success' : 'FAILED'}`);
  console.log(`   mined at   ${minedAt.toISOString()}  (start the propagation clock here)`);
  provider.destroy();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
