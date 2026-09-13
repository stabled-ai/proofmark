'use client';

import { useEffect, useRef, useState } from 'react';
import type { readOnchainState } from '@pipeline/onchain-state.js';
import { isTrainingResult, type SanctionsTrainingResult, type TrainingScenario } from '@pipeline/sanctions-training-model.js';
import { Band } from '@/components/ui/Band';
import { Button, LinkButton } from '@/components/ui/Button';
import { Hash } from '@/components/ui/Hash';
import { Icon } from '@/components/ui/Icon';
import { PageHeader, Section } from '@/components/ui/Page';
import { Status } from '@/components/ui/Status';
import { Tag, type Tone } from '@/components/ui/Tag';
import { cc3Block } from '@/lib/links';
import { missingBits, setBits } from '@/lib/methods';

type ChainState = Awaited<ReturnType<typeof readOnchainState>>;
type Policy = ChainState['policies'][number];

const SCENARIOS: { id: TrainingScenario; label: string; short: string }[] = [
  { id: 'full-match', label: 'Full identity match', short: 'Matching name and birth date' },
  { id: 'name-only', label: 'Name only', short: 'Birth date not provided' },
  { id: 'dob-conflict', label: 'Different birth date', short: 'Same name, different details' },
  { id: 'no-match', label: 'No match', short: 'A different sample identity' },
];

const REASON: Record<string, { human: string; action: string }> = {
  LEGACY_OR_UNCONFIRMED_SCHEMA: { human: 'This credential version could not be verified.', action: 'Contact the issuer to check compatibility.' },
  UNKNOWN_POLICY: { human: 'This application’s requirements are unavailable.', action: 'Choose a registered application.' },
  SUBJECT_TOMBSTONED: { human: 'This credential holder is restricted.', action: 'Contact the issuer to request a review.' },
  AWAITING_ROSTER_WITNESS: { human: 'Current roster membership has not been confirmed.', action: 'The issuer needs to confirm membership before access can be granted.' },
  STALE_ROSTER_WITNESS: { human: 'Roster membership needs to be refreshed.', action: 'Ask the issuer to update the membership record.' },
  ISSUER_ROOT_NOT_APPROVED: { human: 'The issuer is not approved for the current roster.', action: 'A credential from an approved issuer is required.' },
  ROSTER_NOT_FRESH: { human: 'The verification roster has expired or is unavailable.', action: 'Access will remain unavailable until the issuer updates the roster.' },
  WITNESS_CAPABILITY_UNAVAILABLE: { human: 'Roster verification is unavailable.', action: 'Contact the application to resolve this verification issue.' },
  NO_ACTIVE_DIRECT_MARK: { human: 'No active credential is recorded.', action: 'Complete identity verification and wait for the credential to be issued.' },
  INVALID_CREDENTIAL_SCHEMA: { human: 'The credential attributes do not fit the supported schema.', action: 'Reissue through a compatible adapter and schema.' },
  WRONG_CREDENTIAL_KIND: { human: 'The credential kind does not match this policy.', action: 'Use a policy for this subject kind or obtain the required credential kind.' },
  MISSING_METHODS: { human: 'One or more checks required by this policy are absent.', action: 'Complete the missing checks through an approved provider.' },
  LOW_ASSURANCE: { human: 'The recorded assurance is below the policy minimum.', action: 'Complete a higher-assurance verification flow.' },
  WRONG_REGIME: { human: 'This credential does not meet the required verification environment.', action: 'Production access requires verification through an approved production provider.' },
  WRONG_JURISDICTION: { human: 'The verified jurisdiction does not match this policy.', action: 'Choose an applicable policy; never change jurisdiction by self-declaration.' },
  WRONG_ISSUER: { human: 'The credential issuer is not the address pinned by this policy.', action: 'Use a credential from the policy’s trusted issuer.' },
  CREDENTIAL_EXPIRED: { human: 'The credential has expired.', action: 'Re-verify and issue a fresh credential.' },
  FUTURE_ISSUANCE: { human: 'The issuance time is later than the observation block.', action: 'Reject the observation and investigate clock or state integrity.' },
  CREDENTIAL_TOO_OLD: { human: 'The credential is older than this policy permits.', action: 'Re-screen and issue a fresh credential.' },
};

