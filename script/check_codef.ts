/**
 * CODEF credential preflight.
 *
 * Answers one question before a deploy: do the CODEF variables in this environment let the
 * ID axis of /verify reach Government24 and Traffic Civil Service 24 for real? It checks the
 * variable set the web app reads (web/lib/kyc-server.ts), the RSA public key from Key
 * Management, and a real token exchange with https://oauth.codef.io/oauth/token.
 *
 * No credential is ever printed. Only CODEF_ENV, CODEF_LOGIN_TYPE and CODEF_SIMPLE_LEVEL
 * appear in the output; every other CODEF_* value is redacted on its way out, even if a
 * library error quotes it back. The script writes no file.
 *
 * Usage: npx tsx script/check_codef.ts [path-to-env-file]
 *   no argument     read process.env as it is
 *   path argument   also load KEY=VALUE lines from that file (e.g. web/.env.local), but only
 *                   for keys that are not already set in process.env
 *
 * One line per check: `PASS <name>`, `WARN <name>: <reason>`, `FAIL <name>: <reason>`.
 * Every check runs even after an earlier one fails.
 * Exit 0 when no check failed (warnings are allowed), 1 when any check failed.
 *
 * Required variables are documented in web/.env.example.
 */
import { readFileSync } from 'node:fs';
import { CodefClient, type CodefEnv } from '../pipeline/adapters/codef.js';

/** The only CODEF values that may be printed. Everything else is a credential or personal data. */
const PRINTABLE = new Set(['CODEF_ENV', 'CODEF_LOGIN_TYPE', 'CODEF_SIMPLE_LEVEL', 'CODEF_CERT_TYPE', 'CODEF_LOGIN_TELECOM']);

const CLIENT_VARS = ['CODEF_CLIENT_ID', 'CODEF_CLIENT_SECRET', 'CODEF_PUBLIC_KEY'];
const SIMPLE_VARS = ['CODEF_LOGIN_PHONE', 'CODEF_LOGIN_USER_NAME', 'CODEF_LOGIN_IDENTITY'];
const CERT_VARS = ['CODEF_CERT_FILE', 'CODEF_CERT_PASSWORD', 'CODEF_LOGIN_USER_NAME', 'CODEF_LOGIN_IDENTITY'];
const ENVS = ['sandbox', 'demo', 'api'];
const TOKEN_TIMEOUT_MS = 15_000;

const val = (name: string): string | undefined => process.env[name]?.trim() || undefined;

let failed = false;
let secrets: string[] = [];

/**
 * Every CODEF_* value that is not on the printable list, longest first. Whatever the script is
 * about to print goes through here, so a credential cannot leak through an error message.
 */
function collectSecrets(): void {
  secrets = Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('CODEF_') && !PRINTABLE.has(k) && typeof v === 'string' && v.trim().length >= 4)
    .map(([, v]) => (v as string).trim())
    .sort((a, b) => b.length - a.length);
}

const scrub = (text: string): string => secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);

function emit(status: 'PASS' | 'WARN' | 'FAIL', name: string, reason?: string): void {
  if (status === 'FAIL') failed = true;
  console.log(reason ? `${status} ${name}: ${scrub(reason)}` : `${status} ${name}`);
}

function messageOf(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string } } | undefined;
  const base = e?.message?.trim() || String(err);
  const code = e?.cause?.code;
  return code ? `${base} (${code})` : base;
}

