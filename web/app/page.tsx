import { Icon } from '@/components/ui/Icon';
import { LinkButton } from '@/components/ui/Button';
import { VerificationStart } from '@/components/home/VerificationStart';
import { WalletLookup } from '@/components/home/WalletLookup';

export default function Home() {
  return (
    <>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="hero-copy">
          <div className="eyebrow">Identity for digital assets</div>
          <h1 id="home-title">Verify once.<br /><span className="glow">Keep moving.</span></h1>
          <p>Identity verification and asset eligibility, connected to your wallet.</p>
          <div className="hero-actions">
            {/* Full navigation loads the hosted provider's document-scoped permissions. */}
            <LinkButton href="/verify/provider" variant="primary">Start verification <Icon name="arrow" size={15} /></LinkButton>
            <LinkButton href="/demo" variant="ghost">See how it works <Icon name="arrow" size={15} /></LinkButton>
          </div>
          <div className="hero-note"><span className="dot" /> Your identity documents stay off-chain</div>
        </div>
        <VerificationStart />
      </section>

      <div className="ticker" aria-label="What Proofmark covers">
        <div className="ticker-words"><span>Verification</span><span>Screening</span><span>Eligibility</span></div>
        <div className="ticker-live"><span><span className="dot" />Creditcoin testnet</span><span><span className="dot" />OFAC · UN · EU</span></div>
      </div>

      <section className="home-workspace" aria-label="Verification tools">
        <WalletLookup />
        <div className="panel home-services">
          <a href="/screening" className="service-row">
            <span className="index service-index">02</span>
            <span className="service-icon"><Icon name="shield" size={20} /></span>
            <span className="min-w-0 flex-1"><span className="service-title">Sanctions screening</span><span className="service-description">Check a name against global sanctions lists.</span></span>
            <Icon name="arrow" size={16} className="service-arrow" />
          </a>
          <a href="/demo" className="service-row">
            <span className="index service-index">03</span>
            <span className="service-icon"><Icon name="bolt" size={20} /></span>
            <span className="min-w-0 flex-1"><span className="service-title">Take a test drive</span><span className="service-description">Try a sample verification. No wallet needed.</span></span>
            <Icon name="arrow" size={16} className="service-arrow" />
          </a>
        </div>
      </section>

      <section className="home-how" aria-labelledby="how-title">
        <hr className="hr-decay" />
        <div className="home-how-inner">
          <div className="home-how-heading"><div className="eyebrow">Getting started</div><h2 id="how-title">From identity<br className="hidden lg:block" /> to eligibility.</h2></div>
          <ol className="home-steps">
            <li><span className="step-number">01</span><h3>Connect your wallet</h3><p>Confirm the wallet you want to use.</p></li>
            <li><span className="step-number">02</span><h3>Verify your identity</h3><p>Complete the checks for your region.</p></li>
            <li><span className="step-number">03</span><h3>Check your eligibility</h3><p>See which asset requirements you meet.</p></li>
          </ol>
        </div>
      </section>
    </>
  );
}
