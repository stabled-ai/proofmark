'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { WalletSession, type WalletProvider } from '@pipeline/wallet-session.js';
import { Band } from '@/components/ui/Band';
import { Button, LinkButton } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Page';
import { Tag } from '@/components/ui/Tag';
import { Hash } from '@/components/ui/Hash';
import { Icon } from '@/components/ui/Icon';
import { parseProviderObservation, PROVIDER_COPY, type ProviderEnvironment, type ProviderObservation } from './model';

type Sdk = { launch(selector: string): void; destroy(): void };
type SdkBuilder = {
  withConf(config: { lang: string; theme: string }): SdkBuilder;
  withOptions(options: { addViewportTag: boolean; adaptIframeHeight: boolean }): SdkBuilder;
  on(event: string, handler: () => void): SdkBuilder;
  build(): Sdk;
};
declare global {
  interface Window {
    ethereum?: WalletProvider;
    snsWebSdk?: { init(token: string, renew: () => Promise<string>): SdkBuilder };
  }
}
type Readiness = { configured: boolean; environment: ProviderEnvironment | null; testOnly: boolean };
type Bound = { address: string; walletProof: string; providerProof: string; environment: ProviderEnvironment; revision: number };
type Challenge = { address: string; message: string; token: string; revision: number };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8Hex = (value: string) => '0x' + Array.from(new TextEncoder().encode(value)).map(byte => byte.toString(16).padStart(2, '0')).join('');

async function request(path: string, body?: object): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(15_000),
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      if (response.status === 503) throw new Error('Provider or approved processing configuration is unavailable. No result was confirmed.');
      if (response.status === 429) throw new Error('Too many requests. Wait before trying again.');
      throw new Error('The session or provider request could not be confirmed. Reconnect and try again.');
    }
    const value: unknown = await response.json();
    if (!object(value)) throw new Error('Invalid response');
    return value;
  } catch (error) {
    // Never render arbitrary provider bodies, SDK errors or wallet diagnostics.
    if (error instanceof Error && /^(Provider or approved|Too many requests|The session or provider)/.test(error.message)) throw error;
    throw new Error('The request is unavailable or timed out. No result was confirmed.');
  }
}