const timestamp = (seconds: number) => seconds
  ? new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  : 'not available';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

/** A successful HTTP status is not enough to paint a chain verdict. Validate every field this view reads. */
export function isChainState(value: unknown): value is ChainState {
  const v = record(value); const observation = record(v?.observation); const mark = record(v?.mark); const asc = record(v?.asc); const epoch = record(v?.epoch);
  if (!v || !observation || !mark || !asc || !epoch || !Array.isArray(v.policies) || v.policies.length !== 2) return false;
  if (typeof v.subject !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v.subject) || !Number.isSafeInteger(v.blockNumber) || Number(v.blockNumber) < 0
    || typeof v.tombstone !== 'boolean' || typeof observation.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(observation.blockHash)
    || !Number.isSafeInteger(observation.timestamp) || typeof mark.methods !== 'number' || typeof mark.methodsHex !== 'string' || typeof mark.status !== 'number'
    || typeof mark.regime !== 'number' || typeof mark.assurance !== 'number' || typeof mark.jurisdiction !== 'number' || typeof mark.origin !== 'number'
    || typeof asc.sourceContract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(asc.sourceContract) || typeof asc.expectedChainKey !== 'number'
    || typeof epoch.fresh !== 'boolean' || typeof epoch.latestEpoch !== 'number' || typeof epoch.validUntil !== 'number') return false;
  return v.policies.every(value => {
    const policy = record(value);
    return !!policy && typeof policy.id === 'number' && typeof policy.name === 'string'
      && typeof policy.verified === 'boolean' && typeof policy.frozen === 'boolean' && typeof policy.requireRoster === 'boolean'
      && typeof policy.requireAll === 'number' && typeof policy.minAssurance === 'number'
      && typeof policy.requiredRegime === 'number' && typeof policy.maxAge === 'number'
      && ['consistent', 'unavailable', 'unexplained'].includes(String(policy.diagnosis))
      && Array.isArray(policy.reasonCodes) && policy.reasonCodes.every(code => typeof code === 'string')
      && (policy.decisionMark === null || typeof record(policy.decisionMark)?.methods === 'number');
  });
}

export function policyVerdict(policy: Policy) {
  if (policy.diagnosis !== 'consistent') return { label: `CHAIN ${policy.verified ? 'TRUE' : 'FALSE'}`, tone: 'warn' as Tone, reliable: false };
  return { label: policy.verified ? 'PASS' : 'FAIL', tone: policy.verified ? 'ok' as Tone : 'bad' as Tone, reliable: true };
}

export function firstReason(policy: Policy) {
  const code = policy.reasonCodes[0];
  if (!code) return policy.verified
    ? { human: 'This credential meets the application’s verification requirements.', action: 'Continue to the application to complete its access checks.' }
    : { human: 'Access could not be confirmed.', action: 'Check the credential details and try again.' };
  return REASON[code] ?? { human: code.replaceAll('_', ' ').toLowerCase(), action: 'Inspect the complete on-chain state before taking action.' };
}

function Skeleton() {
  return <div className="mt-4 grid gap-4 lg:grid-cols-2" aria-hidden>{[0, 1].map(i => <div key={i} className="h-56 animate-pulse rounded-md bg-surface" />)}</div>;
}

