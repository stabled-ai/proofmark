import type { ReactNode } from 'react';
import { Header } from './Sidebar';
import { Backdrop } from './Backdrop';
import { CreditcoinMark } from '@/components/ui/Icon';
import { Wordmark } from '@/components/ui/Logo';
import { CC3_EXPLORER } from '@/lib/links';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Backdrop />
      <Header />
      <main id="main-content" className="site-main" tabIndex={-1}>{children}</main>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="footer-brand">
            <Wordmark size={16} />
            <span className="footer-tagline">Identity verification for digital assets</span>
          </div>
          <a href={CC3_EXPLORER} target="_blank" rel="noreferrer" className="footer-network">
            <CreditcoinMark size={14} /> Creditcoin <span className="network-label">Testnet</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
