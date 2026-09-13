'use client';

import { useEffect, useState } from 'react';
import { Button, LinkButton } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Status } from '@/components/ui/Status';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader, Section } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';

type Decision = 'ALLOW' | 'BLOCK' | 'REVIEW';
type MethodGroup = { group: string; note: string; items: { key: string; label: string; set: boolean }[] };
type Hit = {
  listId: string; entryId: string; matchedName: string; score: number;
  matchType: string; corroborated: boolean; corroboration?: string[];
  identityComparison?: { dob: string; nationality: string };
};
type Meta = {
  engineVersion: string; listVersions: Record<string, number>; listCounts: Record<string, number>;
  builtAt?: string; sourceUpdatedAt?: Record<string, string>;
};
type Result = Meta & {
  decision: Decision;
  reviewReason: string | null;
  riskBand: number;
  hits: Hit[];
  methodsHex: string;
  methodGroups: MethodGroup[];
  evidenceDigest: string;
  elapsedMs: number;
};

const LIST: Record<string, { label: string; source: string }> = {
  OFAC_SDN: { label: 'OFAC SDN', source: 'US Treasury' },
  UN_CONSOLIDATED: { label: 'UN Consolidated', source: 'UN Security Council' },
  EU_FSF: { label: 'EU FSF', source: 'European Commission' },
};

const PRESETS = [
  { label: 'Name and birth date', hint: 'Kim Jong Un · KP',
    v: { fullName: 'Kim Jong Un', dateOfBirth: '1984-01-08', nationality: 'KP', residence: 'KP', walletAddress: '' } },
  { label: 'Similar name', hint: 'Choi Yeong-ho · KR',
    v: { fullName: 'Choi Yeong-ho', dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '' } },
  { label: 'Listed wallet', hint: 'Check a wallet against OFAC',
    v: { fullName: 'Totally Unrelated Person', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US',
         walletAddress: '0x252a8bd2319d8a555b872990601221b3a2053bce' } },
  { label: 'Name search', hint: 'Park Seo-jun · KR',
    v: { fullName: 'Park Seo-jun', dateOfBirth: '1990-05-05', nationality: 'KR', residence: 'KR', walletAddress: '' } },
];

const DECISION: Record<Decision, { tone: Tone; edge: string; label: string; text: string }> = {
  ALLOW: { tone: 'ok', edge: 'border-l-ok', label: 'No blocking conditions', text: 'This search passed the screening policy. Identity verification is a separate step.' },
  REVIEW: { tone: 'warn', edge: 'border-l-warn', label: 'Review required', text: 'Review the identity details and any potential matches before proceeding.' },
  BLOCK: { tone: 'bad', edge: 'border-l-bad', label: 'Screening blocked', text: 'A listed wallet or a supported identity match meets the blocking criteria.' },
};

