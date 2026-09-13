# Deck

`deck.html` is the source. `proofmark-deck.pdf` and `slides/*.png` are rendered from it.

Current version: **2026-09-14 investor and judge deck**, 16 slides, one claim per slide. It replaces the
2026-09-07 submission deck (13 slides, white canvas; see git history before this commit). The story runs:
problem → the call → verify/prove/enforce → live evidence → one mark two policies → revocation travels →
why now → business structure → value chain → revenue model → go-to-market → security → founder → team → ask. The root README states the deployment and product boundaries.

Every number on a slide has a source in the repository: test counts from `npm run test:evidence`,
sanctions counts from the built index, transaction records from `deployments/`, hashes from the README,
and team and iM Bank facts from the Validator corporate deck. Update the HTML, re-render, and commit both;
a rendered deck whose PDF disagrees with its source is worse than no deck.

```sh
node docs/deck/render.mjs              # every slide plus the PDF
node docs/deck/render.mjs --only 6,11  # just those PNGs; the PDF always rewrites
```

Rendering uses the system Chrome through Playwright, so no chromium download is needed. The slide count is
read from the document, so adding or cutting a slide needs no code change.

Design follows `web/DESIGN.md`: one dark canvas, hairline structure, Poppins display over Inter, mono for
code and hashes, mint as the only accent, status in three hues. No tiles, gradients or icons.
