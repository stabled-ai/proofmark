import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'mint' | 'gray';

const TONE: Record<Tone, string> = {
  ok: 'bg-ok-tint text-ok border-ok/25',
  warn: 'bg-warn-tint text-warn border-warn/25',
  bad: 'bg-bad-tint text-bad border-bad/25',
  mint: 'bg-mint-tint text-mint border-mint/25',
  gray: 'bg-surface-2 text-fg border-line-strong',
};

const SIZE = {
  sm: 'h-5 px-1.5 text-[11px]',
  md: 'h-6 px-2 text-xs',
  lg: 'h-7 px-2.5 text-[13px] font-semibold',
};

/**
 * Tag: tinted fill, hairline of the same hue, text of the same hue, 4px radius. Heights are
 * 20 / 24 / 28 so a tag sits on the same line box as 13px text (leading 20 / 24). `mono` for hex values.
 */
export function Tag({ tone = 'gray', mono, size = 'md', className = '', children }:
  { tone?: Tone; mono?: boolean; size?: keyof typeof SIZE; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border font-medium leading-none ${SIZE[size]} ${mono ? 'mono' : ''} ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}
