'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { LinkButton } from '@/components/ui/Button';

const METHODS = [
  { id: 'global', title: 'Global verification', description: 'Passport or identity document', icon: 'globe' as const, href: '/verify/provider' },
  { id: 'korea', title: 'South Korea', description: 'Korean ID and bank account', icon: 'user' as const, href: '/verify' },
];

export function VerificationStart() {
  const [method, setMethod] = useState('global');
  const selected = METHODS.find(item => item.id === method)!;
  return (
    <div className="verification-start">
      <div className="eyebrow">Identity verification</div>
      <h2>Let’s get you verified.</h2>
      <p className="verification-start-intro">Choose your verification method to begin.</p>
      <fieldset className="verification-methods">
        <legend className="sr-only">Verification method</legend>
        {METHODS.map(item => (
          <label key={item.id} className={`verification-method ${method === item.id ? 'selected' : ''}`}>
            <input type="radio" name="verification-method" value={item.id} checked={method === item.id} onChange={() => setMethod(item.id)} />
            <Icon name={item.icon} size={20} className="method-icon" />
            <span className="flex-1"><span className="method-title">{item.title}</span><span className="method-description">{item.description}</span></span>
            <span className="method-radio" aria-hidden>{method === item.id && <span />}</span>
          </label>
        ))}
      </fieldset>
      {/* Full navigation loads the hosted provider's document-scoped permissions. */}
      <LinkButton href={selected.href} variant="primary" className="w-full">Start verification <Icon name="arrow" size={15} /></LinkButton>
      <p className="verification-start-footnote"><Icon name="wallet" size={13} /> Have your wallet and ID ready</p>
    </div>
  );
}
