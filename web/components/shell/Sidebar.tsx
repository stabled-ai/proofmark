'use client';

import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Mark, Wordmark } from '@/components/ui/Logo';

export const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Home', icon: 'layers' },
  { href: '/verify/provider', label: 'Verification', icon: 'user' },
  { href: '/onchain', label: 'Wallet lookup', icon: 'wallet' },
  { href: '/screening', label: 'Screening', icon: 'shield' },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="site-header">
      <div className="site-header-inner">
        {/* Full document navigation applies and removes provider-only camera permissions and CSP. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="brand-link" aria-label="Proofmark home">
          <Mark size={26} />
          <Wordmark size={20} />
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          {NAV.map(item => {
            const active = item.href === '/verify/provider' ? path.startsWith('/verify') : path === item.href;
            return <a key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>{item.label}</a>;
          })}
        </nav>
        <a href="/demo" className="btn btn-sm btn-secondary header-demo" aria-current={path === '/demo' ? 'page' : undefined}>
          Try the demo <Icon name="arrow" size={13} />
        </a>
      </div>
    </header>
  );
}
