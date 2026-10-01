import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/doctor.js';
import { fixture } from './helpers.js';

test('doctor accepts normal fixture config without credentials, a new account or a model turn; no service state mutation', async t => {
  const { config, env } = fixture(t);
  writeFileSync(path.join(env.CODEX_HOME!, 'config.toml'), '[mcp_servers.fixture]\ncommand="fixture-never-run"\n');
  const checks = await doctor(config, env);
  assert.deepEqual(checks.filter(check => !check.ok).map(check => check.check), ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  assert.equal(checks.find(check => check.check === 'Codex CLI')?.ok, true, JSON.stringify(checks));
  assert.equal(existsSync(path.join(config.stateDir, 'bridge.sqlite')), false);
  assert.equal(existsSync(path.join(env.CODEX_HOME!, 'auth.json')), false);
});

test('built doctor command exits nonzero with safe missing-setup messages; startup refuses before Slack connection', async t => {
  const { config, root, env } = fixture(t);
  const file = path.join(root, 'fixture.config.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  for (const args of [['doctor'], []]) {
    await assert.rejects(promisify(execFile)(process.execPath, [main, ...args], {
      cwd: root, env: { ...env, BRIDGE_CONFIG: file }, timeout: 15_000,
    }), error => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      if (args.length) {
        assert.match(result.stdout, /MISSING SLACK_BOT_TOKEN/);
        assert.match(result.stdout, /MISSING SLACK_APP_TOKEN/);
        assert.match(result.stdout, /OK Codex CLI/);
      } else assert.match(result.stderr, /Operator setup is incomplete/);
      assert.doesNotMatch(result.stderr, /at .+\.js:\d/);
      return true;
    });
  }
  assert.equal(existsSync(path.join(config.stateDir, 'bridge.sqlite')), false);
});
