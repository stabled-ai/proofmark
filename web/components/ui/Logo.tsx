/** Proofmark mark: a seal ring, open at the top-right until the check closes it. Inherits currentColor. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <path d="M27.5 10.2A13 13 0 1 1 21.5 4.4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="m10.5 16.5 4 4 9-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Wordmark in the display face, sized by its cap line. Inherits colour so it works on any surface. */
export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="display inline-block leading-none" style={{ fontSize: size, letterSpacing: '-0.04em' }}>
      proofmark<span className="text-mint">.</span>
    </span>
  );
}
