# Proofmark design system

Dark only, in the Stabled brand. One canvas, one panel step, hairline structure, one cyan-mint accent, three typefaces.
Tokens: `app/globals.css`. Primitives: `components/ui/`. Internal catalogue with every primitive rendered: `/design`
(not linked from the app, returns 404 in production).

## Why it looks the way it does

Pass 1 was the generic dark/glassy look; pass 2 mirrored a light explorer; pass 3 was Creditcoin-native mint on black
with fixed columns; pass 4 was a light navy "financial workspace" that read as a template. This pass (2026-09-14) moves the
product onto the parent brand at stabled.ai — near-black `#05060A`, mint `#00E5C7`, Space Grotesk display, JetBrains Mono
eyebrows with a `//` prefix, mono section indices, pill buttons, a faint 56px grid with a node constellation behind the
hero — and keeps the structural discipline that made pass 3 read as designed: fixed columns, line boxes, hairlines.

## Rules

1. **One container.** Every box is `.panel`: `surface` fill, 1px `line`, 8px radius. No stacked translucent fills, no shadows. Pills are the only round shape.
2. **One accent.** Mint (`#00E5C7`) is the only chromatic accent: primary button, eyebrow, active nav marker, focus ring, link hover, the hero glow. Positive status shares it; `warn` and `bad` are the only other hues. Blue is not used.
3. **Three voices.** Space Grotesk (`.display`) for titles and big numbers. Inter for reading. JetBrains Mono for eyebrows (`.eyebrow`, `//` prefix), indices and labels (`.index`), buttons (`.btn`), table heads and anything the chain could hold (`.mono`).
4. **Fixed columns.** Detail labels are 176px. Bit numbers are a 64px right-aligned mono column. Verdict tags in policy rows are 72px. Stat cells are equal and split by hairlines.
5. **Line boxes.** Table rows 40px, table heads 36px, group rows 32px, inputs and buttons 40px (small 32px), tags 24px on a 24px line, page-header aside on the title line. Labels and values share a baseline.
6. **Same-shaped rows are a table.** Two things being compared sit side by side in equal-height cards with the footer pinned to the bottom of both.
7. **Hashes go through `<Hash>`**: mono, copyable, truncated by default, full where it matters, underlined only when they link out.
8. **Status is a tag in a table and a dot in a sentence.** `<Tag>` inside rows; `<Status>` (dot + word) where the value must sit on the baseline of its neighbours.
9. **Silence over guesses.** An unset bit is "Not run", in muted text. The UI never implies a check that did not happen.
10. **Backdrop stays behind.** The grid and constellation live in `<Backdrop>` at z-index 0, fade out before the first panel on the home page and inside the header band elsewhere, and never run through a headline. No other decoration.
11. **Case is CSS.** Eyebrows, indices, buttons and table heads are uppercased by class, never in the source, so tests and accessible names keep the written case. Body copy and tags stay sentence case.

## Tokens

canvas `#05060A` · canvas-2 `#0B0E14` · surface `#11141C` · surface-2 `#161A24` · sunk `#080A0F`
line `#1E2430` · line-strong `#2B3242` · divider `#181C26`
fg-strong `#E6E9F0` · fg `#C3C9D6` · fg-muted `#8A93A6` · fg-subtle `#565F73`
mint `#00E5C7` · mint-hover `#3CF0DA` · mint-fg `#05060A` · mint-tint `mint 10%` · mint-line `mint 28%` · mint-glow `mint 35%` · focus = mint
ok = mint / `mint 10%` · warn `#F5B942` / `warn 12%` · bad `#FF5C6A` / `bad 12%`
radius 4 · 6 · 8 (xl and 2xl are capped at 8) · pill 999

## Type

Space Grotesk (`--font-display`) 700, −3% to −4%: hero 78/1.02, page title 36/40, section 19/28, card title 17/24.
Inter (`--font-sans`) body 14/20; rows and detail values 13/20; ledes muted.
JetBrains Mono (`--font-mono`): eyebrow 11/16 caps +18% mint; index 11/16 caps +10% subtle; button 12 caps +10%; `.mono` 12 tabular.

## Primitives

`PageHeader` · `Section` (optional `index`) · `Eyebrow` · `Stats`/`Stat` · `Tag` · `Status` · `Band` · `Button`/`LinkButton` · `Field`/`Input` · `DetailList`/`DetailRow` · `Hash` · `Icon`/`CreditcoinMark` · `Mark`/`Wordmark` · `Backdrop`

CSS-only pieces in `globals.css`: `.eyebrow`, `.index`, `.display`, `.glow`, `.dot`, `.hr-decay`, `.btn` (+ `-md/-sm`, `-primary/-secondary/-ghost`), `.ticker`.

Adding one: use only semantic utilities (`bg-surface`, `text-fg-muted`, …), give it a fixed line box, put it in
`components/ui/`, render it once on `/design`, and keep the count on that page honest.

## Checking alignment

`node shot.mjs` (dev server on :3000) screenshots the two demo screens to `/tmp` and asserts the policy split.
Look at the full-page shots at 1440px and 390px; the things that go wrong are a column that stops being fixed-width,
a value that changes size between cells, a label that wraps, and a constellation edge crossing a headline.
