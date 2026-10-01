import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, parseConfig, secretsFromEnvironment } from '../src/config.js';
import { checkConfigurationFiles } from '../src/codex.js';
import { fixture } from './helpers.js';

test('configuration rejects empty/unknown access, unsafe paths, policy overrides and invalid limits', t => {
  const { config, root } = fixture(t);
  for (const invalid of [
    { teamId: '' }, { allowedUserIds: [] }, { channels: {} }, { operatorUserIds: ['UEVE'] },
    { hostPolicyReviewed: false }, { sandboxMode: 'workspace-write' }, { maxPending: 0 },
    { maxConcurrentProjects: 100 }, { retentionMs: 60_000, queueTtlMs: 61_000 },
    { channels: { CPROJECT: 'relative' } }, { codexHome: config.stateDir },
    { channels: { CPROJECT: config.stateDir } },
  ]) assert.throws(() => parseConfig({ ...config, ...invalid }));
  const alias = path.join(root, 'alias'); symlinkSync(config.codexHome, alias);
  assert.throws(() => parseConfig({ ...config, codexHome: alias }), /symlink/);
  chmodSync(config.stateDir, 0o755);
  assert.throws(() => parseConfig(config), /0700/);
  chmodSync(config.stateDir, 0o500);
  assert.throws(() => parseConfig(config), /0700/);
  chmodSync(config.stateDir, 0o700);
  const previous = process.env.CODEX_HOME;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  process.env.CODEX_HOME = alias;
  assert.throws(() => parseConfig(config), /outside the inherited/);
});

test('configuration fixes canonical project aliases and only reads redaction names from the operator environment', t => {
  const { config, root } = fixture(t);
  const alias = path.join(root, 'project-alias'); symlinkSync(config.channels.CPROJECT!, alias);
  const result = parseConfig({ ...config, channels: { CPROJECT: alias }, secretEnvNames: ['FIXTURE_SECRET'] });
  assert.equal(result.channels.CPROJECT, config.channels.CPROJECT);
  assert.deepEqual(secretsFromEnvironment(result, { SLACK_BOT_TOKEN: 'fixture-token', FIXTURE_SECRET: 'fixture-secret', UNRELATED: 'do-not-use' }), ['fixture-token', 'fixture-secret']);
  const file = path.join(root, 'config.json'); writeFileSync(file, JSON.stringify(result));
  assert.deepEqual(loadConfig(file), result);
  writeFileSync(file, 'PRIVATE invalid JSON');
  assert.throws(() => loadConfig(file), error => error instanceof Error && !error.message.includes('PRIVATE'));
});

test('project-local Codex configuration cannot silently expand runtime policy', t => {
  const { config } = fixture(t);
  mkdirSync(path.join(config.channels.CPROJECT!, '.codex'));
  writeFileSync(path.join(config.channels.CPROJECT!, '.codex/config.toml'), 'approval_policy="on-request"\n');
  assert.throws(() => checkConfigurationFiles(config, config.channels.CPROJECT!), /Custom or managed/);
});
