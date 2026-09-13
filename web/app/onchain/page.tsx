'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader, Section } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';
import { cc3Address, cc3Block, sepoliaAddress } from '@/lib/links';
import { METHOD_BITS, setBits } from '@/lib/methods';
import type { readOnchainState } from '@pipeline/onchain-state.js';

type Data = Awaited<ReturnType<typeof readOnchainState>>;
type Policy = Data['policies'][number];

const SUBJECTS = [
  { key: 'active', label: 'Issued wallet', subject: null as string | null },
  { key: 'control', label: 'Unverified wallet', subject: '0x00000000000000000000000000000000DeaDBeef' },
];

const STATUS: Record<number, { label: string; tone: Tone }> = {
  0: { label: 'No credential found', tone: 'gray' }, 1: { label: 'Credential on file', tone: 'ok' }, 2: { label: 'Credential revoked', tone: 'bad' },
  3: { label: 'Verification denied', tone: 'bad' }, 4: { label: 'Verification suspended', tone: 'warn' },
};
const ORIGIN = ['None', 'Direct', 'Roster'];
const REGIME: Record<number, string> = { 1: 'production', 2: 'sandbox' };
const CHAIN_KEY: Record<number, string> = { 1: 'Ethereum Sepolia' };
const ISO_NUMERIC: Record<number, string> = { 410: 'KR · Korea', 840: 'US · United States', 276: 'DE · Germany', 826: 'GB · United Kingdom', 392: 'JP · Japan' };