/** KEY=VALUE lines, `#` comments, one optional pair of surrounding quotes. Never overrides a set key. */
function loadEnvFile(path: string): void {
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  const file = process.argv[2];
  let fileError: string | null = null;
  if (file) {
    try { loadEnvFile(file); } catch (err) { fileError = messageOf(err); }
  }
  collectSecrets();

  const envValue = val('CODEF_ENV');
  const loginType = val('CODEF_LOGIN_TYPE');
  const level = val('CODEF_SIMPLE_LEVEL') ?? '1';
  console.log(`CODEF preflight · env ${envValue ?? '(unset)'} · login ${loginType ?? '(unset)'} · level ${level}`);

  if (fileError) emit('FAIL', 'env-file', `could not read ${file}: ${fileError}`);
  else if (file) emit('PASS', 'env-file');

  // 1. client-vars — the three keys from My Page > Key Management.
  const missingClient = CLIENT_VARS.filter((v) => !val(v));
  if (missingClient.length) emit('FAIL', 'client-vars', `not set: ${missingClient.join(', ')}`);
  else emit('PASS', 'client-vars');

  // 2. env — which CODEF host answers, and whether it can answer for real at all.
  if (!envValue) {
    emit('WARN', 'env', 'CODEF_ENV is not set; web/lib/kyc-server.ts defaults to demo, which queries the real institutions within a daily allowance');
  } else if (envValue === 'sandbox') {
    emit('WARN', 'env', 'sandbox answers from fixed sample data and never produces a live result; use demo for a real lookup');
  } else if (ENVS.includes(envValue)) {
    emit('PASS', 'env');
  } else {
    emit('FAIL', 'env', `CODEF_ENV must be sandbox, demo or api (got ${envValue})`);
  }

  // 3. login — the two login shapes web/lib/kyc-server.ts builds, checked as it builds them.
  if (loginType === 'simple') {
    const missing = SIMPLE_VARS.filter((v) => !val(v));
    if (level === '5' && !val('CODEF_LOGIN_TELECOM')) missing.push('CODEF_LOGIN_TELECOM');
    const digits = (val('CODEF_LOGIN_IDENTITY') ?? '').replace(/\D/g, '').length;
    if (missing.length) emit('FAIL', 'login', `app-based login is missing: ${missing.join(', ')}`);
    else if (digits !== 13) emit('FAIL', 'login', `CODEF_LOGIN_IDENTITY must hold the operator's 13-digit resident registration number; this one has ${digits} digits`);
    else emit('PASS', 'login');
  } else {
    if (!loginType) emit('WARN', 'login', 'CODEF_LOGIN_TYPE is not set; web/lib/kyc-server.ts falls back to the certificate login, while the runbook path is CODEF_LOGIN_TYPE=simple');
    else if (loginType !== 'cert') emit('WARN', 'login', `CODEF_LOGIN_TYPE is ${loginType}; web/lib/kyc-server.ts treats anything but simple as the certificate login`);
    const certVars = [...CERT_VARS, ...(val('CODEF_CERT_TYPE') === '1' ? ['CODEF_KEY_FILE'] : [])];
    const missing = certVars.filter((v) => !val(v));
    if (missing.length) emit('FAIL', 'login', `certificate login is missing: ${missing.join(', ')}`);
    else emit('PASS', 'login');
  }

  // 4-5. public-key and token — the only two checks that need the credentials to be real.
  if (missingClient.length) {
    const skip = 'skipped: the client variables are not set';
    emit('FAIL', 'public-key', skip);
    emit('FAIL', 'token', skip);
    return;
  }

  let client: CodefClient | null = null;
  let clientError: string | null = null;
  try {
    client = new CodefClient({
      clientId: val('CODEF_CLIENT_ID')!,
      clientSecret: val('CODEF_CLIENT_SECRET')!,
      publicKey: val('CODEF_PUBLIC_KEY'),
      env: (envValue && ENVS.includes(envValue) ? envValue : 'demo') as CodefEnv,
      // The preflight must not hang on a network that swallows the connection.
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) }),
    });
  } catch (err) {
    clientError = messageOf(err);
  }

  if (!client) {
    emit('FAIL', 'public-key', clientError ?? 'the CODEF client could not be built');
    emit('FAIL', 'token', clientError ?? 'the CODEF client could not be built');
    return;
  }

  // RSA/PKCS#1 v1.5 with the account public key: the resident number tail and the certificate
  // password are sent this way, so a malformed key breaks every check later, not here.
  try {
    client.rsa('probe');
    emit('PASS', 'public-key');
  } catch (err) {
    emit('FAIL', 'public-key', messageOf(err));
  }

  try {
    await client.accessToken();
    emit('PASS', 'token');
  } catch (err) {
    emit('FAIL', 'token', messageOf(err));
  }
}

main()
  .catch((err) => { emit('FAIL', 'preflight', messageOf(err)); })
  .then(() => {
    if (failed) console.log('one or more checks failed; verify the CODEF settings in web/.env.example');
    process.exit(failed ? 1 : 0);
  });