function TrainingCard({ result, scenario, onScenario, busy }: { result: SanctionsTrainingResult; scenario: TrainingScenario; onScenario: (scenario: TrainingScenario) => void; busy: boolean }) {
  const tone: Tone = result.trainingDecision === 'BLOCK' ? 'bad' : result.trainingDecision === 'REVIEW' ? 'warn' : 'ok';
  const outcome = result.trainingDecision === 'BLOCK' ? 'Blocked' : result.trainingDecision === 'REVIEW' ? 'Review required' : 'No match found';
  const explanation = result.trainingDecision === 'BLOCK'
    ? 'The sample name and birth date support a match.'
    : result.trainingDecision === 'REVIEW'
      ? result.comparisons[0]?.dateOfBirth === 'conflict'
        ? 'The name matches, but the birth date is different. Review the identity details.'
        : 'The name is similar. More identity information is needed.'
      : 'This identity does not match the sample record.';
  return (
    <article className="panel overflow-hidden" data-demo-training={result.trainingDecision}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
        <h2 className="display text-[17px] leading-6">Sample screening</h2>
        <Icon name="search" size={18} className="text-mint" />
      </div>
      <div className="p-6">
        <p className="index">Sample identity</p>
        <p className="display mt-1.5 text-[20px] leading-7">{result.subject.name}</p>
        <p className="mt-1 text-[13px] text-fg-muted">{result.subject.dateOfBirth || 'Birth date not provided'}{result.subject.nationality ? ` · ${result.subject.nationality}` : ''}</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {SCENARIOS.map(item => (
            <button key={item.id} type="button" disabled={busy} onClick={() => onScenario(item.id)} aria-pressed={scenario === item.id}
              className={`rounded-md border px-3.5 py-3 text-left transition-colors disabled:opacity-50 ${scenario === item.id ? 'border-mint bg-mint-tint' : 'border-line hover:border-line-strong hover:bg-surface-2'}`}>
              <span className="block text-[13px] font-medium text-fg-strong">{item.label}</span><span className="mt-0.5 block text-xs text-fg-muted">{item.short}</span>
            </button>
          ))}
        </div>
        <div className="mt-5 border-t border-line pt-5"><Status tone={tone} className="display text-[20px] leading-7">{outcome}</Status><p className="mt-2 text-[13px] leading-5 text-fg-muted">{explanation}</p></div>
      </div>
    </article>
  );
}

function CredentialCard({ data }: { data: ChainState }) {
  const methods = setBits(data.mark.methods);
  const status = data.tombstone ? 'RESTRICTED' : data.mark.status === 1 ? 'ACTIVE' : `STATUS ${data.mark.status}`;
  const tone: Tone = data.tombstone ? 'bad' : data.mark.status === 1 ? 'ok' : 'warn';
  return (
    <article className="panel overflow-hidden" data-demo-chain="loaded">
      <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
        <h2 className="display text-[17px] leading-6">Testnet credential</h2>
        <Icon name="shield" size={18} className="text-mint" />
      </div>
      <div className="p-6">
        <div className="rounded-md border border-mint/20 bg-mint-tint p-5"><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-mint">Proofmark</span><Status tone={tone}>{status.charAt(0) + status.slice(1).toLowerCase()}</Status></div><div className="index mt-8">Credential holder</div><div className="mt-1 text-fg-strong"><Hash value={data.subject} head={8} tail={6} /></div></div>
        <div className="mt-5"><span className="index">Completed checks</span><div className="mt-2 flex flex-wrap gap-1.5">{methods.length ? methods.map(method => <Tag key={method.key} tone="mint">{method.label}</Tag>) : <span className="text-[13px] text-fg-muted">No checks recorded.</span>}</div></div>
        <details className="mt-5 border-t border-line pt-4"><summary className="index cursor-pointer text-fg-muted hover:text-fg-strong">Credential details</summary>
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line text-[13px]">
          {[
            ['Assurance', `Level ${data.mark.assurance}`], ['Environment', data.mark.regime === 2 ? 'Sandbox' : `Regime ${data.mark.regime}`],
            ['Jurisdiction', data.mark.jurisdiction === 410 ? 'South Korea' : String(data.mark.jurisdiction)], ['Origin', data.mark.origin === 2 ? 'Roster' : data.mark.origin === 1 ? 'Direct' : 'None'],
          ].map(([label, value]) => <div key={label} className="bg-surface-2 p-3"><dt className="index">{label}</dt><dd className="mt-1.5 font-medium text-fg-strong">{value}</dd></div>)}
        </dl>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><Tag tone="gray" mono>{data.mark.methodsHex}</Tag><a href={cc3Block(data.blockNumber)} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1.5 text-xs">View on explorer<Icon name="external" size={12} /></a></div>
        </details>
      </div>
    </article>
  );
}

