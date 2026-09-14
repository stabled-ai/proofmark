import { Icon } from '@/components/ui/Icon';
import { LinkButton } from '@/components/ui/Button';

export function VerificationStart() {
  return (
    <div className="verification-start">
      <div className="eyebrow">Identity verification</div>
      <h2>Let’s get you verified.</h2>
      <p className="verification-start-intro">Verify your identity through our global provider.</p>
      <div className="verification-methods">
        <div className="verification-method selected">
          <Icon name="globe" size={20} className="method-icon" />
          <span className="flex-1"><span className="method-title">Global verification</span><span className="method-description">Passport or identity document</span></span>
        </div>
      </div>
      {/* Full navigation loads the hosted provider's document-scoped permissions. */}
      <LinkButton href="/verify/provider" variant="primary" className="w-full">Start verification <Icon name="arrow" size={15} /></LinkButton>
      <p className="verification-start-footnote"><Icon name="wallet" size={13} /> Have your wallet and ID ready</p>
    </div>
  );
}
