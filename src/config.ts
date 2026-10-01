import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export class SetupError extends Error {}

export interface Config {
  teamId: string;
  botUserId: string;
  allowedUserIds: string[];
  operatorUserIds: string[];
  channels: Record<string, string>;
  stateDir: string;
  codexHome: string;
  hostPolicyReviewed: true;
  maxPending: number;
  maxConcurrentProjects: number;
  maxInputChars: number;
  maxOutputChars: number;
  turnTimeoutMs: number;
  queueTtlMs: number;
  retentionMs: number;
  maxRetainedEvents: number;
  secretEnvNames: string[];
}

const defaults = {
  maxPending: 20,
  maxConcurrentProjects: 2,
  maxInputChars: 12_000,
  maxOutputChars: 24_000,
  turnTimeoutMs: 300_000,
  queueTtlMs: 900_000,
  retentionMs: 7 * 86_400_000,
  maxRetainedEvents: 10_000,
};

export function privateDirectory(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new SetupError(`${label} must be an existing absolute private directory.`);
  }
  let info;
  let real;
  try {
    info = lstatSync(value);
    real = realpathSync(value);
  } catch {
    throw new SetupError(`${label} is not accessible; create it with mode 0700.`);
  }
  if (!info.isDirectory() || info.isSymbolicLink() || real !== path.normalize(value)
      || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
    throw new SetupError(`${label} must be owned by this account, mode 0700, and have no symlink components.`);
  }
  return real;
}

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function identities(value: unknown, pattern: RegExp, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 1000
      || !value.every(id => typeof id === 'string' && pattern.test(id))) {
    throw new SetupError(`${label} must be an explicit list of valid identifiers.`);
  }
  return [...new Set(value as string[])];
}

export function parseConfig(input: unknown): Config {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! < 24 || (major === 24 && minor! < 16) || !['darwin', 'linux'].includes(process.platform)) {
    throw new SetupError('Use Node 24.16.0 or newer on macOS or Linux; other execution boundaries are unsupported.');
  }
  if (process.getuid?.() === 0) throw new SetupError('Run Bridge as a dedicated unprivileged account, never root.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SetupError('Configuration must be a JSON object.');
  const raw = input as Record<string, unknown>;
  const keys = new Set(['teamId', 'botUserId', 'allowedUserIds', 'operatorUserIds', 'channels', 'stateDir', 'codexHome', 'hostPolicyReviewed', 'secretEnvNames', ...Object.keys(defaults)]);
  if (Object.keys(raw).some(key => !keys.has(key))) throw new SetupError('Unknown configuration key; arbitrary SDK or executable overrides are not supported.');
  const teamId = identities([raw.teamId], /^T[A-Z0-9]{2,30}$/, 'teamId')[0]!;
  const botUserId = identities([raw.botUserId], /^[UW][A-Z0-9]{2,30}$/, 'botUserId')[0]!;
  const allowedUserIds = identities(raw.allowedUserIds, /^[UW][A-Z0-9]{2,30}$/, 'allowedUserIds');
  const operatorUserIds = identities(raw.operatorUserIds ?? [], /^[UW][A-Z0-9]{2,30}$/, 'operatorUserIds', true);
  if (operatorUserIds.some(id => !allowedUserIds.includes(id))) throw new SetupError('Operators must also be allowed users.');
  if (raw.hostPolicyReviewed !== true) {
    throw new SetupError('Review the dedicated OS account and host Codex policy prerequisites, then set hostPolicyReviewed to true.');
  }
  const stateDir = privateDirectory(raw.stateDir, 'stateDir');
  const codexHome = privateDirectory(raw.codexHome, 'codexHome');
  const personalHomes = [path.join(homedir(), '.codex'), process.env.CODEX_HOME].filter((p): p is string => !!p).map(p => {
    try { return realpathSync(p); } catch { return path.resolve(p); }
  });
  if (personalHomes.some(p => isWithin(p, codexHome)) || isWithin(stateDir, codexHome) || isWithin(codexHome, stateDir)) {
    throw new SetupError('Use separate, dedicated state and Codex directories, outside the inherited Codex home.');
  }
  if (!raw.channels || typeof raw.channels !== 'object' || Array.isArray(raw.channels)) throw new SetupError('channels must map Slack channel IDs to existing Git project roots.');
  const entries = Object.entries(raw.channels);
  if (entries.length === 0 || entries.length > 100) throw new SetupError('Configure between 1 and 100 channels.');
  const channels: Record<string, string> = {};
  for (const [channel, directory] of entries) {
    if (!/^[CG][A-Z0-9]{2,30}$/.test(channel) || typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new SetupError('Each channel must have a Slack ID and an absolute project path.');
    }
    let real;
    try {
      real = realpathSync(directory);
      if (!statSync(real).isDirectory() || !lstatSync(path.join(real, '.git'))) throw new Error();
    } catch {
      throw new SetupError('Each configured project must be an accessible Git root (including worktrees).');
    }
    if (isWithin(real, stateDir) || isWithin(real, codexHome) || isWithin(stateDir, real) || isWithin(codexHome, real)) {
      throw new SetupError('Private state and Codex home must be separate from project trees.');
    }
    channels[channel] = real;
  }
  const limits = { ...defaults };
  const bounds: Record<keyof typeof defaults, [number, number]> = {
    maxPending: [1, 1000], maxConcurrentProjects: [1, 8], maxInputChars: [1, 40_000],
    maxOutputChars: [100, 48_000], turnTimeoutMs: [1000, 1_800_000], queueTtlMs: [1000, 86_400_000],
    retentionMs: [60_000, 30 * 86_400_000], maxRetainedEvents: [10, 100_000],
  };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = raw[key] ?? defaults[key];
    const [min, max] = bounds[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new SetupError(`Invalid ${key} limit.`);
    limits[key] = value;
  }
  if (limits.retentionMs < limits.queueTtlMs) throw new SetupError('retentionMs must be at least queueTtlMs.');
  const secretEnvNames = identities(raw.secretEnvNames ?? [], /^[A-Z_][A-Z0-9_]{0,99}$/, 'secretEnvNames', true);
  return { teamId, botUserId, allowedUserIds, operatorUserIds, channels, stateDir, codexHome, hostPolicyReviewed: true, secretEnvNames, ...limits };
}

export function loadConfig(file: string): Config {
  let raw: unknown;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 128_000) throw new Error();
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new SetupError('Cannot read configuration JSON; use the documented BRIDGE_CONFIG file.');
  }
  return parseConfig(raw);
}

export function secretsFromEnvironment(config: Config, env = process.env): string[] {
  return ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', ...config.secretEnvNames]
    .map(name => env[name]).filter((value): value is string => !!value);
}