function PolicyCard({ policy }: { policy: Policy }) {
  const result = policyVerdict(policy); const reason = firstReason(policy);
  const missing = missingBits(policy.decisionMark?.methods ?? 0, policy.requireAll);
  const reasonDetails = policy.reasonCodes.slice(1).map(code => REASON[code]?.human ?? code.replaceAll('_', ' ').toLowerCase());
  return (
    <article className="panel flex flex-col overflow-hidden" data-demo-policy={policy.id} data-demo-verdict={result.label}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-4">
        <h3 className="display min-w-0 text-[17px] leading-6">{policy.name === 'KR VASP production' ? 'Korea · production' : policy.name === 'KR sandbox pilot' ? 'Korea · sandbox' : policy.name}</h3>
        <Tag tone={result.tone} size="lg">{result.reliable ? policy.verified ? 'Eligible' : 'Not eligible' : 'Needs review'}</Tag>
      </div>
      <div className="flex flex-1 flex-col p-6">
        <p className={`text-[13px] leading-5 ${result.reliable && !policy.verified ? 'text-bad' : 'text-fg'}`}>{reason.human}</p>
        {missing.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{missing.map(method => <Tag key={method.key} tone="bad">Missing · {method.label}</Tag>)}</div>}
        {!policy.verified && <p className="mt-3 text-[13px] leading-5 text-fg-muted">{reason.action}</p>}
        <details className="mt-auto pt-5"><summary className="index cursor-pointer text-fg-muted hover:text-fg-strong">Requirements</summary>
        {reasonDetails.length > 0 && <p className="mt-3 text-xs leading-5 text-fg-muted">{reasonDetails.join(' ')}</p>}
        <p className="mt-3 text-xs leading-5 text-fg-muted">Policy #{policy.id} · {policy.frozen ? 'Fixed requirements' : 'Requirements may change'} · {policy.requireRoster ? 'Current roster required' : 'Direct credential'}</p>
        <p className="mt-2 text-xs leading-5 text-fg-muted">Minimum assurance: {policy.minAssurance} · Regime: {policy.requiredRegime || 'Any'} · Maximum age: {policy.maxAge ? `${Math.round(policy.maxAge / 86400)} days` : 'No limit'}</p>
        </details>
      </div>
    </article>
  );
}

function EvidenceTimeline({ data }: { data: ChainState }) {
  const assetPolicy = data.policies.find(policy => policy.verified) ?? data.policies[0]; const assetVerdict = policyVerdict(assetPolicy);
  const entries = [
    { icon: 'cube' as const, title: 'Source contract', label: 'Configured', tone: 'gray' as Tone, copy: `${data.asc.sourceContract.slice(0, 8)}… · Chain ${data.asc.expectedChainKey}. The originating transaction is not included in this view.` },
    { icon: 'layers' as const, title: 'Network record', label: 'Retrieved', tone: 'gray' as Tone, copy: `Creditcoin Testnet block ${data.blockNumber.toLocaleString()}. The block hash was checked after retrieval; the block is not finalized.` },
    { icon: 'policy' as const, title: 'Application requirements', label: assetVerdict.reliable ? assetPolicy.verified ? 'Met' : 'Not met' : 'Unconfirmed', tone: assetVerdict.tone, copy: `${assetPolicy.name} returned ${String(assetPolicy.verified)} at the same block. No application transaction was submitted.` },
  ];
  return (
    <div className="panel overflow-hidden"><ol className="grid lg:grid-cols-3">{entries.map((entry, index) => (
      <li key={entry.title} className="relative border-b border-divider p-4 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
        <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-[13px] font-semibold text-fg-strong"><Icon name={entry.icon} size={16} className="text-fg-subtle" />{entry.title}</span><Tag tone={entry.tone} size="sm">{entry.label}</Tag></div>
        <p className="mt-3 text-[13px] leading-5 text-fg-muted">{entry.copy}</p><span className="mono absolute bottom-2 right-3 text-fg-subtle">0{index + 1}</span>
      </li>
    ))}</ol></div>
  );
}

