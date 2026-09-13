import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Status } from '@/components/ui/Status';
import { Stats, Stat } from '@/components/ui/Stat';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader, Section, Eyebrow } from '@/components/ui/Page';
import { Icon, CreditcoinMark, type IconName } from '@/components/ui/Icon';
import { Mark, Wordmark } from '@/components/ui/Logo';

export const metadata: Metadata = { title: 'Design system', robots: { index: false, follow: false } };

/* Internal reference. Not linked from the app and not served in production. Tokens mirror app/globals.css by hand. */
const COLORS: { group: string; tokens: { name: string; cls: string; value: string; note?: string }[] }[] = [
  { group: 'Canvas & surfaces', tokens: [
    { name: 'canvas', cls: 'bg-canvas', value: '#05060A', note: 'page (Stabled base)' },
    { name: 'canvas-2', cls: 'bg-canvas-2', value: '#0B0E14', note: 'footer, step bands, icon wells' },
    { name: 'surface', cls: 'bg-surface', value: '#11141C', note: 'panels' },
    { name: 'surface-2', cls: 'bg-surface-2', value: '#161A24', note: 'table head, chips, hover' },
    { name: 'sunk', cls: 'bg-sunk', value: '#080A0F', note: 'inputs' },
    { name: 'line', cls: 'bg-line', value: '#1E2430', note: 'panel borders, hairlines' },
    { name: 'line-strong', cls: 'bg-line-strong', value: '#2B3242', note: 'inputs, secondary button, gray tag' },
    { name: 'divider', cls: 'bg-divider', value: '#181C26', note: 'rows' },
  ]},
  { group: 'Text', tokens: [
    { name: 'fg-strong', cls: 'bg-fg-strong', value: '#E6E9F0', note: 'headings, values (ink)' },
    { name: 'fg', cls: 'bg-fg', value: '#C3C9D6', note: 'body' },
    { name: 'fg-muted', cls: 'bg-fg-muted', value: '#8A93A6', note: 'labels, ledes (ink-dim)' },
    { name: 'fg-subtle', cls: 'bg-fg-subtle', value: '#565F73', note: 'indices, placeholders (ink-faint)' },
  ]},
  { group: 'Accent', tokens: [
    { name: 'mint', cls: 'bg-mint', value: '#00E5C7', note: 'primary button, eyebrow, active nav, focus, glow' },
    { name: 'mint-tint', cls: 'bg-mint-tint', value: 'mint 10%', note: 'claim tags, selected rows' },
    { name: 'mint-line', cls: 'bg-mint-line', value: 'mint 28%', note: 'hr-decay, panel top edge' },
  ]},
  { group: 'Status', tokens: [
    { name: 'ok', cls: 'bg-ok', value: '= mint', note: 'positive shares the accent' },
    { name: 'ok-tint', cls: 'bg-ok-tint', value: 'mint 10%' },
    { name: 'warn', cls: 'bg-warn', value: '#F5B942' },
    { name: 'warn-tint', cls: 'bg-warn-tint', value: 'warn 12%' },
    { name: 'bad', cls: 'bg-bad', value: '#FF5C6A' },
    { name: 'bad-tint', cls: 'bg-bad-tint', value: 'bad 12%' },
  ]},
];

