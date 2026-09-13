import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

/** Pill button. Styles live in globals.css (`.btn*`) so the header and plain anchors can share them. */
export function Button({ variant = 'primary', size = 'md', className = '', children, ...rest }:
  { variant?: Variant; size?: Size; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`btn btn-${size} btn-${variant} ${className}`} {...rest}>{children}</button>;
}

export function LinkButton({ variant = 'secondary', size = 'md', className = '', children, ...rest }:
  { variant?: Variant; size?: Size; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={`btn btn-${size} btn-${variant} ${className}`} {...rest}>{children}</a>;
}
