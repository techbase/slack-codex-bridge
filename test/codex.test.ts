import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Codex } from '@openai/codex-sdk';
import { boundaryOverrides, childEnvironment, CodexModel, DISABLED_FEATURES, ModelFailure, preflight, runLocalCli, sdkOptions } from '../src/codex.js';
import { deferred, fixture } from './helpers.js';

test('official SDK invokes fake executable with enforced args, minimal environment, stdin and persisted continuation', async t => {
  const { config, root } = fixture(t);
  const executable = path.join(root, 'fake-codex');
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('../../test/fixtures/fake-codex.cjs', import.meta.url), 'utf8'), { mode: 0o700 });
  const previous = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = 'xoxb-fixture-service-secret';
  t.after(() => { if (previous === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = previous; });
  const sdk = new Codex({ ...sdkOptions(config), codexPathOverride: executable });
  const model = new CodexModel(config, sdk, async () => {});
  const observed: string[] = [];
  const request = { project: config.channels.CPROJECT!, prompt: 'success', signal: new AbortController().signal, onThread: (id: string) => observed.push(id) };
  assert.equal(await model.run(request), 'Only the final answer.');
  assert.deepEqual(observed, ['fixture-thread-0001']);
  assert.equal(await model.run({ ...request, prompt: 'follow-up', threadId: observed[0] }), 'Only the final answer.');
  const captures = readFileSync(path.join(config.codexHome, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(captures.length, 2);
  for (const capture of captures) {
    assert.equal(capture.env.SLACK_BOT_TOKEN, undefined);
    const { __CF_USER_TEXT_ENCODING: macEncoding, ...environment } = capture.env;
    if (macEncoding !== undefined) {
      assert.equal(process.platform, 'darwin');
      assert.match(macEncoding, /^(?:0x[0-9A-Fa-f]+|\d+)(?::(?:0x[0-9A-Fa-f]+|\d+)){2}$/);
    }
    assert.deepEqual(environment, { ...childEnvironment(config), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_sdk_ts' });
    assert.ok(capture.args.includes('read-only'));
    assert.equal(capture.args[capture.args.indexOf('--cd') + 1], config.channels.CPROJECT);
    assert.ok(capture.args.includes('approval_policy="never"'));
    assert.ok(capture.args.includes('web_search="disabled"'));
    assert.ok(capture.args.includes('sandbox_workspace_write.network_access=false'));
    assert.ok(capture.args.includes('features.apps=false'));
    assert.ok(capture.args.includes('features.plugins=false'));
    assert.ok(capture.args.includes('features.hooks=false'));
    assert.ok(capture.args.includes('orchestrator.mcp.enabled=false'));
    const guidance = capture.args.find((arg: string) => arg.startsWith('developer_instructions='));
    assert.match(guidance, /state uncertainty or missing evidence/);
    assert.match(guidance, /concise final answer/);
    assert.ok(!capture.args.includes('--skip-git-repo-check'));
    assert.ok(!capture.args.includes('--add-dir'));
    for (const override of boundaryOverrides()) assert.ok(capture.args.includes(override));
  }
  assert.equal(captures[0].input, 'success');
  assert.equal(captures[0].args.includes('resume'), false);
  assert.equal(captures[1].args[captures[1].args.indexOf('resume') + 1], 'fixture-thread-0001');
  assert.equal(captures[1].input, 'follow-up');
});

test('official SDK stream failures, absent/malformed completion and oversized final data fail without provider leakage', async t => {
  const { config, root } = fixture(t);
  const executable = path.join(root, 'fake-codex');
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('../../test/fixtures/fake-codex.cjs', import.meta.url), 'utf8'), { mode: 0o700 });
  const model = new CodexModel(config, new Codex({ ...sdkOptions(config), codexPathOverride: executable }), async () => {});
  for (const prompt of ['failed', 'empty', 'missing-completion', 'malformed-completion', 'invalid-json', 'exit-failure', 'oversize']) {
    await assert.rejects(model.run({ project: config.channels.CPROJECT!, prompt, signal: new AbortController().signal, onThread() {} }), error => {
      assert.ok(error instanceof ModelFailure);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    }, prompt);
  }
});

test('official SDK AbortSignal stops fake process work after an early persisted thread ID', async t => {
  const { config, root } = fixture(t);
  const executable = path.join(root, 'fake-codex');
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('../../test/fixtures/fake-codex.cjs', import.meta.url), 'utf8'), { mode: 0o700 });
  const model = new CodexModel(config, new Codex({ ...sdkOptions(config), codexPathOverride: executable }), async () => {});
  const started = deferred<string>();
  const controller = new AbortController();
  const running = model.run({ project: config.channels.CPROJECT!, prompt: 'cancel', signal: controller.signal, onThread: started.resolve });
  const rejected = assert.rejects(running, ModelFailure);
  assert.equal(await started.promise, 'fixture-thread-0001');
  controller.abort(); await rejected;
  // PID disappearance is not the SDK's synchronization contract. This child
  // marker proves its signal handler stopped the simulated work, without an
  // arbitrary sleep or an assumption about when Node reaps the PID.
  assert.equal(readFileSync(path.join(config.codexHome, 'stopped'), 'utf8'), 'No model work remains.');
});

test('pinned real CLI verifies supported disabled features and no enabled MCPs without auth or a model call', async t => {
  const { config } = fixture(t);
  await preflight(config, config.channels.CPROJECT!);
  const features = await runLocalCli(config, config.channels.CPROJECT!, ['features', 'list']);
  for (const name of DISABLED_FEATURES) assert.match(features, new RegExp(`^${name}\\s+.+\\sfalse$`, 'm'));
  assert.deepEqual(JSON.parse(await runLocalCli(config, config.channels.CPROJECT!, ['mcp', 'list', '--json'])), []);
  writeFileSync(path.join(config.codexHome, 'config.toml'), '[mcp_servers.fixture]\ncommand="/fixture/never-execute"\n');
  await assert.rejects(preflight(config, config.channels.CPROJECT!), /Custom or managed/);
  const merged = JSON.parse(await runLocalCli(config, config.channels.CPROJECT!, ['-c', 'mcp_servers={}', 'mcp', 'list', '--json']));
  assert.equal(merged[0]?.name, 'fixture');
  assert.equal(merged[0]?.enabled, true, 'An empty override is not an MCP disable switch.');
});
