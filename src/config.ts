import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export class SetupError extends Error {}

export type SendToolApprovalMode = 'auto' | 'prompt' | 'writes' | 'approve';

export interface Config {
  teamId: string;
  botUserId: string;
  allowedUserIds: string[];
  operatorUserIds: string[];
  incomingChannelIds: string[];
  outgoingChannels: Record<string, string>;
  mentionOnly: boolean;
  codex: { executable: string; args: string[]; cwd: string; transport?: 'exec' | 'app-server'; sendToolApprovalMode?: SendToolApprovalMode };
  stateDir: string;
  maxPending: number;
  maxInputChars: number;
  maxOutputChars: number;
  turnTimeoutMs: number;
  queueTtlMs: number;
  retentionMs: number;
  maxRetainedEvents: number;
  secretEnvNames: string[];
}

const defaults = {
  maxPending: 20, maxInputChars: 12_000, maxOutputChars: 24_000,
  turnTimeoutMs: 300_000, queueTtlMs: 900_000,
  retentionMs: 7 * 86_400_000, maxRetainedEvents: 10_000,
};

export function privateDirectory(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new SetupError(`${label} must be an existing absolute private directory.`);
  }
  let info;
  let real;
  try { info = lstatSync(value); real = realpathSync(value); }
  catch { throw new SetupError(`${label} is not accessible; create it with mode 0700.`); }
  if (!info.isDirectory() || info.isSymbolicLink() || real !== path.normalize(value)
      || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
    throw new SetupError(`${label} must be owned by this account, mode 0700, and have no symlink components.`);
  }
  return real;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identities(value: unknown, pattern: RegExp, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 1000
      || !value.every(id => typeof id === 'string' && pattern.test(id))) {
    throw new SetupError(`${label} must be an explicit list of valid identifiers.`);
  }
  return [...new Set(value as string[])];
}