export default function ProviderVerification() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [consent, setConsent] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [holder, setHolder] = useState<string | null>(null);
  const [observation, setObservation] = useState<ProviderObservation | null>(null);
  const [session] = useState(() => new WalletSession());
  const bound = useRef<Bound | null>(null);
  const sdk = useRef<Sdk | null>(null);
  const locked = useRef(false);
  const reading = useRef(false);

  function clear(reason?: string) {
    session.dispose();
    bound.current = null;
    try { sdk.current?.destroy(); } catch { /* Drop all local authorization even if SDK cleanup fails. */ }
    sdk.current = null;
    setChallenge(null); setConsent(false); setAccessToken(null); setHolder(null); setObservation(null);
    if (reason) setError(reason);
  }

  useEffect(() => {
    let active = true;
    request('/api/providers/sumsub/status').then(value => {
      if (!active) return;
      if (typeof value.configured !== 'boolean' || value.mode !== 'evidence-candidate-only'
        || value.configured && value.environment !== 'sandbox' && value.environment !== 'production') throw new Error('Unavailable');
      setReadiness({ configured: value.configured, environment: value.configured ? value.environment as ProviderEnvironment : null,
        testOnly: value.testOnly === true });
    }).catch(() => { if (active) { setReadiness({ configured: false, environment: null, testOnly: false }); setError('Provider configuration could not be confirmed.'); } });
    const expiryTimer = window.setInterval(() => session.expireIfNeeded(), 1_000);
    return () => { active = false; window.clearInterval(expiryTimer); session.dispose(); try { sdk.current?.destroy(); } catch { /* closed */ } };
  }, [session]);

  async function act(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    let revision = session.revision;
    try { const pending = action(); revision = session.revision; await pending; }
    catch (failure) {
      // Session invalidation already reports its specific, privacy-safe reason.
      // Do not replace it with the generic WalletSessionChanged rejection.
      if (revision === session.revision) setError(failure instanceof Error ? failure.message : 'Verification could not be confirmed.');
    }
    finally { locked.current = false; setBusy(false); }
  }

  async function connect() {
    if (!readiness?.configured || !window.ethereum) throw new Error('Open this page with MetaMask or another supported browser wallet to continue.');
    clear(); session.attach(window.ethereum, reason => clear(reason));
    const revision = session.revision;
    const address = session.bind(revision, await session.request(revision, { method: 'eth_requestAccounts' }, () => window.ethereum));
    const result = await request(`/api/providers/sumsub/wallet?address=${encodeURIComponent(address)}`);
    await session.check(revision, () => window.ethereum);
    if (typeof result.message !== 'string' || result.message.length > 32_768 || typeof result.token !== 'string') throw new Error('Consent message could not be confirmed.');
    setChallenge({ address, message: result.message, token: result.token, revision });
  }

  async function sdkToken(current: Bound): Promise<string> {
    await session.check(current.revision, () => window.ethereum);
    const result = await request('/api/providers/sumsub/token', { walletProof: current.walletProof,
      ...(current.providerProof ? { providerProof: current.providerProof } : {}) });
    await session.check(current.revision, () => window.ethereum);
    if (typeof result.accessToken !== 'string' || !result.accessToken || result.accessToken.length > 1024
      || typeof result.providerProof !== 'string' || !result.providerProof || result.environment !== current.environment) throw new Error('Provider token could not be confirmed.');
    current.providerProof = result.providerProof;
    return result.accessToken;
  }

  async function signAndStart() {
    if (!challenge || !consent || !readiness?.environment) throw new Error('Review the exact consent message before signing.');
    const { revision, address } = challenge;
    await session.check(revision, () => window.ethereum);
    const signature = await session.request(revision, { method: 'personal_sign', params: [utf8Hex(challenge.message), address] }, () => window.ethereum);
    await session.check(revision, () => window.ethereum);
    const started = session.authorizationStarted();
    const response = await request('/api/providers/sumsub/wallet', { token: challenge.token, signature });
    if (typeof response.address !== 'string' || response.address.toLowerCase() !== address || typeof response.walletProof !== 'string'
      || typeof response.serverTime !== 'number' || typeof response.walletExpiresAt !== 'number') throw new Error('Wallet authorization could not be confirmed.');
    session.authorize(revision, { serverTime: response.serverTime, walletExpiresAt: response.walletExpiresAt }, started);
    const current: Bound = { address, walletProof: response.walletProof, providerProof: '', environment: readiness.environment, revision };
    const token = await sdkToken(current);
    session.assertCurrent(revision);
    bound.current = current; setHolder(address); setAccessToken(token); setChallenge(null);
  }

  async function refresh() {
    const current = bound.current;
    if (!current || reading.current) return;
    reading.current = true;
    try {
      await session.check(current.revision, () => window.ethereum);
      const response = await request('/api/providers/sumsub/status', { walletProof: current.walletProof, providerProof: current.providerProof });
      await session.check(current.revision, () => window.ethereum);
      if (bound.current !== current) return;
      setObservation(parseProviderObservation(response, current.address, current.environment)); setError(null);
    } catch {
      if (bound.current === current) { setObservation(null); setError('Current provider status is unavailable. No approval or eligibility is confirmed.'); }
    } finally { reading.current = false; }
  }

  useEffect(() => {
    if (!accessToken) return;
    // Below the server's status budget; callbacks never approve a credential.
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
    // refresh uses the current ref-bound session, not captured token state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  function launch() {
    if (!accessToken || !bound.current || !window.snsWebSdk || sdk.current) return;
    try {
      session.assertCurrent(bound.current.revision);
      sdk.current = window.snsWebSdk.init(accessToken, async () => {
        const current = bound.current; if (!current) throw new Error('Session expired');
        try { return await sdkToken(current); }
        catch { clear('Provider session renewal failed. Reconnect before continuing.'); throw new Error('Session unavailable'); }
      }).withConf({ lang: 'en', theme: 'dark' }).withOptions({ addViewportTag: false, adaptIframeHeight: true })
        .on('idCheck.onError', () => { setObservation(null); setError('Verification could not continue. Follow the instructions below or reconnect your wallet.'); }).build();
      sdk.current.launch('#sumsub-websdk-container');
    } catch { clear('The hosted SDK could not start. Reload this page and reconnect.'); }
  }

  return <>
    <PageHeader eyebrow="Verify with Sumsub" title="Identity verification"
      lede="Connect your wallet and complete your identity check with Sumsub."
      aside={readiness?.environment === 'sandbox' ? <Tag tone="warn">Sandbox</Tag> : undefined} />

    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section aria-label="Identity verification" className="panel overflow-hidden">
        <ol aria-label="Verification progress" className="grid grid-cols-3 border-b border-line bg-canvas-2 px-4 py-5 sm:px-7">
          {['Connect wallet', 'Review consent', 'Verify identity'].map((label, index) => {
            const current = holder ? 2 : challenge ? 1 : 0;
            return <li key={label} aria-current={index === current ? 'step' : undefined} className="flex items-center gap-3 text-xs font-medium sm:text-[13px]">
              <span className={`mono flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${index < current ? 'bg-mint text-mint-fg' : index === current ? 'border border-mint text-mint shadow-[0_0_12px_var(--mint-glow)]' : 'border border-line-strong text-fg-subtle'}`}>{index < current ? <Icon name="check" size={14} /> : `0${index + 1}`}</span>
              <span className={index === current ? 'text-fg-strong' : 'text-fg-muted'}>{label}</span>
            </li>;
          })}
        </ol>
        <div className="p-6 sm:p-8">
          <div role="status" aria-live="polite">{error && <Band tone="bad" className="mb-5">{error}</Band>}{busy && <p className="mb-5 text-sm text-fg-muted">Waiting for your wallet…</p>}</div>
          {!readiness ? <div className="py-14 text-center text-sm text-fg-muted">Checking availability…</div> : !readiness.configured ?
            <div className="py-8 sm:py-12">
              <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-md border border-line bg-canvas-2 text-fg-muted"><Icon name="clock" size={22} /></div>
              <h2 className="display text-[26px] leading-8">Verification is temporarily unavailable</h2>
              <p className="mt-3 max-w-lg text-sm leading-6 text-fg-muted">Please try again later. You can explore the verification process with a sample profile in the meantime.</p>
              <div className="mt-7 flex flex-wrap gap-3"><LinkButton href="/demo" variant="primary">Explore the demo <Icon name="arrow" size={16} /></LinkButton><LinkButton href="/verify/provider">Try again</LinkButton></div>
            </div> : <>
              {readiness.testOnly && <Band tone="warn" className="mb-6">Use official Sumsub test documents only. Do not submit a real ID, selfie, or other personal data in this sandbox.</Band>}
              {!challenge && !accessToken && <div className="py-6 sm:py-10">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-md border border-mint/25 bg-mint-tint text-mint"><Icon name="wallet" size={22} /></div>
                <h2 className="display text-[26px] leading-8">Start with your wallet</h2>
                <p className="mt-3 max-w-md text-sm leading-6 text-fg-muted">Choose the wallet you want to verify. You will review and sign a consent message before sharing your documents.</p>
                <Button className="mt-7 min-w-48" onClick={() => void act(connect)} disabled={busy}><Icon name="wallet" size={18} />Connect wallet</Button>
                <p className="mt-3 text-xs text-fg-muted">Signing the message does not move funds or cost gas.</p>
              </div>}
              {challenge && <>
                <h2 className="display text-[22px] leading-7">Review and consent</h2>
                <p className="mb-5 mt-2 text-sm text-fg-muted">Your wallet will sign the message below.</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunk p-4 text-xs leading-5 text-fg" data-provider-consent>{challenge.message}</pre>
                <label className="mt-5 flex items-start gap-3 rounded-lg border border-line p-4 text-sm leading-6 text-fg"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} className="mt-1" /><span>I have reviewed the processing and retention notice in this message and agree to this verification flow.</span></label>
                <Button className="mt-5" disabled={!consent || busy} onClick={() => void act(signAndStart)}>Sign and continue <Icon name="arrow" size={16} /></Button>
              </>}
              {holder && <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5"><div className="flex items-center gap-2 text-fg-muted"><Icon name="wallet" size={18} /><Hash value={holder} /></div><div className="flex flex-wrap gap-1"><Button variant="secondary" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh status</Button><Button variant="ghost" size="sm" onClick={() => { session.dispose(); clear(); }}>Disconnect</Button></div></div>}
              {observation && <div className="mb-5" aria-live="polite"><Band tone={observation.decision === 'rejected' ? 'bad' : 'note'}><strong>{PROVIDER_COPY[observation.decision].title}</strong><p className="mt-1">{PROVIDER_COPY[observation.decision].detail}</p><p className="mt-2 text-xs text-fg-muted">Updated {new Date(observation.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></Band></div>}
              {accessToken && <><Script id="proofmark-sumsub-sdk" src="https://static.sumsub.com/idensic/static/sns-websdk-builder.js" strategy="afterInteractive" onReady={launch} onError={() => clear('Verification is unavailable. Reload this page and reconnect.')} /><div id="sumsub-websdk-container" className="min-h-48" /></>}
            </>}
        </div>
      </section>

      <aside className="grid gap-5">
        <div className="panel p-6">
          <div className="mb-4 flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-md border border-mint/25 bg-mint-tint text-mint"><Icon name="shield" size={18} /></span><h2 className="display text-[17px] leading-6">Before you begin</h2></div>
          <ul className="space-y-4 text-sm leading-6 text-fg-muted">
            <li className="flex gap-3"><Icon name="wallet" size={18} className="mt-1 shrink-0" /><span>Use a browser wallet such as MetaMask.</span></li>
            <li className="flex gap-3"><Icon name="user" size={18} className="mt-1 shrink-0" /><span>{readiness?.testOnly ? 'Have an official Sumsub test document ready.' : 'Follow Sumsub’s instructions for your document and identity check.'}</span></li>
          </ul>
          <p className="mt-6 border-t border-line pt-5 text-xs leading-5 text-fg-muted">Your documents are submitted directly to Sumsub. They are not uploaded to a blockchain.</p>
        </div>
        <div className="px-2 text-xs leading-5 text-fg-muted">
          <p>This identity check does not currently issue a Proofmark credential or enable asset access.</p>
          <a href="/demo" className="link mt-3 inline-flex items-center gap-1.5">Preview the experience <Icon name="arrow" size={14} /></a>
        </div>
      </aside>
    </div>
  </>;
}
