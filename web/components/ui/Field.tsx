import type { InputHTMLAttributes, ReactNode } from 'react';

const inputCls = 'h-10 w-full rounded-md border border-line-strong bg-sunk px-3.5 text-sm text-fg-strong placeholder:text-fg-subtle transition-[border-color,box-shadow] hover:border-fg-subtle focus:border-mint focus:shadow-[0_0_0_3px_var(--mint-tint)] focus:outline-none disabled:opacity-50';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputCls} ${className}`} {...rest} />;
}

/** Mono label above, hint (format, "optional") right-aligned, both on one 16px line. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 flex h-4 items-center justify-between leading-4">
        <span className="index text-fg-muted">{label}</span>{hint && <span className="index text-[10px]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
