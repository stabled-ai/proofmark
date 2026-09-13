'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { Button } from '@/components/ui/Button';

export function WalletLookup() {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      setError('Enter a valid wallet address: 0x followed by 40 hexadecimal characters.');
      return;
    }
    router.push(`/onchain?subject=${encodeURIComponent(value)}`);
  }

  return (
    <div className="panel home-lookup">
      <div className="flex items-center justify-between gap-3"><span className="index">01</span><Icon name="wallet" size={18} className="text-fg-subtle" /></div>
      <h2>Check a wallet</h2>
      <p>Look up verification status and asset eligibility.</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="home-wallet" className="sr-only">Wallet address</label>
        <div className="lookup-input-row">
          <div className="lookup-input-wrap"><Icon name="search" size={16} /><input id="home-wallet" name="subject" type="text" value={address} onChange={event => { setAddress(event.target.value); setError(''); }} placeholder="Enter wallet address (0x…)" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={100} aria-invalid={!!error} aria-describedby={error ? 'home-wallet-error' : undefined} /></div>
          <Button type="submit">Look up <Icon name="arrow" size={14} /></Button>
        </div>
        {error && <p id="home-wallet-error" role="alert" className="mt-2 text-xs text-bad">{error}</p>}
      </form>
      <a href="/onchain" className="lookup-sample">View a sample wallet <Icon name="arrow" size={12} /></a>
    </div>
  );
}