const ts = (sec: number) => (sec ? new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const days = (sec: number) => (sec ? `${Math.round(sec / 86400)} d` : 'no limit');

export default function OnChain() {
  return <Suspense fallback={<Loading />}><OnChainView /></Suspense>;
}

function Header() {
  return (
    <PageHeader
      eyebrow="On-chain status"
      title="Wallet lookup"
      lede="Check a wallet’s verification status and service requirements."
      aside={<Tag tone="gray">Creditcoin testnet</Tag>}
    />
  );
}

function WalletSearch({ current }: { current: string | null }) {
  return (
    <div className="panel mb-6 p-5 sm:p-6">
      <form action="/onchain" method="get" role="search" aria-label="Wallet lookup">
        <label htmlFor="wallet-address" className="index mb-2 block text-fg-muted">Wallet address</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input key={current ?? 'sample'} id="wallet-address" name="subject" defaultValue={current ?? ''}
              required pattern="0x[a-fA-F0-9]{40}" maxLength={42} autoComplete="off" spellCheck={false}
              aria-describedby="wallet-format" placeholder="Enter a wallet address, starting with 0x"
              className="mono h-10 w-full rounded-md border border-line-strong bg-sunk pl-10 pr-4 text-fg-strong placeholder:font-sans placeholder:text-[13px] placeholder:text-fg-subtle focus:border-mint focus:shadow-[0_0_0_3px_var(--mint-tint)] focus:outline-none" />
          </div>
          <button type="submit" className="btn btn-md btn-primary">
            Look up wallet<Icon name="arrow" size={14} />
          </button>
        </div>
        <span id="wallet-format" className="sr-only">Use a 42-character wallet address: 0x followed by 40 hexadecimal characters.</span>
      </form>
      <SubjectTabs current={current} />
    </div>
  );
}

function LoadingResult() {
  return (
    <div role="status" aria-live="polite" className="panel p-6">
      <div className="flex items-center gap-3 text-sm text-fg-muted">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-mint" aria-hidden />
        Checking verification status…
      </div>
      <div className="mt-5 h-8 w-56 animate-pulse rounded-sm bg-surface-2" aria-hidden />
      <div className="mt-4 h-4 max-w-md animate-pulse rounded-sm bg-surface-2" aria-hidden />
    </div>
  );
}

function Loading() {
  return (
    <>
      <Header />
      <WalletSearch current={null} />
      <LoadingResult />
    </>
  );
}

function SubjectTabs({ current }: { current: string | null }) {
  return (
    <nav className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1" aria-label="Sample wallets">
      <span className="index">Sample wallets</span>
      {SUBJECTS.map(s => {
        const active = (s.subject ?? null) === current;
        return (
          <Link key={s.key} aria-current={active ? 'page' : undefined}
            href={s.subject ? `/onchain?subject=${s.subject}` : '/onchain'}
            className={`index inline-flex min-h-8 items-center gap-1.5 transition-colors ${
              active ? 'text-mint' : 'text-fg-muted hover:text-mint'}`}>
            {s.label}
            <Icon name="arrow" size={11} />
          </Link>
        );
      })}
    </nav>
  );
}

const REASONS: Record<string, string> = {
  UNKNOWN_POLICY: 'This service policy is unavailable.', SUBJECT_TOMBSTONED: 'This wallet is restricted.',
  AWAITING_ROSTER_WITNESS: 'An updated verification proof is needed.', STALE_ROSTER_WITNESS: 'The verification proof needs to be updated.',
  ISSUER_ROOT_NOT_APPROVED: 'Issuer approval is required.', ROSTER_NOT_FRESH: 'The verification list needs to be updated.',
  WITNESS_CAPABILITY_UNAVAILABLE: 'Verification proof could not be checked.', NO_ACTIVE_DIRECT_MARK: 'No active credential is recorded.',
  ISSUER_KEY_COMPROMISE_CUTOFF: 'The issuer’s signing key is no longer accepted for this credential.',
  INVALID_CREDENTIAL_SCHEMA: 'This credential format is not supported.', WRONG_CREDENTIAL_KIND: 'A different account type is required.',
  MISSING_METHODS: 'Additional verification checks are required.', LOW_ASSURANCE: 'A higher verification level is required.', WRONG_REGIME: 'This credential is for a different environment.',
  WRONG_JURISDICTION: 'The credential does not meet the country requirement.', WRONG_ISSUER: 'A credential from an approved issuer is required.', CREDENTIAL_EXPIRED: 'The credential has expired.',
  FUTURE_ISSUANCE: 'Issuance time is in the future.', CREDENTIAL_TOO_OLD: 'Credential exceeds policy maximum age.',
};
function PolicyCard({ p }: { p: Policy }) {
  const explained = p.diagnosis === 'consistent';
  const known = p.decisionMark !== null;
  const mask = p.decisionMark?.methods ?? 0;
  const required = METHOD_BITS.filter(b => (p.requireAll & (1 << b.bit)) !== 0);
  const why = p.diagnosis === 'unavailable' ? 'This result could not be confirmed. The verification service uses an unsupported or unconfirmed format.'
    : p.diagnosis === 'unexplained' ? 'Verification records do not agree. A result cannot be confirmed.'
      : p.verified ? 'This wallet meets the policy requirements at the time checked.'
        : REASONS[p.reasonCodes[0]] ?? 'This wallet does not meet all requirements.';
  const title = p.name === 'KR VASP production' ? 'Korea · production' : p.name === 'KR sandbox pilot' ? 'Korea · sandbox' : p.name;
  return (
    <div className="panel flex flex-col overflow-hidden" data-policy={p.name} data-result={!explained ? 'UNCONFIRMED' : p.verified ? 'PASS' : 'FAIL'}>
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <h3 className="display text-[17px] leading-6">{title}</h3>
        </div>
        <Tag tone={!explained ? 'warn' : p.verified ? 'ok' : 'bad'} size="lg">{!explained ? 'Unconfirmed' : p.verified ? 'Requirements met' : 'Not met'}</Tag>
      </div>
      <p className="px-5 pb-4 pt-2 text-[13px] leading-5 text-fg-muted">{why}</p>
      <ul className="flex-1 border-t border-divider px-5">
        {required.map(b => {
          const ok = (mask & (1 << b.bit)) !== 0;
          return (
            <li key={b.key} data-missing={!known || ok ? undefined : b.label}
              className="grid min-h-11 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 border-b border-divider py-2 text-[13px] last:border-b-0">
              <Icon name={!known ? 'clock' : ok ? 'check' : 'x'} size={16} className={!known ? 'text-fg-muted' : ok ? 'text-ok' : 'text-bad'} />
              <span className={ok ? 'font-medium text-fg-strong' : 'text-fg-muted'}>{b.label}</span>
              <span className={`text-xs ${!known ? 'text-fg-muted' : ok ? 'text-ok' : 'text-bad'}`}>{!known ? 'Unknown' : ok ? 'Complete' : 'Required'}</span>
            </li>
          );
        })}
      </ul>
      <details className="mt-auto border-t border-line px-5 py-3">
        <summary className="index cursor-pointer text-fg-muted hover:text-fg-strong">Policy details</summary>
        <p className="mt-3 text-xs leading-5 text-fg-muted">Registry response: CHAIN {p.verified ? 'TRUE' : 'FALSE'}. State-based diagnostic, not a contract reason code. {p.warning}</p>
        {p.reasonCodes.length > 0 && <ul className="mt-2 space-y-1 text-xs leading-5 text-fg-muted">{p.reasonCodes.map(code => <li key={code}>{REASONS[code] ?? code}</li>)}</ul>}
        <div className="mono mt-2 text-fg-muted">policy #{p.id} · schema {p.policySchemaVersion ?? 'unconfirmed'} · kind {p.kind ?? 'unconfirmed'} · {p.frozen ? 'frozen' : 'mutable'}</div>
        <div className="mono mt-1 text-fg-muted">methods {p.decisionMark?.methods ?? 'unknown'} · required {p.requireAll}</div>
        <div className="mono mt-1 text-fg-muted">
          min assurance {p.minAssurance} · max age {days(p.maxAge)} · roster {p.requireRoster ? 'required' : 'not required'}
        </div>
        <div className="mono mt-1 text-fg-muted">
          regime {p.requiredRegime || 'any'} · jurisdiction {p.requiredJurisdiction || 'any'} · issuer {p.trustedIssuer.slice(0, 8)}…
        </div>
      </details>
    </div>
  );
}

/**
 * Mode B state, read from the ASC.
 *
 * Two states and no third. Before an epoch exists there is nothing to dress up: every mark on the
 * chain is `origin = Direct`, which proves issuance and is silent about a revocation nobody
 * submitted, and the page says exactly that. After one exists, the root and its expiry are shown
 * with the freshness the contract itself reports, because an expired roster verifies nobody.
 */
function EpochRoster({ e, proofMode }: { e: Data['epoch']; proofMode: boolean }) {
  const published = e.latestEpoch >= 1;
  return (
    <Section title="Epoch roster (Mode B)"
      aside={<Tag tone={published ? (e.fresh ? 'ok' : 'bad') : 'gray'}>{published ? (e.fresh ? 'fresh' : 'expired') : 'not published'}</Tag>}
      lede="Mode A proves past issuance. Mode B commits an asserted set; absence does not establish legal revocation or its reason.">
      <DetailList>
        <DetailRow label="Latest epoch" hint="ProofmarkASC.latestEpoch()">
          <span className="mono">{e.latestEpoch}</span>
          {!published && <span className="text-fg-muted"> · none published</span>}
        </DetailRow>
        <DetailRow label="Roster root" hint="ProofmarkASC.epochRoots(latestEpoch)">
          {e.root ? <Hash value={e.root} full /> : <span className="text-fg-muted">not set</span>}
        </DetailRow>
        <DetailRow label="Valid until" hint="ProofmarkASC.epochValidUntil()">
          <span className="mono">{e.validUntil ? ts(e.validUntil) : '—'}</span>
        </DetailRow>
        <DetailRow label="Source cutoff · publication"><span className="mono">{e.sourceCutoff === null ? 'unconfirmed' : ts(e.sourceCutoff)} → {e.publishedAt === null ? 'unconfirmed' : ts(e.publishedAt)}</span></DetailRow>
        <DetailRow label="Snapshot binding">{e.snapshotId ? <Hash value={e.snapshotId} full /> : 'unconfirmed / legacy'}</DetailRow>
        <DetailRow label="Freshness" hint="ProofmarkASC.isRosterFresh()">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Tag tone={e.fresh ? 'ok' : 'bad'}>{e.fresh ? 'fresh' : 'not fresh'}</Tag>
            <span className="text-fg-muted">
              {e.fresh
                ? (proofMode ? 'verifyWithRoster answers' : 'inside its validity window')
                : 'verifyWithRoster fails closed for every subject'}
            </span>
          </span>
        </DetailRow>
        <DetailRow label="Roster compatibility" hint="Roster, epoch, authorization, attrs and receipt schemas plus bound ASC; not an audit">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Tag tone={proofMode ? 'ok' : 'warn'}>{proofMode ? 'schemas supported' : 'unsupported or unconfirmed'}</Tag>
            <span className="text-fg-muted">{proofMode ? 'v2 proof interface detected; root integrity still depends on the publisher' : 'do not rely on legacy roster proofs'}</span>
          </span>
        </DetailRow>
      </DetailList>
      {/* Band takes no arbitrary props, so the marker attribute lives on the wrapper. */}
      <div data-epoch={published ? 'published' : 'none'}>
      <Band tone="note" className="mt-3">
        {published ? (
          <>
            <p>
              A valid membership proof binds a mark to the publisher&apos;s snapshot. Absence proves only non-membership,
              not the reason for removal or a legal revocation. In v2, both proof paths reject epochs past
              {' '}<code className="mono text-fg-strong">validUntil</code>.
            </p>
            {!proofMode && (
              <p className="mt-1.5 text-fg-muted">
                Security review on 6 September 2026 found a forged non-membership proof accepted by the legacy registry
                and an out-of-order denial defect in the legacy ASC. Local fixes require contract migration.
                Policy cards report current chain responses, not an assurance that these defects are fixed.
              </p>
            )}
          </>
        ) : (
          <p>
            No epoch has been published, so every mark here is <code className="mono text-fg-strong">origin = Direct</code>: proof of
            issuance, silent about a revocation nobody submitted cross-chain.
          </p>
        )}
      </Band>
      </div>
    </Section>
  );
}

function OnChainView() {
  const params = useSearchParams();
  const subject = params.get('subject');
  const [refresh, setRefresh] = useState(0);
  const requestKey = `${subject ?? ''}:${refresh}`;
  /* Keyed by subject so switching tabs shows the loading state without a synchronous reset. */
  const [state, setState] = useState<{ key: string | null; data?: Data; err?: string }>({ key: '__init' });

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    fetch(subject ? `/api/onchain?subject=${encodeURIComponent(subject)}` : '/api/onchain', { cache: 'no-store', signal: controller.signal }).then(r => r.json())
      .then(j => live && setState({ key: requestKey, ...(j.error ? { err: String(j.error) } : { data: j as Data }) }))
      .catch(() => live && setState({ key: requestKey, err: 'We couldn’t check this wallet. Please try again.' }))
      .finally(() => clearTimeout(timeout));
    return () => { live = false; clearTimeout(timeout); controller.abort(); };
  }, [subject, requestKey]);

  const current = state.key === requestKey ? state : null;
  const d = current?.data ?? null;
  const err = current?.err ?? null;

  if (err) return (
    <>
      <Header />
      <WalletSearch current={subject} />
      <div role="alert" className="panel flex flex-col items-center px-6 py-12 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md border border-warn/25 bg-warn-tint text-warn"><Icon name="warning" size={22} /></div>
        <h2 className="display text-[22px] leading-7">Verification status unavailable</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-fg-muted">We couldn’t retrieve a current result for this wallet. Try again in a moment.</p>
        <button aria-label="Retry observation" className="btn btn-md btn-primary mt-5" onClick={() => setRefresh(n => n + 1)}>Try again</button>
        <details className="mt-5 max-w-xl text-xs text-fg-muted"><summary className="cursor-pointer">Error details</summary><p className="mt-2 break-words">{err}</p></details>
      </div>
    </>
  );
  if (!d) return <><Header /><WalletSearch current={subject} /><LoadingResult /></>;

  const m = d.mark;
  const status = STATUS[m.status] ?? { label: String(m.status), tone: 'gray' as Tone };
  const revoked = d.tombstone || m.status === 2;
  const claims = setBits(m.methods);
  const expired = m.status === 1 && m.expiry > 0 && m.expiry <= d.observation.timestamp;
  const statusLabel = d.tombstone ? 'Wallet restricted' : expired ? 'Credential expired' : status.label;
  const statusTone = d.tombstone ? 'bad' : expired ? 'warn' : status.tone;

  return (
    <>
      <Header />
      <WalletSearch current={subject} />

      <section aria-label="Wallet verification result" className="panel overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-5 p-5 sm:p-6">
          <div className="flex min-w-0 items-start gap-4">
            <div className={`hidden h-12 w-12 shrink-0 items-center justify-center rounded-md border sm:flex ${statusTone === 'ok' ? 'border-ok/25 bg-ok-tint text-ok' : statusTone === 'bad' ? 'border-bad/25 bg-bad-tint text-bad' : statusTone === 'warn' ? 'border-warn/25 bg-warn-tint text-warn' : 'border-line bg-canvas-2 text-fg-muted'}`}>
              <Icon name={statusTone === 'bad' || statusTone === 'warn' ? 'warning' : m.status === 0 ? 'wallet' : 'shield'} size={22} />
            </div>
            <div className="min-w-0">
              <div className="index mb-1.5">Verification status</div>
              <h2 className="display text-[22px] leading-7 sm:text-[26px] sm:leading-8">{statusLabel}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                <Hash value={d.subject} href={cc3Address(d.subject)} head={10} tail={6} />
                {m.regime === 2 && <Tag tone="gray">Sandbox credential</Tag>}
              </div>
            </div>
          </div>
          <button aria-label="Refresh observation" className="btn btn-sm btn-secondary" onClick={() => setRefresh(n => n + 1)}>Refresh</button>
        </div>
        {m.status === 0 && <p className="px-5 pb-5 text-sm text-fg-muted sm:px-6">This wallet has no verification credential on this network.</p>}
        <div className="grid grid-cols-3 gap-px border-t border-line bg-line">
          <div className="bg-surface px-3 py-4 sm:px-6"><p className="index">Country</p><p className="mt-1.5 text-[13px] font-semibold text-fg-strong sm:text-sm">{ISO_NUMERIC[m.jurisdiction]?.split(' · ')[1] ?? (m.jurisdiction || 'Not available')}</p></div>
          <div className="bg-surface px-3 py-4 sm:px-6"><p className="index">Level</p><p className="mt-1.5 text-[13px] font-semibold text-fg-strong sm:text-sm">{m.status === 0 ? 'Not available' : `Level ${m.assurance}`}</p></div>
          <div className="bg-surface px-3 py-4 sm:px-6"><p className="index">Expires</p><p className="mt-1.5 text-[13px] font-semibold text-fg-strong sm:text-sm">{m.expiry ? ts(m.expiry).slice(0, 10) : 'Not available'}</p></div>
        </div>
      </section>

      <Section index="01" title="Service requirements" aside={<span className="mono">Checked {ts(d.observation.timestamp)}</span>}>
        <div className="grid gap-4 md:grid-cols-2">
          {d.policies.map(p => <PolicyCard key={p.id} p={p} />)}
        </div>
      </Section>

      {revoked && (
        <Band tone="bad" className="mt-4">This wallet is restricted in the current network record. Contact the credential issuer for more information.</Band>
      )}

      <details className="panel mt-6 px-5 pb-1 sm:px-6">
        <summary className="index cursor-pointer py-4 text-fg-strong hover:text-mint">Credential details</summary>
        <div className="pb-5">
        <DetailList>
          <DetailRow label="Subject" hint="The wallet the mark is bound to"><Hash value={d.subject} href={cc3Address(d.subject)} full /></DetailRow>
          <DetailRow label="Issuer" hint="Address that issued on the source chain"><Hash value={m.issuer} href={sepoliaAddress(m.issuer)} full /></DetailRow>
          <DetailRow label="Status">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Tag tone={statusTone}>{statusLabel}</Tag>
              {d.tombstone && <Tag tone="bad">tombstone</Tag>}
            </span>
          </DetailRow>
          <DetailRow label="Origin · regime">
            {ORIGIN[m.origin] ?? m.origin} · kind {m.kind} · regime {m.regime}{REGIME[m.regime] ? ` (${REGIME[m.regime]})` : ''}
          </DetailRow>
          <DetailRow label="Jurisdiction">{ISO_NUMERIC[m.jurisdiction] ?? m.jurisdiction} <span className="text-fg-muted">· ISO 3166-1 numeric {m.jurisdiction}</span></DetailRow>
          <DetailRow label="Methods" hint="Checks the issuer claims to have performed">
            <span className="flex flex-wrap items-center gap-1.5">
              <Tag tone="gray" mono>{m.methodsHex}</Tag>
              {claims.map(c => <Tag key={c.key} tone="mint">{c.label}</Tag>)}
              {claims.length === 0 && <span className="text-fg-muted">no bits set</span>}
            </span>
          </DetailRow>
          <DetailRow label="Claims root"><Hash value={m.claimsRoot} full /></DetailRow>
          <DetailRow label="Evidence hash"><Hash value={m.evidenceHash} full /></DetailRow>
          <DetailRow label="Issued · expiry"><span className="mono">{ts(m.issuedAt)} <span className="text-fg-muted">→</span> {ts(m.expiry)}</span></DetailRow>
          <DetailRow label="Epoch"><span className="mono">{m.epoch}</span></DetailRow>
        </DetailList>
        <Band tone="note" className="mt-3">
          Two 32-byte commitments. No name, date of birth, document number, or account number is on chain. Wallet-linked metadata remains pseudonymous and linkable.
        </Band>
        {m.issuerTombstoned && (
          /* Band takes no arbitrary props, so the marker attribute lives on the wrapper. */
          <div data-note="issuer-reuse">
            <Band tone="note" className="mt-3">
              This issuer address is also tombstoned as a subject. That alone establishes neither issuer-key compromise nor its absence.
              Subject tombstones and issuer authority are separate; this state read does not resolve the underlying incident.
            </Band>
          </div>
        )}
        </div>
      </details>

      <details className="panel mt-3 px-5 pb-1 sm:px-6">
        <summary className="index cursor-pointer py-4 text-fg-strong hover:text-mint">Network &amp; technical details</summary>
        <div className="pb-5">
          <DetailList>
            <DetailRow label="Network">Creditcoin CC3 Testnet</DetailRow>
            <DetailRow label="Checked at"><span className="mono">{ts(d.observation.timestamp)}</span></DetailRow>
            <DetailRow label="Block"><a href={cc3Block(d.blockNumber)} target="_blank" rel="noreferrer" className="link mono inline-flex items-center gap-1.5">{d.blockNumber.toLocaleString()}<Icon name="external" size={12} /></a></DetailRow>
            <DetailRow label="Block hash"><Hash value={d.observation.blockHash} full /></DetailRow>
          </DetailList>
          <p className="mt-3 text-xs leading-5 text-fg-muted">This is a single-block observation, not a finality guarantee. The block hash is rechecked after reads. Source and hub transaction links are unresolved by this state read.</p>
      <Section title="Verification contracts">
        <DetailList>
          <DetailRow label="Contract"><Hash value={d.asc.address} href={cc3Address(d.asc.address)} full /></DetailRow>
          <DetailRow label="Expected chain key">
            <span className="inline-flex items-center gap-2"><Tag tone="gray" mono>{d.asc.expectedChainKey}</Tag>{CHAIN_KEY[d.asc.expectedChainKey] ?? 'unknown chain'}</span>
          </DetailRow>
          <DetailRow label="Source contract"><Hash value={d.asc.sourceContract} href={sepoliaAddress(d.asc.sourceContract)} full /></DetailRow>
          <DetailRow label="Registry"><Hash value={d.registry.address} href={cc3Address(d.registry.address)} full /></DetailRow>
        </DetailList>
      </Section>

      <EpochRoster e={d.epoch} proofMode={d.registry.proofMode} />
      <Section title="Registry roster witness" lede="Separate from the Direct ASC mark above. Delivery time never renews the epoch lifetime.">
        <DetailList>
          <DetailRow label="Capability">{d.registry.versions.ROSTER_WITNESS_VERSION ?? 'unconfirmed'}</DetailRow>
          <DetailRow label="Cached epoch">{d.witness?.epoch || 'not cached'}</DetailRow>
          <DetailRow label="Issuer approval">{d.witness?.epoch ? (d.witness.issuerApproved ? 'approved for cached epoch' : 'not approved') : 'not confirmed'}</DetailRow>
          <DetailRow label="Current epoch">{d.witness?.epoch && d.witness.epoch === d.epoch.latestEpoch ? 'matches; policy and expiry still apply' : 'no current witness'}</DetailRow>
        </DetailList>
      </Section>
        </div>
      </details>
    </>
  );
}
