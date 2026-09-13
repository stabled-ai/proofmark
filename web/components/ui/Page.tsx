import type { ReactNode } from 'react';

/** Page header: mono eyebrow, display title with `aside` on the same line, one-sentence lede, hairline below. */
export function PageHeader({ eyebrow, title, lede, aside }:
  { eyebrow?: ReactNode; title: ReactNode; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="mb-8 border-b border-line pb-6">
      {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <h1 className="display text-[30px] leading-9 sm:text-[36px] sm:leading-10">{title}</h1>
        {aside && <div className="flex min-h-8 flex-wrap items-center gap-3">{aside}</div>}
      </div>
      {lede && <p className="mt-3 max-w-2xl text-sm leading-6 text-fg-muted">{lede}</p>}
    </header>
  );
}

/** Section: optional mono index, display title and a right-aligned aside on one 28px line; optional lede; 14px to the body. */
export function Section({ index, title, aside, lede, children, className = '' }:
  { index?: string; title: ReactNode; aside?: ReactNode; lede?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mt-9 ${className}`}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="display flex items-baseline gap-3 text-[19px] leading-7">
          {index && <span className="index">{index}</span>}
          {title}
        </h2>
        {aside && <div className="flex items-center gap-2 text-xs text-fg-muted">{aside}</div>}
      </div>
      {lede && <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-fg-muted">{lede}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/** Mono label above a list. Mint with the `//` prefix by default; `quiet` for muted. */
export function Eyebrow({ children, quiet, className = '' }: { children: ReactNode; quiet?: boolean; className?: string }) {
  return <div className={`eyebrow ${quiet ? 'quiet' : ''} ${className}`}>{children}</div>;
}
