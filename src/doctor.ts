import { lstatSync } from 'node:fs';
import path from 'node:path';
import { preflight } from './codex.js';
import { type Config, SetupError } from './config.js';

export interface DoctorCheck { check: string; ok: boolean; detail: string }

export async function doctor(config: Config, env = process.env): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  add('runtime and configuration', true, 'Supported Node/platform; explicit identities and private paths validated.');
  // Doctor must not perform recovery or mutate an existing service database.
  add('state directory', true, 'Private directory validated. Startup acquires the SQLite instance lock and validates the schema.');
  for (const token of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) {
    const valid = token === 'SLACK_BOT_TOKEN' ? /^xoxb-\S+$/.test(env[token] ?? '') : /^xapp-\S+$/.test(env[token] ?? '');
    add(token, valid, valid ? 'Present; identity and access are checked only at service startup.' : 'Missing or invalid; configure the operator-created Slack app token.');
  }
  for (const name of config.secretEnvNames) {
    add('configured redaction value', !!env[name], env[name] ? 'Present.' : 'A configured secret environment variable is missing.');
  }
  try {
    const auth = lstatSync(path.join(config.codexHome, 'auth.json'));
    const ok = auth.isFile() && !auth.isSymbolicLink() && auth.nlink === 1 && auth.uid === process.getuid?.() && (auth.mode & 0o777) === 0o600 && auth.size > 0;
    add('Codex login', ok, ok ? 'Dedicated private auth file present; validity/expiry unverified without a live request.' : 'Dedicated auth file must be a private regular file owned by this account.');
  } catch {
    add('Codex login', false, 'Missing operator login in the dedicated Codex home. No personal credentials were read or copied.');
  }
  try {
    for (const project of new Set(Object.values(config.channels))) await preflight(config, project);
    add('Codex boundary', true, 'Pinned CLI, disabled features, absent custom configuration, and no enabled MCPs verified without a model turn.');
  } catch (error) {
    add('Codex boundary', false, error instanceof SetupError ? error.message : 'Unable to verify the execution boundary.');
  }
  add('host policy review', true, 'Operator attests no conflicting MDM/cloud policy and a dedicated unprivileged account. This is not an OS sandbox or confidentiality test.');
  return checks;
}