const FIELDS = [
  ['fullName', 'Full name', 'Required'], ['dateOfBirth', 'Date of birth', 'Optional'],
  ['nationality', 'Nationality', 'Optional'], ['residence', 'Residence', 'Optional'],
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const countMap = (value: unknown): value is Record<string, number> => isRecord(value)
  && Object.keys(value).length > 0 && Object.values(value).every(count => Number.isSafeInteger(count) && Number(count) >= 0);

function isMeta(value: unknown): value is Meta {
  return isRecord(value) && typeof value.engineVersion === 'string' && countMap(value.listVersions) && countMap(value.listCounts)
    && (value.builtAt === undefined || typeof value.builtAt === 'string')
    && (value.sourceUpdatedAt === undefined || isRecord(value.sourceUpdatedAt) && Object.values(value.sourceUpdatedAt).every(date => typeof date === 'string'));
}

function isResult(value: unknown): value is Result {
  if (!isRecord(value)) return false;
  const raw: Record<string, unknown> = value;
  if (!isMeta(value)) return false;
  return ['ALLOW', 'REVIEW', 'BLOCK'].includes(String(raw.decision))
    && (raw.reviewReason === null || typeof raw.reviewReason === 'string')
    && Number.isInteger(raw.riskBand) && Number(raw.riskBand) >= 0 && Number(raw.riskBand) <= 5
    && typeof raw.methodsHex === 'string' && /^0x[0-9a-f]+$/i.test(raw.methodsHex)
    && typeof raw.evidenceDigest === 'string' && /^0x[0-9a-f]{64}$/i.test(raw.evidenceDigest)
    && typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0
    && Array.isArray(raw.hits) && raw.hits.length <= 8 && raw.hits.every(hit => isRecord(hit)
      && ['listId', 'entryId', 'matchedName', 'matchType'].every(key => typeof hit[key] === 'string')
      && typeof hit.score === 'number' && Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1
      && typeof hit.corroborated === 'boolean'
      && (hit.identityComparison === undefined || isRecord(hit.identityComparison)
        && typeof hit.identityComparison.dob === 'string' && typeof hit.identityComparison.nationality === 'string'))
    && Array.isArray(raw.methodGroups) && raw.methodGroups.every(group => isRecord(group)
      && typeof group.group === 'string' && typeof group.note === 'string' && Array.isArray(group.items)
      && group.items.every(item => isRecord(item) && typeof item.key === 'string' && typeof item.label === 'string' && typeof item.set === 'boolean'));
}

export default function Screening() {
  const [form, setForm] = useState({ fullName: '', dateOfBirth: '', nationality: '', residence: '', walletAddress: '' });
  const [meta, setMeta] = useState<Meta | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/screen', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (!controller.signal.aborted && isMeta(value)) setMeta(value);
      }).catch(() => {});
    return () => controller.abort();
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: k === 'nationality' || k === 'residence' ? e.target.value.toUpperCase() : e.target.value });

  async function screen(payload = form) {
    if (!payload.fullName.trim()) { setErr('Enter a full name to start screening.'); return; }
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await fetch('/api/screen', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        cache: 'no-store', signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        setErr(r.status === 429 ? 'Too many screening requests. Please wait a moment and try again.' : r.status === 400 ? 'Check the identity details and try again.' : 'Screening is temporarily unavailable. Please try again.');
        return;
      }
      const j: unknown = await r.json();
      if (!isResult(j)) throw new Error('Invalid screening response');
      setRes(j);
    } catch { setErr('Screening could not be completed. Please try again.'); } finally { setBusy(false); }
  }

  const info = res ?? meta;
  const totalEntries = info ? Object.values(info.listCounts).reduce((a, b) => a + b, 0) : null;

  return (
    <>
      <PageHeader
        eyebrow="Sanctions lists"
        title="Sanctions screening"
        lede="Check a person against global sanctions lists."
        aside={<LinkButton href="/verify">Verify identity<Icon name="arrow" size={15} /></LinkButton>}
      />

      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2">
        {Object.entries(LIST).map(([key, list]) => <span key={key} className="index inline-flex items-center gap-2.5 text-fg-muted"><span className="dot" />{list.label}</span>)}
        {totalEntries ? <span className="mono text-fg-muted sm:ml-auto">{totalEntries.toLocaleString()} records</span> : null}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div>
          <form className="panel p-5 sm:p-6" onSubmit={event => { event.preventDefault(); if (!busy) void screen(); }}>
            <h2 className="display mb-5 text-[19px] leading-7">New screening</h2>
            <div className="grid grid-cols-2 gap-x-3 gap-y-4">
              {FIELDS.map(([k, label, hint]) => (
                <div key={k} className={k === 'fullName' || k === 'dateOfBirth' ? 'col-span-2' : ''}>
                  <Field label={label} hint={hint || undefined}>
                    <Input value={form[k]} onChange={set(k)} disabled={busy} required={k === 'fullName'} spellCheck={false} type={k === 'dateOfBirth' ? 'date' : 'text'} placeholder={k === 'fullName' ? 'Enter full legal name' : k === 'nationality' || k === 'residence' ? 'e.g. KR' : undefined} list={k === 'nationality' || k === 'residence' ? 'screening-countries' : undefined} maxLength={k === 'nationality' || k === 'residence' ? 2 : undefined} />
                  </Field>
                </div>
              ))}
              <div className="col-span-2"><Field label="Wallet address" hint="Optional">
                <Input value={form.walletAddress} onChange={set('walletAddress')} disabled={busy} spellCheck={false} placeholder="0x…" className="mono" />
              </Field></div>
            </div>
            <datalist id="screening-countries">{[['KR', 'South Korea'], ['US', 'United States'], ['GB', 'United Kingdom'], ['JP', 'Japan'], ['SG', 'Singapore'], ['DE', 'Germany'], ['FR', 'France'], ['CA', 'Canada'], ['AU', 'Australia'], ['CN', 'China'], ['IN', 'India'], ['AE', 'United Arab Emirates']].map(([code, country]) => <option key={code} value={code}>{country}</option>)}</datalist>
            <Button type="submit" disabled={busy || !form.fullName.trim()} className="mt-6 w-full">
              <Icon name="search" size={16} />{busy ? 'Checking sanctions lists…' : 'Run screening'}
            </Button>
            {err && <div role="alert"><Band tone="bad" className="mt-3">{err}</Band></div>}
          </form>

          <details className="panel mt-4 overflow-hidden">
            <summary className="index cursor-pointer px-5 py-4 text-fg-muted hover:text-fg-strong">Use an example</summary>
            {PRESETS.map(p => (
              <button key={p.label} type="button" onClick={() => { setForm(p.v); screen(p.v); }} disabled={busy}
                className="group flex w-full items-start gap-3 border-t border-divider px-5 py-3 text-left transition-colors hover:bg-surface-2 disabled:opacity-60">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium leading-5 text-fg-strong">{p.label}</div>
                  <div className="mt-0.5 text-xs leading-4 text-fg-muted">{p.hint}</div>
                </div>
                <Icon name="arrow" size={14} className="mt-[3px] shrink-0 text-fg-subtle transition-colors group-hover:text-mint" />
              </button>
            ))}
          </details>
        </div>

        <div className="min-w-0" aria-live="polite" aria-busy={busy}>
          {!res && (
            <div className="panel flex min-h-[460px] flex-col items-center justify-center px-6 text-center">
              <div className={`flex size-14 items-center justify-center rounded-md border border-mint/25 bg-mint-tint text-mint ${busy ? 'animate-pulse' : ''}`}><Icon name="search" size={24} /></div>
              <div className="display mt-5 text-[20px] leading-7">{busy ? 'Checking for matches' : 'Your results will appear here'}</div>
              <p className="mt-1 max-w-xs text-[13px] leading-5 text-fg-muted">
                {busy ? 'Searching the selected sanctions lists.' : 'Enter a full name to begin. Add a birth date or wallet address for a more precise search.'}
              </p>
            </div>
          )}

          {res && (
            <>
              <div data-screening-decision={res.decision} className={`panel border-l-[3px] p-6 ${DECISION[res.decision].edge}`}>
                <div className="flex items-center justify-between gap-3"><Status tone={DECISION[res.decision].tone} className="display text-[22px] leading-7">{DECISION[res.decision].label}</Status><span className="mono text-fg-muted">{res.elapsedMs} ms</span></div>
                <p className="mt-2 text-sm leading-6 text-fg-muted">{DECISION[res.decision].text}</p>
              </div>

              <Section title="Potential matches" aside={<Tag tone="gray">{res.hits.length}</Tag>}>
                {res.hits.length === 0 ? (
                  <div className="panel flex items-center gap-3 px-5 py-6 text-sm text-fg-muted"><Icon name="shield" size={18} className="text-ok" />No matches found for this search.</div>
                ) : (
                  <div className="panel overflow-x-auto">
                    <table className="tbl">
                      <thead><tr><th>Matched name</th><th>Type</th><th className="num">Similarity</th><th>Source</th><th>Identity match</th></tr></thead>
                      <tbody>
                        {res.hits.map((h, i) => (
                          <tr key={i}>
                            <td className="font-medium text-fg-strong">{h.matchedName}</td>
                            <td><Tag tone={h.corroborated ? 'warn' : 'gray'}>{h.matchType}</Tag></td>
                            <td className="num">{h.score}</td>
                            <td className="text-fg-muted">{LIST[h.listId]?.label ?? h.listId}</td>
                            <td>
                              {h.matchType === 'wallet' ? <Tag tone="bad">listed wallet</Tag> : h.identityComparison ? (
                                <span className="inline-flex flex-wrap gap-1">
                                  {Object.entries(h.identityComparison).map(([field, value]) => (
                                    <Tag key={field} tone={value === 'conflict' || value === 'invalid' ? 'warn' : value === 'match' ? 'ok' : 'gray'}>{field}: {value}</Tag>
                                  ))}
                                </span>
                              ) : <span className="text-fg-muted">comparison details unavailable</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              <details className="panel mt-5 overflow-hidden">
                <summary className="index cursor-pointer px-5 py-4 text-fg-muted hover:text-fg-strong">Screening details</summary>
                <div className="border-t border-line p-5">
                <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-fg-muted"><span className="index text-fg-muted">Risk level {res.riskBand}/5</span>{res.reviewReason && <Tag tone="gray">{res.reviewReason.replaceAll('_', ' ').toLowerCase()}</Tag>}<Tag tone="gray" mono>{res.methodsHex}</Tag></div>
                <div className="mb-5 overflow-x-auto"><table className="tbl"><thead><tr><th>Check</th><th className="w-32">Status</th></tr></thead><tbody>{res.methodGroups.map(g => <Group key={g.group} group={g} />)}</tbody></table></div>
                <DetailList>
                  <DetailRow label="Reference"><Hash value={res.evidenceDigest} full /></DetailRow>
                  <DetailRow label="Lists">
                    <span className="mono text-fg-muted">
                      {Object.entries(res.listVersions).map(([k, v]) => `${LIST[k]?.label ?? k} rev ${v}`).join(' · ')}
                    </span>
                  </DetailRow>
                  {res.sourceUpdatedAt && <DetailRow label="Source refresh"><span className="mono text-fg-muted">{Object.values(res.sourceUpdatedAt).sort()[0]}</span></DetailRow>}
                </DetailList>
                </div>
              </details>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Group({ group: g }: { group: MethodGroup }) {
  const run = g.items.filter(m => m.set);
  const idle = g.items.filter(m => !m.set);
  return (
    <>
      <tr className="grp">
        <td colSpan={2}>{g.group}<span className="note">{g.note}</span></td>
      </tr>
      {run.map(m => (
        <tr key={m.key}>
          <td className="font-medium text-fg-strong">{m.label}</td>
          <td><Tag tone="ok">Performed</Tag></td>
        </tr>
      ))}
      {idle.length > 0 && (
        <tr>
          <td className="text-fg-muted">{idle.map(m => m.label).join(' · ')}</td>
          <td><Tag tone="gray">Not run</Tag></td>
        </tr>
      )}
    </>
  );
}
