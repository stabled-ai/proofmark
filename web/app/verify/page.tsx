'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Status } from '@/components/ui/Status';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';
import { sepoliaTx } from '@/lib/links';
import { METHOD_BITS } from '@/lib/methods';
import { syntheticProfile, type SyntheticScenario } from '@pipeline/synthetic-samples.js';
import { syntheticDocument } from '@/lib/synthetic-document';
import { WalletSession, type WalletProvider } from '@pipeline/wallet-session.js';

/**
 * The KR issuance flow, end to end, against the connected vendors.
 *   0 wallet control        EIP-4361 signature, checked server side
 *   1 ID document           CODEF OCR, then Government24 (resident registration card) or
 *                           Traffic Civil Service 24 (driver licence) authenticity
 *   2 bank account          holder name against the real-name number, one won with a code, code read back
 *   3 screen and issue      reconciliation, sanctions lists, claims commitment, ComplianceSource.issue on Sepolia
 * Each step passes an opaque sealed token. The browser also holds entered fields, masked
 * summaries and, for a non-live demo only, the simulated deposit code.
 */

type Side = { configured: boolean; vendor: string | null; live: boolean; demo: boolean; env: string | null; missing: string[]; error?: string };
type Config = {
  demo: boolean; sandboxBits: boolean; id: Side; bank: Side;
  issuer: { configured: boolean; address: string | null; missing: string[] }; banks: { code: string; name: string }[];
  vault: { configured: boolean; persistent: boolean; missing: string[]; mode: 'file' | 'none' };
  bankState: { configured: boolean; mode: string; error?: string };
  issuanceJournal: { configured: boolean; mode: string; missing: string[] };
  issuanceTracking: { configured: boolean; sourceExpectedSeconds: [number, number] | null; hubExpectedSeconds: [number, number] | null;
    timeoutSeconds: number | null; supportUrl: string | null; missing: string[]; invalid: string[] };
  tokenKey: { configured: boolean; mode: string; missing: string[] };
  processingPolicy: { configured: boolean; status: 'synthetic' | 'approved' | 'unavailable'; policyId: string | null;
    customerId: string | null; operatingModel: 'first-party' | 'institution-service' | 'sdk-only' | null;
    noticeVersion: string | null; noticeStatement: string | null; fingerprint: string | null; missing: string[] };
};
type IdSummary = { docType: 'RRC' | 'DL'; docHash: string; authenticityChecked: boolean; authentic: boolean; live: boolean; vendor: string; ref: string | null; code: string | null };
type BankSummary = { bankCode: string; holderNameMasked: string; vendor: string; live: boolean; ref: string | null };
type TwoWay = { token: string; method: string; message: string | null; imageBase64: string | null };
type Onchain = { sent: boolean; txHash?: string; requestId?: string; issuer?: string; blockNumber?: number | null; reverted?: boolean | null; reason?: string };
type Issued = {
  status: 'PREPARED' | 'ISSUED' | 'FAILED' | 'DENIED' | 'REVIEW' | 'REJECTED'; reason?: string; subject?: string;
  requestId: string;
  issuance: { phase: 'prepared' | 'submitted' | 'source-confirmed' | 'materialized' | 'failed'; lastError?: string; materializedAt?: number };
  attrs?: string; claimsRoot?: string; evidenceHash: string; methodsHex?: string; methodNames?: string[];
  regime?: number; assurance?: number; expiry?: number; policyPreview?: { production: boolean; sandbox: boolean; scope: string }; claims?: unknown; evidence: unknown; onchain?: Onchain;
  vault?: { stored: boolean; mode: string; recordId: string; reason?: string };
  progress: {
    source: { state: 'not-submitted' | 'pending' | 'confirmed' | 'reverted'; blockNumber?: number | null; confirmedAt?: number | null };
    attestation: { state: 'not-started' | 'waiting' | 'applied'; appliedAt?: number | null };
    policy: { state: 'waiting-attestation' | 'unavailable' | 'eligible' | 'ineligible';
      policies: { id: number; name: string; verified: boolean; reasonCodes: string[] }[] };
    nextAction: 'resume' | 'retry' | 'start-new-request' | 'refresh-status';
    timing: { configured: boolean; source: { expectedSeconds: [number, number] | null; expectedBy: number | null; overdue: boolean | null };
      attestation: { expectedSeconds: [number, number] | null; expectedBy: number | null; overdue: boolean | null };
      timeoutAt: number | null; timedOut: boolean | null; supportUrl: string | null; missing: string[]; invalid: string[] };
  };
  assetAction: { ready: boolean; readyPolicyIds: number[]; scope: string };
};

declare global {
  interface Window { ethereum?: WalletProvider }
}

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); }
}
async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) {
    const missing = Array.isArray(j.missing) && j.missing.length ? ` (${(j.missing as string[]).join(', ')})` : '';
    throw new ApiError(`${String(j.error ?? `HTTP ${r.status}`)}${missing}`, r.status, j);
  }
  return j as T;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const utf8Hex = (s: string) => '0x' + Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
const isoOf = (ymd8: string) => (ymd8.length === 8 ? `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6)}` : '');
const digits = (s: string) => s.replace(/\D/g, '');

const selectCls = 'h-11 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg-strong transition-colors hover:border-line-strong focus:border-mint disabled:opacity-50';