const TYPE = [
  { name: 'Hero', spec: 'Space Grotesk 78 / 1.02 · 700 · −4%', cls: 'display text-[44px] leading-none', sample: 'Verify once.' },
  { name: 'Page title', spec: 'Space Grotesk 36 / 40 · 700 · −3%', cls: 'display text-[36px] leading-10', sample: 'Wallet lookup' },
  { name: 'Section', spec: 'Space Grotesk 19 / 28 · 700 · −3%', cls: 'display text-[19px] leading-7', sample: 'Service requirements' },
  { name: 'Card title', spec: 'Space Grotesk 17 / 24 · 700 · −3%', cls: 'display text-[17px] leading-6', sample: 'Korea · production' },
  { name: 'Stat value', spec: 'Inter 18 / 24 · 600 · tnum', cls: 'text-lg font-semibold leading-6 text-fg-strong tabular-nums', sample: '26,566' },
  { name: 'Body', spec: 'Inter 14 / 20 · 400', cls: 'text-sm text-fg', sample: 'The mark carries the checks that were performed; each consumer decides whether that meets its own regime.' },
  { name: 'Row', spec: 'Inter 13 / 20 · 400–500', cls: 'text-[13px] font-medium text-fg-strong', sample: 'Sanctions screened · Document authenticity' },
  { name: 'Label', spec: 'Inter 12 / 16 · 500 · muted', cls: 'text-xs font-medium text-fg-muted', sample: 'Entries loaded · Policies passed' },
  { name: 'Eyebrow', spec: 'JetBrains Mono 11 / 16 · caps · +18% · mint · // prefix', cls: 'eyebrow', sample: 'Identity for digital assets' },
  { name: 'Index', spec: 'JetBrains Mono 11 / 16 · caps · +10% · subtle', cls: 'index', sample: '01 · Wallet address · Sample wallets' },
  { name: 'Button', spec: 'JetBrains Mono 12 · 500 · caps · +10% · pill', cls: 'btn btn-sm btn-secondary', sample: 'Run screening' },
  { name: 'Mono', spec: 'JetBrains Mono 12 · tnum', cls: 'mono text-fg-strong', sample: '0x3C6Fe016645CA52952E29C66E435bDa7F611b242' },
];

const ICONS: IconName[] = ['shield', 'cube', 'database', 'bolt', 'clock', 'globe', 'gauge', 'layers', 'block', 'policy', 'wallet', 'key', 'hash', 'user', 'list', 'search', 'copy', 'check', 'x', 'info', 'warning', 'external', 'arrow', 'chevron', 'menu'];
const TONES: Tone[] = ['ok', 'warn', 'bad', 'mint', 'gray'];

const RULES = [
  ['One container', 'Every box is a .panel: surface fill, 1px line, 8px radius. No stacked translucent fills, no shadows. Pills are the only round shape.'],
  ['One accent', 'Stabled mint (#00E5C7) is the only chromatic accent: primary button, eyebrow, active nav, focus, the hero glow. Positive status shares it; warn and bad are the only other hues.'],
  ['Three voices', 'Space Grotesk for titles and big numbers, Inter for reading, JetBrains Mono for eyebrows (// prefix), indices, labels, buttons and anything the chain could hold.'],
  ['Say it once', 'A number appears in one place or not at all. No stat strip that repeats the content below it; no engine versions or elapsed-ms in the chrome.'],
  ['Fixed columns', 'Detail labels are 176px. Bit numbers are a 64px right-aligned mono column. Verdict tags in policy rows are 72px. Nothing is ragged.'],
  ['Line boxes', 'Rows are 40px, table heads 36px, inputs and buttons 40px (small 32px), tags 24px on a 24px line. Labels and values share a baseline.'],
  ['Same-shaped rows are a table', 'Two things being compared sit side by side in equal-height cards; a footer sticks to the bottom of both.'],
  ['Hashes are mono and copyable', 'Every address and digest renders through <Hash>: truncated by default, full where it matters, underlined only when it links out.'],
  ['Silence over guesses', 'An unset bit is "Not run", in muted text. The UI never implies a check that did not happen.'],
];

function Swatch({ t }: { t: (typeof COLORS)[number]['tokens'][number] }) {
  return (
    <div className="panel flex items-center gap-3 p-2">
      <div className={`h-9 w-9 shrink-0 rounded-sm border border-line ${t.cls}`} />
      <div className="min-w-0 text-xs leading-4">
        <div className="mono text-fg-strong">{t.name}</div>
        <div className="text-fg-muted">{t.value}</div>
        {t.note && <div className="truncate text-fg-subtle">{t.note}</div>}
      </div>
    </div>
  );
}