// Only global CLI options: a preset cannot accidentally turn a doctor/list probe
// into a model command. Values remain operator-owned, including permission policy.
export function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every(arg => typeof arg === 'string' && arg.length <= 8000 && !arg.includes('\0'))) {
    throw new SetupError('codex.args must be a bounded array of global Codex options.');
  }
  const withValue = new Set(['-c', '--config', '-p', '--profile', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '--enable', '--disable', '--local-provider', '--add-dir']);
  const flags = new Set(['--oss', '--search', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--no-daemon', '--strict-config']);
  for (let i = 0; i < value.length; i++) {
    const arg = value[i] as string;
    if (flags.has(arg)) continue;
    if (!withValue.has(arg) || typeof value[++i] !== 'string' || value[i] === '') {
      throw new SetupError('codex.args accepts documented global option/value pairs and flags only; Bridge supplies exec, stdin, JSON and cwd.');
    }
    if ((arg === '-c' || arg === '--config') && !/^[A-Za-z0-9_.-]+=/.test(value[i])) {
      throw new SetupError('Codex config overrides must use key=value.');
    }
  }
  return [...value];
}

export function parseConfig(input: unknown): Config {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! < 24 || (major === 24 && minor! < 16) || !['darwin', 'linux'].includes(process.platform)) {
    throw new SetupError('Use Node 24.16.0 or newer on macOS or Linux (including Linux containers).');
  }
  if (!object(input)) throw new SetupError('Configuration must be a JSON object.');
  const raw = input;
  const keys = new Set(['teamId', 'botUserId', 'allowedUserIds', 'operatorUserIds', 'incomingChannelIds', 'outgoingChannels', 'mentionOnly', 'codex', 'stateDir', 'secretEnvNames', ...Object.keys(defaults)]);
  if (Object.keys(raw).some(key => !keys.has(key))) throw new SetupError('Unknown configuration key; migrate old pilot configuration using the current example.');
  const teamId = identities([raw.teamId], /^T[A-Z0-9]{2,30}$/, 'teamId')[0]!;
  const botUserId = identities([raw.botUserId], /^[UW][A-Z0-9]{2,30}$/, 'botUserId')[0]!;
  const allowedUserIds = identities(raw.allowedUserIds, /^[UW][A-Z0-9]{2,30}$/, 'allowedUserIds');
  const operatorUserIds = identities(raw.operatorUserIds ?? [], /^[UW][A-Z0-9]{2,30}$/, 'operatorUserIds', true);
  if (operatorUserIds.some(id => !allowedUserIds.includes(id))) throw new SetupError('Operators must also be allowed users.');
  const incomingChannelIds = identities(raw.incomingChannelIds, /^[CG][A-Z0-9]{2,30}$/, 'incomingChannelIds');
  if (!object(raw.outgoingChannels) || Object.keys(raw.outgoingChannels).length > 100) throw new SetupError('outgoingChannels must map up to 100 aliases to Slack channel IDs (or be empty for thread replies only).');
  const outgoingChannels: Record<string, string> = {};
  for (const [alias, channel] of Object.entries(raw.outgoingChannels)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(alias) || ['thread', '__proto__', 'constructor', 'prototype'].includes(alias)
        || typeof channel !== 'string' || !/^[CG][A-Z0-9]{2,30}$/.test(channel)) throw new SetupError('Invalid outgoing alias or Slack channel ID; thread is reserved for originating-thread replies.');
    outgoingChannels[alias] = channel;
  }
  if (raw.mentionOnly !== undefined && typeof raw.mentionOnly !== 'boolean') throw new SetupError('mentionOnly must be boolean.');
  if (!object(raw.codex) || Object.keys(raw.codex).some(key => !['executable', 'args', 'cwd', 'transport', 'sendToolApprovalMode'].includes(key))) throw new SetupError('codex must define executable, args and cwd.');
  const { executable, cwd, transport, sendToolApprovalMode } = raw.codex;
  if (transport !== undefined && transport !== 'exec' && transport !== 'app-server') throw new SetupError('codex.transport must be exec or app-server.');
  if (sendToolApprovalMode !== undefined && sendToolApprovalMode !== 'auto' && sendToolApprovalMode !== 'prompt'
      && sendToolApprovalMode !== 'writes' && sendToolApprovalMode !== 'approve') {
    throw new SetupError('codex.sendToolApprovalMode must be auto, prompt, writes or approve when configured.');
  }
  if (typeof executable !== 'string' || !executable || executable.includes('\0') || (!path.isAbsolute(executable) && !/^[a-zA-Z0-9_.-]+$/.test(executable))) {
    throw new SetupError('codex.executable must be an absolute path or an executable name resolved on PATH.');
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new SetupError('codex.cwd must be an existing absolute directory.');
  let real;
  try { real = realpathSync(cwd); if (!statSync(real).isDirectory()) throw new Error(); }
  catch { throw new SetupError('codex.cwd is not an accessible directory.'); }
  const codex: Config['codex'] = { executable, args: validateArgs(raw.codex.args ?? []), cwd: real,
    ...(transport === undefined ? {} : { transport }),
    ...(sendToolApprovalMode === undefined ? {} : { sendToolApprovalMode }) };
  const stateDir = privateDirectory(raw.stateDir, 'stateDir');
  const limits = { ...defaults };
  const bounds: Record<keyof typeof defaults, [number, number]> = {
    maxPending: [1, 1000], maxInputChars: [1, 40_000], maxOutputChars: [100, 48_000],
    turnTimeoutMs: [0, 1_800_000], queueTtlMs: [1000, 86_400_000],
    retentionMs: [60_000, 30 * 86_400_000], maxRetainedEvents: [10, 100_000],
  };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = raw[key] ?? defaults[key];
    const [min, max] = bounds[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max
        || (key === 'turnTimeoutMs' && value > 0 && value < 1000)) throw new SetupError(`Invalid ${key} limit.`);
    limits[key] = value;
  }
  if (limits.retentionMs < limits.queueTtlMs) throw new SetupError('retentionMs must be at least queueTtlMs.');
  const secretEnvNames = identities(raw.secretEnvNames ?? [], /^[A-Z_][A-Z0-9_]{0,99}$/, 'secretEnvNames', true);
  return { teamId, botUserId, allowedUserIds, operatorUserIds, incomingChannelIds, outgoingChannels, mentionOnly: raw.mentionOnly ?? false, codex, stateDir, secretEnvNames, ...limits };
}

export function loadConfig(file: string): Config {
  let raw: unknown;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 128_000) throw new Error();
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch { throw new SetupError('Cannot read configuration JSON; use the documented BRIDGE_CONFIG file.'); }
  return parseConfig(raw);
}

export function secretsFromEnvironment(config: Config, env = process.env): string[] {
  return [...Object.keys(env).filter(name => /^SLACK_/i.test(name)), ...config.secretEnvNames]
    .map(name => env[name]).filter((value): value is string => !!value);
}