export default function Verify() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ step: string; text: string } | null>(null);
  const [consented, setConsented] = useState(false);
  const [sample, setSample] = useState<SyntheticScenario | null>(null);
  const [samplePreview, setSamplePreview] = useState<string | null>(null);
  const sampleMode = cfg?.demo === true && cfg.id.demo && cfg.bank.demo && !cfg.id.live && !cfg.bank.live;

  // 0 wallet
  const [wallet, setWallet] = useState<{ address: string; proof: string; requestId: string; expiresAt: number } | null>(null);
  // 1 identity
  const [docType, setDocType] = useState<'RRC' | 'DL'>('RRC');
  const [image, setImage] = useState<File | null>(null);
  const [doc, setDoc] = useState({ fullName: '', birthDate: '', rrn: '', issueDate: '', licenseNumber: '', serialNo: '' });
  const [ocrNote, setOcrNote] = useState<string | null>(null);
  const [twoWay, setTwoWay] = useState<TwoWay | null>(null);
  const [secureNo, setSecureNo] = useState('');
  const [id, setId] = useState<{ proof: string; summary: IdSummary } | null>(null);
  // 2 bank
  const [bank, setBank] = useState({ bankCode: '004', accountNumber: '' });
  const bankRequest = useRef<{ input: string; id: string } | null>(null);
  const [challenge, setChallenge] = useState<{ token: string; holderNameMasked: string; vendor: string; live: boolean; ref: string | null; demoCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [bankRes, setBankRes] = useState<{ proof: string; summary: BankSummary } | null>(null);
  // 3 issue
  const [country, setCountry] = useState({ nationality: 'KR', residence: 'KR' });
  const [issued, setIssued] = useState<Issued | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [session] = useState(() => new WalletSession());

  useEffect(() => { apiRequest<Config>('/api/kyc/status').then(setCfg).catch((e) => setErr({ step: 'config', text: String(e.message) })); }, []);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    const expire = () => { session.expireIfNeeded(); };
    const timer = window.setInterval(expire, 1000);
    window.addEventListener('focus', expire); document.addEventListener('visibilitychange', expire);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', expire); document.removeEventListener('visibilitychange', expire); };
  }, [session]);

  const clearWalletSession = (reason: string) => {
    setWallet(null); setConsented(false); setId(null); setTwoWay(null); setSecureNo(''); setOcrNote(null);
    setChallenge(null); setCode(''); setBankRes(null); bankRequest.current = null;
    setIssued(null); setLastRequestId(null); setImage(null); setSample(null); setSamplePreview(null);
    setDoc({ fullName: '', birthDate: '', rrn: '', issueDate: '', licenseNumber: '', serialNo: '' });
    setBank({ bankCode: '004', accountNumber: '' }); setCountry({ nationality: 'KR', residence: 'KR' });
    setBusy(null); setErr({ step: 'wallet', text: `${reason} Local details were cleared. Already sent requests may still complete; reconnect the original wallet to recover its saved request.` });
  };
  async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const revision = session.revision;
    await session.check(revision, () => window.ethereum);
    try {
      const result = await apiRequest<T>(url, init);
      await session.check(revision, () => window.ethereum);
      return result;
    } catch (error) { await session.check(revision, () => window.ethereum); throw error; }
  }

  const declared = useMemo(() => ({
    fullName: doc.fullName.trim(), dateOfBirth: isoOf(digits(doc.birthDate)), ...country,
  }), [doc.fullName, doc.birthDate, country]);

  async function run(step: string, fn: () => Promise<void>) {
    let revision = session.revision;
    setBusy(step); setErr(null);
    try { const pending = fn(); revision = session.revision; await pending; } catch (e) {
      if (revision === session.revision) setErr({ step, text: e instanceof Error ? e.message : String(e) });
    } finally { if (revision === session.revision) setBusy(null); }
  }

  const loadSample = (scenario: SyntheticScenario) => run('sample', async () => {
    if (!sampleMode) throw new Error('Samples are available only with both built-in demo vendors.');
    const revision = session.revision;
    const p = syntheticProfile(scenario); const generated = await syntheticDocument(scenario);
    session.assertCurrent(revision);
    session.clearAuthorization();
    setSample(scenario); setSamplePreview(generated.preview); setImage(generated.file);
    setDocType(p.docType); setDoc(p.doc); setBank(p.bank); setCountry(p.country);
    setWallet(null); setConsented(false); setId(null); setTwoWay(null); setSecureNo(''); setOcrNote(null);
    setChallenge(null); setCode(''); setBankRes(null); bankRequest.current = null;
    setIssued(null); setLastRequestId(null);
  });

  // ── 0 wallet ──
  const connect = () => run('wallet', async () => {
    if (!consented) throw new Error('Review and accept the KYC/AML processing notice first.');
    if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or another EIP-1193 wallet.');
    const provider = window.ethereum;
    session.attach(provider, clearWalletSession);
    const revision = session.revision;
    const address = session.bind(revision, await session.request(revision, { method: 'eth_requestAccounts' }, () => window.ethereum));
    const { message, token } = await api<{ message: string; token: string }>(`/api/kyc/wallet?address=${address}`);
    await session.check(revision, () => window.ethereum);
    const signature = await session.request(revision, { method: 'personal_sign', params: [utf8Hex(message), address] }, () => window.ethereum) as string;
    await session.check(revision, () => window.ethereum);
    const authorizationStarted = session.authorizationStarted();
    const r = await api<{ address: string; walletProof: string; requestId: string; walletExpiresAt: number; serverTime: number }>('/api/kyc/wallet', json({ token, signature }));
    if (typeof r.requestId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.requestId)) throw new Error('The wallet service did not provide a recovery request ID. Reconnect after the service is updated.');
    if (r.address?.toLowerCase() !== address || typeof r.walletProof !== 'string' || !r.walletProof) throw new Error('Wallet response did not match the selected account.');
    session.authorize(revision, r, authorizationStarted);
    setWallet({ address: r.address, proof: r.walletProof, requestId: r.requestId, expiresAt: r.walletExpiresAt });
    setIssued(null);
    try { setLastRequestId(sessionStorage.getItem(`proofmark-request:${r.address.toLowerCase()}`)); } catch { setLastRequestId(null); }
  });

  // ── 1 identity ──
  const idForm = (action: 'ocr' | 'verify', extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set('action', action); f.set('docType', docType); if (image) f.set('image', image);
    if (wallet) f.set('walletProof', wallet.proof);
    if (sample) f.set('syntheticSample', '1');
    for (const [k, v] of Object.entries({ ...doc, ...extra })) f.set(k, v);
    return f;
  };
  const readDocument = () => run('ocr', async () => {
    if (!image) throw new Error('Choose a photo of the document first.');
    const r = await api<{ fields: Partial<typeof doc & { docType: string }> }>('/api/kyc/id', { method: 'POST', body: idForm('ocr') });
    const f = r.fields;
    setDoc((d) => ({
      fullName: f.fullName ?? d.fullName, birthDate: f.birthDate ?? d.birthDate, rrn: f.rrn ?? d.rrn,
      issueDate: f.issueDate ?? d.issueDate, licenseNumber: f.licenseNumber ?? d.licenseNumber, serialNo: f.serialNo ?? d.serialNo,
    }));
    const read = Object.entries(f).filter(([k, v]) => k !== 'docType' && v).map(([k]) => k);
    setOcrNote(read.length ? `Read from the image: ${read.join(', ')}. Check every field against the card before verifying.` : 'Nothing could be read. Type the fields from the card.');
  });
  const handleIdResponse = (r: { status: string; idProof?: string; summary?: IdSummary; challenge?: Omit<TwoWay, 'token'>; twoWayToken?: string }) => {
    if (r.status === 'two_way' && r.challenge && r.twoWayToken) {
      setTwoWay({ token: r.twoWayToken, ...r.challenge }); setSecureNo('');
      return;
    }
    setTwoWay(null);
    if (r.idProof && r.summary) setId({ proof: r.idProof, summary: r.summary });
  };
  const verifyDocument = () => run('id', async () => {
    if (!image) throw new Error('A photo of the document is required.');
    setId(null);
    handleIdResponse(await api('/api/kyc/id', { method: 'POST', body: idForm('verify') }));
  });
  const answerTwoWay = () => run('id', async () => {
    if (!twoWay) return;
    const extra: Record<string, string> = twoWay.method === 'secureNo'
      ? { twoWayToken: twoWay.token, secureNo }
      : { twoWayToken: twoWay.token, simpleAuth: '1' };
    handleIdResponse(await api('/api/kyc/id', { method: 'POST', body: idForm('verify', extra) }));
  });

  // ── 2 bank ──
  const startBank = () => run('bank', async () => {
    setBankRes(null); setChallenge(null); setCode('');
    const input = JSON.stringify([wallet?.proof, bank.bankCode, bank.accountNumber, doc.birthDate, declared.fullName]);
    if (!bankRequest.current || bankRequest.current.input !== input) bankRequest.current = { input, id: crypto.randomUUID() };
    const r = await api<{ challenge: string; holderNameMasked: string; vendor: string; live: boolean; ref: string | null; demoCode?: string }>('/api/kyc/bank', json({
      action: 'start', bankCode: bank.bankCode, accountNumber: bank.accountNumber,
      startRequestId: bankRequest.current.id,
      birthDate: digits(doc.birthDate).slice(2), declaredName: declared.fullName, walletProof: wallet?.proof,
      syntheticSample: sample ? true : undefined,
    }));
    setChallenge({ token: r.challenge, holderNameMasked: r.holderNameMasked, vendor: r.vendor, live: r.live, ref: r.ref, demoCode: r.demoCode });
  });
  const confirmCode = () => run('bank', async () => {
    if (!challenge) return;
    try {
      const r = await api<{ bankProof: string; summary: BankSummary }>('/api/kyc/bank', json({ action: 'verify', challenge: challenge.token, code, walletProof: wallet?.proof, syntheticSample: sample ? true : undefined }));
      setBankRes({ proof: r.bankProof, summary: r.summary });
    } catch (e) {
      if (e instanceof ApiError && typeof e.body.challenge === 'string') setChallenge({ ...challenge, token: e.body.challenge });
      if (e instanceof ApiError && ['TOO_MANY_ATTEMPTS', 'CHALLENGE_EXPIRED', 'CHALLENGE_UNAVAILABLE'].includes(String(e.body.code))) {
        setChallenge(null); bankRequest.current = null;
      }
      throw e;
    }
  });

  // ── 3 issue ──
  const rememberRequest = (requestId: string) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) throw new Error('Invalid recovery request ID.');
    setLastRequestId(requestId);
    if (wallet) try { sessionStorage.setItem(`proofmark-request:${wallet.address.toLowerCase()}`, requestId); } catch { /* recovery still works by copying the request ID */ }
  };
  const issue = () => run('issue', async () => {
    if (!wallet) throw new Error('Connect the wallet first.');
    // Persist before network I/O: a committed issuance may have no observable HTTP response.
    rememberRequest(wallet.requestId);
    try {
      const result = await api<Issued>('/api/kyc/issue', json({ walletProof: wallet.proof, declared, idProof: id?.proof ?? null, bankProof: bankRes?.proof ?? null }));
      rememberRequest(result.requestId); setIssued(result);
    } catch (e) {
      if (e instanceof ApiError && typeof e.body.requestId === 'string') rememberRequest(e.body.requestId);
      throw e;
    }
  });
  const resumeIssue = (action: 'status' | 'resume' | 'retry') => run('issue', async () => {
    if (!wallet || !lastRequestId) throw new Error('Reconnect the original wallet to resume this request.');
    const url = action === 'status' ? '/api/kyc/status' : '/api/kyc/issue';
    const result = await api<Issued>(url, json({ action, requestId: lastRequestId, walletProof: wallet.proof }));
    rememberRequest(result.requestId); setIssued(result);
  });
  useEffect(() => {
    if (!wallet || !lastRequestId || !issued || busy || issued.issuance.phase === 'failed'
      || issued.assetAction.ready || issued.progress.timing.timedOut === true) return;
    const revision = session.revision;
    const timer = window.setInterval(async () => {
      try {
        const result = await apiRequest<Issued>('/api/kyc/status', json({ requestId: lastRequestId, walletProof: wallet.proof }));
        await session.check(revision, () => window.ethereum);
        setIssued(result);
      } catch { /* Keep the last known snapshot; explicit controls surface errors and support details. */ }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [busy, issued, lastRequestId, session, wallet]);
  const download = () => {
    if (!issued) return;
    const blob = new Blob([JSON.stringify({ requestId: issued.requestId, issuance: issued.issuance, subject: issued.subject, attrs: issued.attrs, claimsRoot: issued.claimsRoot,
      evidenceHash: issued.evidenceHash, claims: issued.claims, evidence: issued.evidence, onchain: issued.onchain }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `proofmark-${(issued.subject ?? 'mark').slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const walletDone = !!wallet;
  const idDone = !!id?.summary.authentic;
  const bankDone = !!bankRes;
  const canBank = walletDone && idDone && cfg?.bankState?.configured === true && declared.fullName.length > 0 && digits(doc.birthDate).length === 8;
  const canIssue = walletDone && idDone && bankDone && cfg?.issuanceJournal?.configured === true && cfg?.tokenKey?.configured === true;
  const vendorsMissing = cfg && (!cfg.id.configured || !cfg.bank.configured);
  const testbed = cfg && cfg.bank.configured && !cfg.bank.demo && !cfg.bank.live;
  const bankName = (c: string) => cfg?.banks.find((b) => b.code === c)?.name ?? c;
  const serviceNotice = !cfg ? null
    : !cfg.processingPolicy.configured || vendorsMissing
      ? 'Identity verification is temporarily unavailable. Please try again later.'
      : cfg.demo && !sampleMode
        ? 'Sample profiles are unavailable. Please do not submit personal information on this public page.'
        : !cfg.bankState.configured
          ? 'Bank verification is temporarily unavailable. You can check your document, but you cannot complete verification yet.'
          : !cfg.issuer.configured || !cfg.issuanceJournal.configured || !cfg.tokenKey.configured || (!cfg.demo && !cfg.vault.configured)
            ? 'Credential issuance is currently unavailable. You can complete the identity and account checks, but a credential will not be issued.'
            : testbed
              ? 'The bank connection is in test mode. No money will move, and the result will not count as a verified bank account.'
              : null;

  return (
    <>
      <PageHeader
        eyebrow="Identity verification · South Korea"
        title="South Korea verification"
        lede="Verify your identity and bank account, then request your Proofmark credential."
        aside={<Tag tone="warn">{sampleMode ? 'Sample verification' : 'Test environment'}</Tag>}
      />

      <div role="alert" aria-atomic="true">{err?.step === 'config' && <Band tone="bad" className="mb-4">{err.text}</Band>}</div>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{busy ? `Working on ${busy === 'ocr' ? 'document reading' : busy === 'id' ? 'document verification' : busy === 'issue' ? 'screening and issuance' : busy}. Please wait.` : ''}</p>
      <Band tone="warn" className="mb-5">
        <strong>Please do not enter real personal information.</strong> Use a sample profile and a disposable test wallet.{cfg?.demo && ' Any issued credential is for testing only.'}
      </Band>
      {sampleMode && (
        <section aria-label="Synthetic sample scenarios" className="panel mb-6 p-5 sm:p-6">
          <h2 className="display text-[20px] leading-7">Choose a sample profile</h2>
          <p className="mt-1.5 text-sm text-fg-muted">Explore the process without an ID or a bank account.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {([['success', 'Matching details', 'Document and account details match.'], ['document-rejected', 'Rejected document', 'See what happens when an ID is declined.'], ['holder-mismatch', 'Account mismatch', 'Try an account with a different holder.']] as const).map(([scenario, label, description]) => (
              <button type="button" key={scenario} aria-pressed={sample === scenario} disabled={busy !== null} onClick={() => loadSample(scenario)} className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:opacity-50 ${sample === scenario ? 'border-mint bg-mint-tint' : 'border-line hover:border-mint/40 hover:bg-sunk'}`}>
                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${sample === scenario ? 'border-mint bg-mint text-mint-fg' : 'border-line-strong'}`}>{sample === scenario && <Icon name="check" size={12} />}</span>
                <span><span className="block text-sm font-semibold text-fg-strong">{label}</span><span className="mt-1 block text-xs leading-5 text-fg-muted">{description}</span></span>
              </button>
            ))}
          </div>
          <p role="status" className="mt-4 text-xs text-fg-muted">{sample ? 'Profile loaded. Connect your wallet to continue. Changing profiles restarts this form; previous requests are kept.' : 'Choose a profile to get started. Document and bank checks are simulated.'}</p>
          <StepError err={err} step="sample" />
        </section>
      )}
      {serviceNotice && <Band tone="note" className="mb-5">{serviceNotice}</Band>}

      {lastRequestId && wallet && <div className="panel mb-5 flex flex-wrap items-center justify-between gap-4 p-5"><div><h2 className="text-sm font-semibold text-fg-strong">You have a saved request</h2><p className="mt-1 text-xs text-fg-muted">Check its status or continue where you left off.</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => resumeIssue('status')} disabled={busy !== null}>Load original result</Button>{issued?.issuance.phase !== 'materialized' && <Button variant="secondary" onClick={() => resumeIssue('resume')} disabled={busy !== null}>Resume original request</Button>}</div></div>}

      <div className="grid gap-4">
        {/* ── 0 wallet ── */}
        <Step n={0} title="Connect your wallet" state={walletDone ? 'done' : 'active'} tag={walletDone && <Tag tone="ok">Connected</Tag>}>
          <p className="text-sm leading-6 text-fg-muted">
            Sign a message to confirm you own this wallet. Signing does not cost gas or move funds.
          </p>
          <details className="mt-3 text-xs leading-5 text-fg-muted"><summary className="cursor-pointer text-fg">Wallet requirements and session details</summary><p className="mt-2">Use a browser wallet with support for account and network changes. Contract-wallet and multisig verification are not supported here. Mobile wallet return behavior has not yet been validated. The signed message expires in ten minutes; an authorized session lasts up to thirty minutes. If it expires, you must sign and verify again. Dismiss open wallet prompts yourself when you stop waiting.</p></details>
          <label className="mt-5 flex items-start gap-3 rounded-lg border border-line bg-sunk/50 p-4 text-[13px] leading-6 text-fg">
            <input type="checkbox" checked={consented} disabled={walletDone} onChange={(e) => setConsented(e.target.checked)} className="mt-1" />
            <span>{cfg?.processingPolicy.noticeStatement ?? 'The processing notice is unavailable.'}</span>
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={connect} disabled={busy !== null || walletDone || !consented || !cfg || !cfg.processingPolicy.configured || (sampleMode && !sample)}><Icon name="wallet" size={16} />{walletDone ? 'Signed' : busy === 'wallet' ? 'Waiting for the wallet…' : 'Connect and sign'}</Button>
            {wallet && <Hash value={wallet.address} full />}
            {busy === 'wallet' && <Button variant="ghost" onClick={() => session.invalidate('Stopped waiting for the wallet. Dismiss any open wallet prompt; it was not cancelled by this page.')}>Stop waiting</Button>}
            {wallet && <Button variant="ghost" disabled={busy !== null} onClick={() => session.invalidate('Wallet-control session reset. Reconnect and sign again.')}>Reset wallet session</Button>}
          </div>
          {wallet && <p className="mt-3 text-xs text-fg-muted">Session expires at {new Date(wallet.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Resetting this form keeps any submitted request.</p>}
          <StepError err={err} step="wallet" />
        </Step>

        {/* ── 1 identity ── */}
        <Step n={1} title="ID document" state={idDone ? 'done' : walletDone ? 'active' : 'locked'}
          tag={id && <Tag tone={id.summary.authentic ? 'ok' : 'bad'}>{id.summary.authentic ? 'Verified' : 'not confirmed'}</Tag>}>
          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="grid content-start gap-3.5">
              <fieldset disabled={!!id || !walletDone || sampleMode}>
                <legend className="mb-1.5 text-xs font-medium text-fg-muted">Document</legend>
                <div className="inline-flex min-h-9 w-full items-stretch gap-0.5 rounded-sm border border-line bg-sunk p-0.5">
                  {([['RRC', 'Resident card'], ['DL', 'Driver licence']] as const).map(([k, label]) => (
                    <label key={k} className={`flex flex-1 items-center justify-center gap-2 rounded-[3px] px-1 py-2 text-xs font-medium ${docType === k ? 'bg-surface-2 text-fg-strong' : 'text-fg-muted'}`}>
                      <input type="radio" name="document-type" value={k} checked={docType === k}
                        onChange={() => { setDocType(k); setTwoWay(null); }} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Photo of the card" hint="JPG or PNG, up to 5 MB">
                <input type="file" accept="image/jpeg,image/png" capture="environment" disabled={!walletDone || !!id || sampleMode}
                  onChange={(e) => { setImage(e.target.files?.[0] ?? null); setId(null); setTwoWay(null); setOcrNote(null); }}
                  className="block w-full text-[13px] text-fg-muted file:mr-3 file:h-11 file:rounded-md file:border file:border-line-strong file:bg-transparent file:px-3 file:text-[13px] file:font-medium file:text-fg-strong hover:file:bg-surface-2" />
              </Field>
              {samplePreview && <div>
                {/* Browser-generated training card, not an official document replica. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={samplePreview} alt="Synthetic training sample — not an identity document" className="w-full rounded-sm border border-line" />
                <p className="mt-2 text-xs text-fg-muted">Sample document. Details are filled in for you.</p>
              </div>}
              <Button variant="secondary" onClick={readDocument} disabled={!walletDone || !image || busy !== null || !!id}>
                <Icon name="search" size={16} />{busy === 'ocr' ? 'Reading…' : 'Read document details'}
              </Button>
              {ocrNote && <div className="text-xs leading-4 text-fg-muted">{ocrNote}</div>}
            </div>

            <div className="grid content-start gap-3.5 sm:grid-cols-2">
              <Field label="Name on the card"><Input value={doc.fullName} disabled={!cfg || !!id || sampleMode} onChange={(e) => setDoc({ ...doc, fullName: e.target.value })} /></Field>
              <Field label="Date of birth" hint="YYYYMMDD"><Input className="mono" inputMode="numeric" value={doc.birthDate} disabled={!cfg || !!id || sampleMode} onChange={(e) => setDoc({ ...doc, birthDate: digits(e.target.value).slice(0, 8) })} /></Field>
              {docType === 'RRC' ? (
                <>
                  <Field label="Resident registration number" hint={sampleMode ? "fictional sample only" : "sent to the configured provider"}>
                    <Input className="mono" inputMode="numeric" type="password" autoComplete="off" value={doc.rrn} disabled={!cfg || !!id || sampleMode} onChange={(e) => setDoc({ ...doc, rrn: digits(e.target.value).slice(0, 13) })} />
                  </Field>
                  <Field label="Issue date" hint="YYYYMMDD"><Input className="mono" inputMode="numeric" value={doc.issueDate} disabled={!cfg || !!id || sampleMode} onChange={(e) => setDoc({ ...doc, issueDate: digits(e.target.value).slice(0, 8) })} /></Field>
                </>
              ) : (
                <>
                  <Field label="Licence number" hint="12 digits"><Input className="mono" inputMode="numeric" value={doc.licenseNumber} disabled={!cfg || !!id || sampleMode} onChange={(e) => setDoc({ ...doc, licenseNumber: digits(e.target.value).slice(0, 12) })} /></Field>
                  <Field label="Anti-forgery serial" hint="under the small photo"><Input className="mono" value={doc.serialNo} disabled={!cfg || !!id || sampleMode} onChange={(e) => setDoc({ ...doc, serialNo: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6) })} /></Field>
                </>
              )}
              <div className="sm:col-span-2">
                <Button onClick={verifyDocument} disabled={!walletDone || !image || busy !== null || !!id || !!twoWay}>
                  <Icon name="shield" size={16} />{busy === 'id' && !twoWay ? 'Checking document…' : cfg?.id.demo ? 'Check sample document' : 'Verify document'}
                </Button>
              </div>
            </div>
          </div>

          {twoWay && (
            <div className="mt-4 rounded-sm border border-warn/20 bg-warn-tint p-4">
              <div className="text-[13px] font-medium text-fg-strong">{twoWay.method === 'secureNo' ? 'The authority asks for a captcha.' : 'The authority asks for approval in the certificate app.'}</div>
              {twoWay.message && <div className="mt-0.5 text-xs text-fg-muted">{twoWay.message}</div>}
              <div className="mt-3 flex flex-wrap items-end gap-3">
                {twoWay.imageBase64 && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="captcha" src={`data:image/png;base64,${twoWay.imageBase64}`} className="h-12 rounded-sm border border-line bg-white" />
                )}
                {twoWay.method === 'secureNo' && (
                  <div className="w-40"><Field label="Characters"><Input className="mono" value={secureNo} onChange={(e) => setSecureNo(e.target.value)} autoFocus /></Field></div>
                )}
                <Button onClick={answerTwoWay} disabled={busy !== null || (twoWay.method === 'secureNo' && !secureNo)}>
                  {busy === 'id' ? 'Sending…' : twoWay.method === 'secureNo' ? 'Answer' : 'I approved it'}
                </Button>
                <Button variant="ghost" onClick={() => setTwoWay(null)} disabled={busy !== null}>Cancel</Button>
              </div>
              <div className="mt-2 text-xs text-fg-subtle">The authority holds this session for about three minutes.</div>
            </div>
          )}

          {id && <details className="mt-5 border-t border-line pt-4 text-xs text-fg-muted"><summary className="cursor-pointer">Document check details</summary><DetailList className="mt-3">
            <DetailRow label="Result"><Tag tone={id.summary.authentic ? 'ok' : 'bad'}>{id.summary.authentic ? 'Verified' : 'not confirmed'}</Tag>{!id.summary.live && <span className="ml-2">Simulated check</span>}</DetailRow>
            <DetailRow label="Provider reference"><span className="mono">{id.summary.vendor} · {id.summary.ref ?? '—'}</span></DetailRow>
            <DetailRow label="Document hash"><Hash value={id.summary.docHash} full /></DetailRow>
          </DetailList></details>}
          {id && !id.summary.authentic && (
            <Band tone="bad" className="mt-3">This document could not be verified. Check the details and <button type="button" className="link" onClick={() => setId(null)}>try again</button>.</Band>
          )}
          <StepError err={err} step="id" /><StepError err={err} step="ocr" />
        </Step>

        {/* ── 2 bank ── */}
        <Step n={2} title="Bank account" state={bankDone ? 'done' : canBank ? 'active' : 'locked'}
          tag={bankDone && <Tag tone={bankRes!.summary.live ? 'ok' : 'warn'}>{bankRes!.summary.live ? 'Verified' : 'Sample checked'}</Tag>}>
          <p className="text-[13px] leading-5 text-fg-muted">
            {cfg?.bank.demo ? 'Check the sample account, then enter the code shown below. No money will move.' : 'We will send ₩1 to an account in your name. Enter the four-digit code shown in the deposit description.'}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {cfg?.bankState?.configured ? 'After five incorrect attempts, you will need to request a new code.' : 'Bank verification is currently unavailable.'}
          </p>
          <div className="mt-3 grid gap-3.5 sm:grid-cols-[220px_minmax(0,1fr)_auto]">
            <Field label="Bank">
              <select className={selectCls} value={bank.bankCode} disabled={!canBank || !!challenge || sampleMode} onChange={(e) => setBank({ ...bank, bankCode: e.target.value })}>
                {(cfg?.banks ?? []).map((b) => <option key={b.code} value={b.code}>{b.name} · {b.code}</option>)}
              </select>
            </Field>
            <Field label="Account number" hint="digits only">
              <Input className="mono" inputMode="numeric" value={bank.accountNumber} disabled={!canBank || !!challenge || sampleMode} onChange={(e) => setBank({ ...bank, accountNumber: digits(e.target.value).slice(0, 16) })} />
            </Field>
            <div className="flex items-end">
              <Button onClick={startBank} disabled={!canBank || busy !== null || !!challenge || bank.accountNumber.length < 8}>
                <Icon name="bolt" size={16} />{busy === 'bank' && !challenge ? 'Checking account…' : cfg?.bank.demo ? 'Check sample account' : 'Send ₩1 to verify'}
              </Button>
            </div>
          </div>
          {challenge && !bankDone && (
            <div className="mt-4 rounded-sm border border-line bg-sunk p-4">
              <div className="text-[13px] leading-5 text-fg-strong">
                Holder <span className="font-medium">{challenge.holderNameMasked}</span> matches the document. {challenge.live ? '₩1 was sent to' : 'No real deposit was made; simulated destination:'} {bankName(bank.bankCode)} ···{bank.accountNumber.slice(-4)}.
              </div>
              {challenge.demoCode ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 rounded-sm border border-warn/20 bg-warn-tint px-3 py-2">
                  <Tag tone="warn">demo</Tag>
                  <span className="text-xs text-fg-muted">Your sample verification code:</span>
                  <span className="mono text-base font-semibold text-fg-strong">{challenge.vendor.startsWith('openbanking') ? 'PM' : ''}{challenge.demoCode}</span>
                </div>
              ) : (
                <div className="mt-0.5 text-xs text-fg-muted">
                  Open the bank app. The deposit&apos;s sender name carries the code
                  {challenge.vendor.startsWith('openbanking') ? <> as <span className="mono">PM</span> followed by four digits</> : <> as four digits</>}.
                  {!challenge.live && <> This is the testbed: no deposit will appear, and the code cannot be known.</>}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="w-40"><Field label="Code" hint="4 digits"><Input className="mono" inputMode="numeric" value={code} onChange={(e) => setCode(digits(e.target.value).slice(0, 6))} autoFocus /></Field></div>
                <Button onClick={confirmCode} disabled={busy !== null || code.length < 4}>{busy === 'bank' ? 'Checking…' : 'Confirm'}</Button>
                <Button variant="ghost" onClick={() => { setChallenge(null); setCode(''); bankRequest.current = null; }} disabled={busy !== null}>Start over</Button>
              </div>
            </div>
          )}
          {bankRes && (
            <DetailList className="mt-4">
              <DetailRow label="Account">{bankName(bankRes.summary.bankCode)} · holder {bankRes.summary.holderNameMasked}</DetailRow>
              <DetailRow label="Checks"><span className="inline-flex gap-2"><Tag tone="ok">holder name</Tag><Tag tone="ok">one-won code</Tag>{!bankRes.summary.live && <Tag tone="warn">{bankRes.summary.vendor.startsWith('demo') ? 'demo' : 'testbed'}</Tag>}</span></DetailRow>
            </DetailList>
          )}
          <StepError err={err} step="bank" />
        </Step>

        {/* ── 3 issue ── */}
        <Step n={3} title="Review and submit" state={issued ? (issued.assetAction.ready ? 'done' : 'active') : canIssue ? 'active' : 'locked'}
          tag={issued && <Tag tone={issued.assetAction.ready ? 'ok' : ['FAILED', 'DENIED', 'REJECTED'].includes(issued.status) ? 'bad' : 'warn'}>{issued.assetAction.ready ? 'Ready' : ['FAILED', 'DENIED', 'REJECTED'].includes(issued.status) ? 'Action required' : 'Processing'}</Tag>}>
          <div className="grid gap-3.5 sm:grid-cols-4">
            <Field label="Declared name"><Input value={declared.fullName} readOnly /></Field>
            <Field label="Date of birth"><Input className="mono" value={declared.dateOfBirth} readOnly /></Field>
            <Field label="Nationality" hint="Country code, e.g. KR"><Input className="mono" value={country.nationality} maxLength={2} disabled={!!issued || sampleMode} onChange={(e) => setCountry({ ...country, nationality: e.target.value.toUpperCase() })} /></Field>
            <Field label="Residence" hint="Country code, e.g. KR"><Input className="mono" value={country.residence} maxLength={2} disabled={!!issued || sampleMode} onChange={(e) => setCountry({ ...country, residence: e.target.value.toUpperCase() })} /></Field>
          </div>
          <p className="mt-3 text-[13px] leading-5 text-fg-muted">
            Review your details before submitting. We will check them against the sanctions lists before requesting your credential.
          </p>
          <details className="mt-3 text-xs leading-5 text-fg-muted"><summary className="cursor-pointer text-fg">How your information is stored</summary><p className="mt-2">Your inputs are sent to this service. Verification commitments and metadata are published on Sepolia. Claims and supporting records are encrypted and retained until the request is reconciled and for 24 hours afterward. An issuer may retain a separate record under its processing policy.</p></details>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={issue} disabled={!canIssue || busy !== null || issued?.status === 'ISSUED'}>
              <Icon name="check" size={16} />{busy === 'issue' ? 'Submitting…' : 'Submit verification'}
            </Button>
            {issued && <Button variant="secondary" onClick={download}><Icon name="copy" size={16} />Download record</Button>}
            {issued?.subject && <Link href={`/onchain?subject=${issued.subject}`} className="link text-[13px]">View credential status</Link>}
            {issued?.issuance.lastError === 'SOURCE_REVERTED' && <Button variant="secondary" onClick={() => resumeIssue('retry')} disabled={busy !== null}>Retry reverted transaction</Button>}
          </div>
          {lastRequestId && <details className="mt-3 text-xs text-fg-muted"><summary className="cursor-pointer">Request reference</summary><p className="mono mt-2 break-all">{lastRequestId}</p></details>}
          {!cfg?.issuanceJournal?.configured && <p className="mt-2 text-xs text-fg-muted">Credential issuance is currently unavailable. Your completed checks do not issue a credential.</p>}

          {issued && issued.status !== 'ISSUED' && (
            <Band tone={['PREPARED', 'REVIEW'].includes(issued.status) ? 'warn' : 'bad'} className="mt-4">
              <span className="font-medium">{issued.status === 'REVIEW' ? 'Your request needs review.' : issued.status === 'PREPARED' ? 'Your request has been prepared.' : 'Your request could not be completed.'}</span> {issued.reason}
            </Band>
          )}
          {issued && <div className="mt-5 rounded-lg border border-line p-5">
            <h3 className="text-sm font-semibold text-fg-strong">Request progress</h3>
            <ol className="mt-4 grid gap-4 sm:grid-cols-3">
              {[
                { label: 'Transaction confirmed', done: issued.progress.source.state === 'confirmed' },
                { label: 'Credential received', done: issued.progress.attestation.state === 'applied' },
                { label: 'Asset eligibility checked', done: issued.assetAction.ready },
              ].map((step, index) => <li key={step.label} className="flex items-center gap-2.5 text-xs text-fg-muted"><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${step.done ? 'bg-ok-tint text-ok' : 'bg-surface-2 text-fg-subtle'}`}>{step.done ? <Icon name="check" size={13} /> : index + 1}</span>{step.label}</li>)}
            </ol>
            {issued.progress.timing.timedOut === true && <p className="mt-4 text-sm text-warn">This is taking longer than expected. Refresh the saved request or contact support.</p>}
            {issued.progress.timing.supportUrl && <a className="link mt-4 inline-block text-xs" href={issued.progress.timing.supportUrl}>Contact support</a>}
          </div>}
          {issued?.status === 'ISSUED' && (
            <>
              {issued.onchain && (
                <Band tone={issued.assetAction.ready ? 'ok' : issued.onchain.reverted ? 'bad' : 'warn'} className="mt-4">
                  {issued.assetAction.ready
                    ? 'Your credential is ready for the eligible assets listed in your verification record.'
                    : issued.onchain.reverted
                      ? 'The transaction failed. You can retry it using the button above.'
                      : issued.progress.attestation.state === 'applied'
                        ? 'Your credential has arrived. Asset access is not yet available.'
                        : 'Your credential is being processed. We will update its status here automatically.'}
                </Band>
              )}
              <details className="mt-5 text-xs text-fg-muted"><summary className="cursor-pointer">Verification record</summary>
              <DetailList className="mt-4">
                <DetailRow label="Wallet"><Hash value={issued.subject ?? ''} full /></DetailRow>
                {issued.onchain?.txHash && <DetailRow label="Transaction"><Hash value={issued.onchain.txHash} href={sepoliaTx(issued.onchain.txHash)} full /></DetailRow>}
                <DetailRow label="Completed checks">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Tag tone="gray" mono>{issued.methodsHex}</Tag>
                    {METHOD_BITS.filter((b) => issued.methodNames?.includes(b.key)).map((b) => <Tag key={b.key} tone="mint">{b.label}</Tag>)}
                  </span>
                </DetailRow>
                <DetailRow label="Eligible policies"><span className="inline-flex flex-wrap gap-2">{issued.progress.policy.policies.length ? issued.progress.policy.policies.map(policy => <Tag key={policy.id} tone={policy.verified ? 'ok' : 'bad'}>{policy.name || `Policy ${policy.id}`}: {policy.verified ? 'Eligible' : 'Not eligible'}</Tag>) : 'Not available yet'}</span></DetailRow>
                <DetailRow label="Verification type">{issued.regime === 1 ? 'Korean identity verification' : 'Sandbox identity verification'}</DetailRow>
                <DetailRow label="Expiry"><span className="mono">{issued.expiry ? new Date(issued.expiry * 1000).toISOString().slice(0, 10) : '—'}</span></DetailRow>
                <DetailRow label="Claims root"><Hash value={issued.claimsRoot ?? ''} full /></DetailRow>
                <DetailRow label="Evidence hash"><Hash value={issued.evidenceHash} full /></DetailRow>
              </DetailList>
              <p className="mt-3 leading-5">The downloaded record contains your claims and supporting verification data. Keep it private. {issued.vault?.stored ? 'The issuer also retains an encrypted record under its processing policy.' : 'An encrypted recovery record is retained temporarily.'}</p>
              </details>
            </>
          )}
          <StepError err={err} step="issue" />
        </Step>
      </div>
    </>
  );
}

