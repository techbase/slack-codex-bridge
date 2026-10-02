import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, parseConfig, secretsFromEnvironment } from '../src/config.js';
import { fixture } from './helpers.js';

test('configuration rejects ambiguous routing, obsolete policies, command injection and invalid limits', t => {
  const { config, root } = fixture(t);
  for (const invalid of [
    { teamId: '' }, { allowedUserIds: [] }, { incomingChannelIds: [] }, { operatorUserIds: ['UEVE'] },
    { hostPolicyReviewed: true }, { codexHome: root }, { maxPending: 0 }, { mentionOnly: 'false' },
    { retentionMs: 60_000, queueTtlMs: 61_000 }, { outgoingChannels: { thread: 'COTHER' } },
    { outgoingChannels: { arbitrary: 'not-an-id' } },
    { codex: { ...config.codex, cwd: 'relative' } },
    { codex: { ...config.codex, executable: 'codex; touch /tmp/oops' } },
    { codex: { ...config.codex, args: ['exec', 'a model prompt'] } },
    { codex: { ...config.codex, args: ['--last'] } },
    { codex: { ...config.codex, args: ['--profile'] } },
    { codex: { ...config.codex, sendToolApprovalMode: 'allow-all' } },
    { codex: { ...config.codex, transport: 'shell' } }, { turnTimeoutMs: -1 }, { turnTimeoutMs: 999 },
  ]) assert.throws(() => parseConfig({ ...config, ...invalid }));
  const alias = path.join(root, 'alias'); symlinkSync(config.stateDir, alias);
  assert.throws(() => parseConfig({ ...config, stateDir: alias }), /symlink/);
  chmodSync(config.stateDir, 0o755);
  assert.throws(() => parseConfig(config), /0700/);
});

test('normal configuration and explicit operator permissions are accepted; cwd is canonical and redaction values stay in environment', t => {
  const { config, root } = fixture(t);
  mkdirSync(path.join(config.codex.cwd, '.codex'));
  writeFileSync(path.join(config.codex.cwd, '.codex/config.toml'), 'sandbox_mode="workspace-write"\n');
  const alias = path.join(root, 'project-alias'); symlinkSync(config.codex.cwd, alias);
  const result = parseConfig({ ...config, codex: { ...config.codex, cwd: alias, args: ['--profile', 'slack', '--sandbox', 'workspace-write'] }, secretEnvNames: ['FIXTURE_SECRET'] });
  assert.equal(result.codex.cwd, config.codex.cwd);
  assert.equal(result.mentionOnly, false);
  assert.equal(result.codex.sendToolApprovalMode, undefined);
  for (const mode of ['auto', 'prompt', 'writes', 'approve']) {
    assert.equal(parseConfig({ ...config, codex: { ...config.codex, sendToolApprovalMode: mode } }).codex.sendToolApprovalMode, mode);
  }
  assert.deepEqual(secretsFromEnvironment(result, { SLACK_BOT_TOKEN: 'fixture-token', FIXTURE_SECRET: 'fixture-secret', UNRELATED: 'do-not-use' }), ['fixture-token', 'fixture-secret']);
  const file = path.join(root, 'config.json'); writeFileSync(file, JSON.stringify(result));
  assert.deepEqual(loadConfig(file), result);
  writeFileSync(file, 'PRIVATE invalid JSON');
  assert.throws(() => loadConfig(file), error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.deepEqual(parseConfig({ ...config, outgoingChannels: {} }).outgoingChannels, {});
  assert.equal(parseConfig({ ...config, turnTimeoutMs: 0 }).turnTimeoutMs, 0);
  assert.equal(parseConfig({ ...config, codex: { ...config.codex, transport: 'app-server' } }).codex.transport, 'app-server');
  assert.ok(parseConfig({ ...config, codex: { ...config.codex, args: ['--dangerously-bypass-approvals-and-sandbox'] } }));
});