function Freshness({ data }: { data: ChainState }) {
  const restricted = data.tombstone || data.mark.status === 2;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-fg-strong">Restrictions</h3><Tag tone={restricted ? 'bad' : 'gray'}>{restricted ? 'Restricted' : 'None recorded'}</Tag></div><p className="mt-3 text-xs leading-5 text-fg-muted">{restricted ? 'A restriction is recorded for this credential holder.' : 'No restriction is recorded at the retrieved block.'}</p></div>
      <div className="panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-fg-strong">Roster validity</h3><Tag tone={data.epoch.fresh ? 'ok' : 'bad'}>{data.epoch.fresh ? 'Current' : 'Expired or unavailable'}</Tag></div><p className="mt-3 text-xs leading-5 text-fg-muted">Version {data.epoch.latestEpoch} · Valid until {timestamp(data.epoch.validUntil)}.</p></div>
    </div>
  );
}

export function DemoJourney() {
  const [scenario, setScenario] = useState<TrainingScenario>('full-match');
  const [training, setTraining] = useState<SanctionsTrainingResult | null>(null); const [chain, setChain] = useState<ChainState | null>(null);
  const [started, setStarted] = useState(false); const [trainingError, setTrainingError] = useState<string | null>(null); const [chainError, setChainError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { const active = pending.current; pending.current = null; active?.abort(); }, []);

  async function run(nextScenario: TrainingScenario = scenario, includeChain = true) {
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    setScenario(nextScenario); setStarted(true); setBusy(true); setTraining(null); setTrainingError(null);
    if (includeChain) { setChain(null); setChainError(null); }
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    try {
      const screening = fetch('/api/demo/screen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: nextScenario }), cache: 'no-store', signal: controller.signal }).then(async response => {
        const body: unknown = await response.json(); if (!response.ok || !isTrainingResult(body, nextScenario)) throw new Error('The sample could not be checked. Please try again.'); return body;
      });
      const chainRead = includeChain ? fetch('/api/onchain', { cache: 'no-store', signal: controller.signal }).then(async response => {
        const body: unknown = await response.json(); if (!response.ok || !isChainState(body)) throw new Error('The credential could not be retrieved. Please try again.'); return body;
      }) : Promise.resolve(chain);
      const [screeningResult, chainResult] = await Promise.allSettled([screening, chainRead]);
      if (controller.signal.aborted) {
        if (timedOut && pending.current === controller) {
          if (screeningResult.status === 'fulfilled') setTraining(screeningResult.value);
          else { setTraining(null); setTrainingError('The sample request timed out. Please try again.'); }
          if (includeChain) {
            if (chainResult.status === 'fulfilled' && chainResult.value) setChain(chainResult.value);
            else { setChain(null); setChainError('The network is taking too long to respond. Please try again.'); }
          }
        }
        return;
      }
      if (screeningResult.status === 'fulfilled') setTraining(screeningResult.value); else { setTraining(null); setTrainingError(screeningResult.reason instanceof Error ? screeningResult.reason.message : 'The sample is unavailable.'); }
      if (chainResult.status === 'fulfilled' && chainResult.value) setChain(chainResult.value); else if (includeChain) { setChain(null); setChainError(chainResult.status === 'rejected' && chainResult.reason instanceof Error ? chainResult.reason.message : 'The credential is unavailable.'); }
    } finally { clearTimeout(timeout); if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }

  return (
    <>
      <PageHeader eyebrow="Interactive demo" title="Explore Proofmark" lede="See how identity checks become application access." aside={<Tag tone="mint">Sample data</Tag>} />
      <p className="mb-5 flex items-start gap-2 text-xs leading-5 text-fg-muted"><Icon name="info" size={15} className="mt-0.5 shrink-0" />Demo uses sample identities and a separate testnet credential. It does not verify your identity or grant access.</p>
      {!started && (
        <section className="panel overflow-hidden" aria-labelledby="demo-start-title">
          <div className="grid md:grid-cols-[1.05fr_1fr]">
            <div className="relative flex flex-col justify-between overflow-hidden border-b border-line bg-canvas-2 p-8 sm:p-10 md:border-b-0 md:border-r"><div className="eyebrow">Walkthrough</div><div className="mt-12"><h2 id="demo-start-title" className="display max-w-sm text-[36px] leading-[1.05] sm:text-[40px]">One credential.<br /><span className="glow">Clear decisions.</span></h2><p className="mt-4 max-w-xs text-sm leading-6 text-fg-muted">Try a screening. Explore a credential. Compare access requirements.</p></div></div>
            <div className="flex flex-col justify-center p-8 sm:p-10"><ol className="space-y-7">{[
              ['1', 'Try a sample identity', 'Compare a full match, a similar name, and a different birth date.'],
              ['2', 'Explore a credential', 'See which verification checks have been completed.'],
              ['3', 'Compare application access', 'Understand why the same credential can produce different results.'],
            ].map(([number, title, copy]) => <li key={number} className="flex gap-4"><span className="index mt-0.5 w-7 shrink-0 text-mint">0{number}</span><div><h3 className="text-sm font-semibold text-fg-strong">{title}</h3><p className="mt-1 text-[13px] leading-5 text-fg-muted">{copy}</p></div></li>)}</ol><Button onClick={() => run()} disabled={busy} className="mt-8 w-full">Start demo<Icon name="arrow" size={16} /></Button><p className="mt-3 text-center text-xs text-fg-muted">No wallet connection needed</p></div>
          </div>
        </section>
      )}
      <div aria-live="polite" aria-busy={busy}>
      {started && busy && !training && !chain && <><p className="sr-only">Loading the demo.</p><Skeleton /></>}
      {started && (trainingError || chainError) && <div className="mt-4 grid gap-3">{trainingError && <Band tone="warn">{trainingError}</Band>}{chainError && <Band tone="bad">{chainError}</Band>}{!busy && <Button variant="secondary" className="w-fit" onClick={() => run()}><Icon name="arrow" size={15} />Try again</Button>}</div>}
      {(training || chain) && <div className="mt-4 grid gap-4 lg:grid-cols-2">{training && <TrainingCard result={training} scenario={scenario} busy={busy} onScenario={next => run(next, false)} />}{chain && <CredentialCard data={chain} />}</div>}
      </div>
      {chain && (
        <>
          <Section index="03" title="Application access" lede="Each application sets its own verification requirements."><div className="grid gap-4 lg:grid-cols-2">{chain.policies.map(policy => <PolicyCard key={policy.id} policy={policy} />)}</div></Section>
          <details className="panel mt-5 overflow-hidden"><summary className="index cursor-pointer px-6 py-4 text-fg-muted hover:text-fg-strong">Network details</summary><div className="space-y-4 border-t border-line p-5"><EvidenceTimeline data={chain} /><Freshness data={chain} /><p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">Block reference <Hash value={chain.observation.blockHash} head={8} tail={6} /></p></div></details>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
            <Button variant="ghost" onClick={() => run(scenario)} disabled={busy}><Icon name="block" size={15} />Refresh results</Button>
            <div className="flex flex-wrap gap-2"><LinkButton href="/onchain">View credentials<Icon name="arrow" size={15} /></LinkButton>{/* Full navigation: provider CSP/camera permissions are document scoped. */}<LinkButton href="/verify/provider" variant="primary">Verify your identity<Icon name="arrow" size={15} /></LinkButton></div>
          </div>
        </>
      )}
    </>
  );
}