function Step({ n, title, state, tag, children }: { n: number; title: string; state: 'locked' | 'active' | 'done'; tag: ReactNode; children: ReactNode }) {
  const tone: Tone = state === 'done' ? 'ok' : state === 'active' ? 'mint' : 'gray';
  return (
    <section aria-labelledby={`verify-step-${n}`} className={`panel ${state === 'active' ? 'border-mint/40' : ''}`}>
      <details open={state !== 'locked'}>
      <summary className="flex min-h-20 cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 [&::-webkit-details-marker]:hidden sm:px-6">
        <span className={`mono inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${state === 'done' ? 'bg-mint text-mint-fg' : state === 'active' ? 'border border-mint text-mint shadow-[0_0_12px_var(--mint-glow)]' : 'border border-line-strong text-fg-subtle'}`}>
          {state === 'done' ? <Icon name="check" size={15} /> : `0${n + 1}`}
        </span>
        <h2 id={`verify-step-${n}`} className="display text-[17px] leading-6">{title}</h2>
        <span className="sr-only">{state === 'done' ? 'Completed' : state === 'active' ? 'Ready' : 'Waiting for previous steps'}</span>
        <span className="ml-auto flex items-center gap-2">
          {state === 'locked' && <Status tone={tone}>Up next</Status>}
          {tag}
          <Icon name="chevron" size={16} className="text-fg-subtle" />
        </span>
      </summary>
      <div className="border-t border-line p-5 sm:p-6">{children}</div>
      </details>
    </section>
  );
}

function StepError({ err, step }: { err: { step: string; text: string } | null; step: string }) {
  return <div role="alert" aria-atomic="true">{err?.step === step && <Band tone="bad" className="mt-3">{err.text}</Band>}</div>;
}