export default function Design() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <PageHeader
        eyebrow="Internal · not linked, dev only"
        title="Design system"
        lede="Near-black canvas, hairline structure, one mint accent, three typefaces. Every primitive in the app, rendered once, so alignment can be checked against a ruler."
        aside={<span className="mono text-fg-muted">tokens · app/globals.css</span>}
      />

      <Section title="Brand" lede="Proofmark, in the Stabled identity: one name, one mark, one accent.">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="panel flex items-center justify-center gap-2.5 p-6 text-fg-strong"><Mark size={28} className="text-mint" /><Wordmark size={24} /></div>
          <div className="panel flex items-center justify-center gap-2.5 p-6 text-fg-strong"><Mark size={28} /><Wordmark size={24} /></div>
          <div className="panel flex items-center justify-center gap-2 p-6 text-xs text-fg"><CreditcoinMark size={13} />Built on Creditcoin</div>
        </div>
        <DetailList className="mt-3">
          <DetailRow label="Mark">A seal ring left open until the check closes it — a mark exists only once verified. Mint in the chrome, text colour elsewhere; never below 20px.</DetailRow>
          <DetailRow label="Accent">
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="inline-block h-4 w-4 rounded-sm bg-mint align-middle" />
              <span className="mono">#00E5C7</span>
              <span className="text-fg">is Stabled mint. Proofmark carries the parent brand&rsquo;s accent; nothing else in the UI is chromatic.</span>
            </span>
          </DetailRow>
          <DetailRow label="Type">Space Grotesk for display, Inter for reading, JetBrains Mono for eyebrows, indices, buttons and values the chain could hold.</DetailRow>
          <DetailRow label="Voice">Short declaratives. One sentence per lede. Never claim a check that did not run — in copy as in bits.</DetailRow>
          <DetailRow label="Name">&ldquo;Proofmark&rdquo;, nothing else. No secondary or localised product name, ever.</DetailRow>
        </DetailList>
      </Section>

      <Section title="Rules">
        <div className="grid gap-3 md:grid-cols-2">
          {RULES.map(([h, p], i) => (
            <div key={h} className="panel grid grid-cols-[28px_minmax(0,1fr)] gap-2 p-4">
              <span className="mono pt-0.5 text-fg-subtle">{String(i + 1).padStart(2, '0')}</span>
              <div><div className="text-[13px] font-medium leading-5 text-fg-strong">{h}</div><p className="mt-1 text-[13px] leading-5 text-fg-muted">{p}</p></div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Colour" lede="Every colour is a semantic token; components never reference raw hex.">
        <div className="grid gap-6">
          {COLORS.map(g => (
            <div key={g.group}>
              <Eyebrow className="mb-2">{g.group}</Eyebrow>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{g.tokens.map(t => <Swatch key={t.name} t={t} />)}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography" lede="Three faces with fixed jobs. Tabular numerals everywhere.">
        <div className="panel overflow-x-auto">
          <table className="tbl">
            <thead><tr><th className="w-32">Style</th><th className="w-60">Spec</th><th>Sample</th></tr></thead>
            <tbody>
              {TYPE.map(t => (
                <tr key={t.name}>
                  <td className="font-medium text-fg-strong">{t.name}</td>
                  <td className="mono text-fg-muted">{t.spec}</td>
                  <td><span className={t.cls}>{t.sample}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Buttons" lede="Pills, 40 / 32px, mono caps. One primary per view, in mint, glowing on hover. Secondary is a hairline outline; ghost is text.">
        <div className="panel flex flex-wrap items-center gap-3 p-4">
          <Button><Icon name="search" size={16} />Run screening</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost <Icon name="chevron" size={14} /></Button>
          <Button disabled>Screening…</Button>
          <Button size="sm">Small</Button>
          <Button size="sm" variant="secondary"><Icon name="copy" size={14} />Copy</Button>
        </div>
      </Section>

      <Section title="Tags & status" lede="Tag: 12/500 on a 24px box, tinted fill, hairline and text of the same hue. Status: dot + word, for values that must share a baseline with neighbours.">
        <div className="panel grid gap-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {TONES.map(t => <Tag key={t} tone={t}>{t === 'ok' ? 'ALLOW' : t === 'warn' ? 'REVIEW' : t === 'bad' ? 'BLOCK' : t === 'mint' ? 'Sanctions screened' : 'Not run'}</Tag>)}
            <Tag tone="gray" mono>0x19003f</Tag>
            <Tag tone="ok" size="lg">PASS</Tag>
            <Tag tone="bad" size="lg">FAIL</Tag>
            <Tag tone="gray" size="sm">sm</Tag>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-base">
            <Status tone="ok">ACTIVE</Status><Status tone="warn">REVIEW</Status><Status tone="bad">REVOKED</Status><Status tone="gray">NONE</Status>
          </div>
        </div>
      </Section>

      <Section title="Inputs" lede="40px, sunk fill, hairline border, mint ring on focus. Label is a mono index; hint right-aligned.">
        <div className="panel grid max-w-2xl gap-3.5 p-4 sm:grid-cols-2">
          <Field label="Full name"><Input defaultValue="Park Seo-jun" /></Field>
          <Field label="Date of birth" hint="YYYY-MM-DD"><Input placeholder="1990-05-05" /></Field>
          <Field label="Wallet address" hint="optional"><Input placeholder="0x…" className="mono" /></Field>
          <Field label="Disabled"><Input disabled value="—" readOnly /></Field>
        </div>
      </Section>

      <Section title="Stat strip" lede="One panel, hairline-split cells, 12px label over an 18px value on a fixed 24px line. A Status is a valid value.">
        <Stats>
          <Stat label="Latest block" value="4,211,073" />
          <Stat label={<>OFAC SDN <span className="text-fg-subtle">· US Treasury</span></>} value="19,321" sub={<span className="mono">rev 4147031705</span>} />
          <Stat label="Mark status" value={<Status tone="ok">ACTIVE</Status>} />
          <Stat label="Assurance" value="Level 1" sub="sandbox" />
        </Stats>
      </Section>

      <Section title="Bands" lede="Message strip. Neutral by default; a tone tints the fill and colours the icon.">
        <div className="grid gap-2">
          <Band tone="note">Two 32-byte commitments. No name, date of birth or document number.</Band>
          <Band tone="ok">No corroborated match. The mark may carry the sanctions bit.</Band>
          <Band tone="warn">A candidate matched, but nothing corroborates it.</Band>
          <Band tone="bad">A listed party was corroborated. No mark is issued.</Band>
        </div>
      </Section>

      <Section title="Table" lede="36px head, 40px rows, hairlines, inside a panel. Group rows are 32px eyebrows. Numbers right-aligned and tabular.">
        <div className="panel overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Check</th><th className="num w-24">Bit</th><th className="w-32">Status</th></tr></thead>
            <tbody>
              <tr className="grp"><td colSpan={3}>Run by this screening<span className="note">Performed here, on every request.</span></td></tr>
              <tr><td className="font-medium text-fg-strong">Sanctions lists</td><td className="num mono text-fg-muted">1 &lt;&lt; 16</td><td><Tag tone="ok">Performed</Tag></td></tr>
              <tr><td className="font-medium text-fg-strong">Jurisdiction (FATF)</td><td className="num mono text-fg-muted">1 &lt;&lt; 19</td><td><Tag tone="ok">Performed</Tag></td></tr>
              <tr className="grp"><td colSpan={3}>Not licensed yet<span className="note">The bit stays unset — silence, not a guess.</span></td></tr>
              <tr><td className="text-fg-muted">Politically exposed persons</td><td className="num mono text-fg-muted">1 &lt;&lt; 17</td><td><Tag tone="gray">Not run</Tag></td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Detail rows" lede="176px label column, 24px line boxes, hairlines. A hint is a dotted underline with a title, so the column stays flush.">
        <DetailList>
          <DetailRow label="Subject" hint="The wallet the mark is bound to"><Hash value="0xFD1222e35a536A62f180aA44826656940e86bD5E" href="#" full /></DetailRow>
          <DetailRow label="Status"><Tag tone="ok">ACTIVE</Tag></DetailRow>
          <DetailRow label="Methods"><span className="flex flex-wrap gap-1.5"><Tag tone="gray" mono>0x19003f</Tag><Tag tone="mint">Sanctions screened</Tag><Tag tone="mint">Jurisdiction check</Tag></span></DetailRow>
          <DetailRow label="Claims root"><Hash value="0xe0f8f6d4a5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7" full /></DetailRow>
          <DetailRow label="Truncated"><Hash value="0xe0f8f6d4a5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7" /></DetailRow>
        </DetailList>
      </Section>

      <Section title="Icons" lede="24-grid outline icons at 14 / 16 px, 1.75 stroke, round joins. Inherit currentColor.">
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-9">
          {ICONS.map(n => (
            <div key={n} className="panel flex flex-col items-center gap-1.5 py-3 text-fg-strong">
              <Icon name={n} size={18} /><span className="mono text-[11px] text-fg-muted">{n}</span>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
