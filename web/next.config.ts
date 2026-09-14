import type { NextConfig } from 'next';
import path from 'node:path';

const developmentEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
const scriptSources = `script-src 'self' 'unsafe-inline'${developmentEval}`;
const contentSecurityPolicy = `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; ${scriptSources}; connect-src 'self' https: wss:; upgrade-insecure-requests`;
// Only the hosted-verification document may embed Sumsub or request capture permissions.
// Entry links must perform a full document navigation: SPA navigation retains the old CSP.
// Regional Sumsub processing domains require their own reviewed configuration, not a wildcard.
const providerContentSecurityPolicy = contentSecurityPolicy.replace(
  scriptSources,
  `${scriptSources} https://static.sumsub.com; frame-src https://api.sumsub.com`,
);

/**
 * aml/ and pipeline/ are NodeNext modules at the repository root, so their internal imports
 * carry the `.js` extension. The bundler has to resolve those back to `.ts` for the web app to
 * share the source as-is. We do not copy the files: a copy drifts from the original.
 */
const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: '/verify', destination: '/verify/provider', permanent: false }];
  },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'Content-Security-Policy', value: contentSecurityPolicy },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ] }, {
      source: '/verify/provider',
      headers: [
        { key: 'Content-Security-Policy', value: providerContentSecurityPolicy },
        { key: 'Permissions-Policy', value: 'camera=(self "https://api.sumsub.com"), microphone=(self "https://api.sumsub.com"), geolocation=(), payment=(), usb=()' },
      ],
    }];
  },
  outputFileTracingRoot: path.join(process.cwd(), '..'),
  outputFileTracingIncludes: {
    '/api/kyc/id': [
      './scripts/validate-id-image.mjs', './lib/id-image-policy.json',
      './node_modules/sharp/**/*', './node_modules/@img/**/*',
      './node_modules/detect-libc/**/*', './node_modules/semver/**/*',
    ],
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
    resolveAlias: { '@aml': '../aml', '@pipeline': '../pipeline' },
  },
  webpack: (config) => {
    // aml/ and pipeline/ sit above web/. Their packages (ethers) must resolve from web/node_modules,
    // the only node_modules the Vercel build installs.
    config.resolve.modules = [path.join(process.cwd(), 'node_modules'), 'node_modules'];
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
