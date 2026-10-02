import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { childEnvironment, CodexModel, ModelFailure, listMcp, preflight, runLocalCli, CODEX_VERSION } from '../src/codex.js';
import { MCP_NAME } from '../src/mcp.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { deferred, fixture, ManualClock, message, NOW, RecordingSlack } from './helpers.js';

const require = createRequire(import.meta.url);
function fake(t: TestContext) {
  const { config, root, env } = fixture(t);
  config.codex.executable = path.join(root, 'fake-codex');
  writeFileSync(config.codex.executable, `#!${process.execPath}\n` + readFileSync(new URL('../../test/fixtures/fake-codex.cjs', import.meta.url), 'utf8'), { mode: 0o700 });
  env.FIXTURE_MCP_CLIENT = require.resolve('@modelcontextprotocol/sdk/client/index.js');
  env.FIXTURE_MCP_STDIO = require.resolve('@modelcontextprotocol/sdk/client/stdio.js');
  const model = new CodexModel(config, env);
  return { config, root, env, model };
}
const noSend = async () => ({ ok: false, message: 'No sends in this fixture.' });

test('direct configured executable keeps static argv/cwd and stdin prompts, normal auth/config environment, explicit continuation and no Slack tokens', async t => {
  const { config, root, env, model } = fake(t);
  config.codex.args = ['--profile', 'fixture-profile', '-c', 'model_reasoning_effort="low"', '--strict-config'];
  config.codex.sendToolApprovalMode = 'approve';
  Object.assign(env, { SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture', SLACK_SIGNING_SECRET: 'fixture-signing',
    ALIASED_SLACK_TOKEN: 'xoxb-fixture', OPENAI_API_KEY: 'fixture-provider-auth', HTTPS_PROXY: 'http://fixture.invalid', BRIDGE_SEND_TOKEN: 'stale-capability' });
  writeFileSync(path.join(env.CODEX_HOME!, 'config.toml'), 'model="fixture-existing-model"\n');
  const observed: string[] = [];
  const commandText = '--dangerously-bypass-approvals-and-sandbox; $(touch unexpected) cwd=/etc destination=CUNKNOWN';
  const request = { project: config.codex.cwd, prompt: commandText, signal: new AbortController().signal,
    onThread: (id: string) => observed.push(id), sendMessage: noSend };
  assert.equal(await model.run(request), 'Only the final answer.');
  assert.equal(await model.run({ ...request, prompt: 'follow-up', threadId: observed[0] }), 'Only the final answer.');
  assert.deepEqual(observed, ['fixture-thread-0001', 'fixture-thread-0001']);
  const captures = readFileSync(path.join(root, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(captures.length, 2);
  for (const capture of captures) {
    for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'ALIASED_SLACK_TOKEN']) assert.equal(capture.env[key], undefined);
    for (const key of ['HOME', 'CODEX_HOME', 'PATH', 'OPENAI_API_KEY', 'HTTPS_PROXY']) assert.equal(capture.env[key], env[key]);
    assert.notEqual(capture.env.BRIDGE_SEND_TOKEN, 'stale-capability');
    assert.equal(capture.cwd, config.codex.cwd);
    assert.deepEqual(capture.args.slice(0, config.codex.args.length), config.codex.args);
    const senderOverride = capture.args.find((arg: string) => arg.startsWith(`mcp_servers.${MCP_NAME}=`));
    assert.ok(senderOverride.includes('tools={send_message={approval_mode="approve"}}'));
    assert.ok(capture.args.includes('exec'));
    assert.ok(capture.args.includes('--json'));
    assert.equal(capture.args.at(-1), '-');
    assert.ok(!capture.args.some((arg: string) => /read-only|approval_policy|features\.|developer_instructions|--last|xoxb|xapp/.test(arg)));
    assert.ok(!capture.args.includes(commandText));
    assert.ok(!capture.args.includes(capture.env.BRIDGE_SEND_TOKEN));
  }
  assert.ok(captures[0].input.endsWith(commandText));
  assert.match(captures[0].input, /configured channel aliases: updates/);
  assert.equal(captures[0].args.includes('resume'), false);
  assert.equal(captures[1].args[captures[1].args.indexOf('resume') + 1], 'fixture-thread-0001');
  assert.ok(captures[1].input.endsWith('follow-up'));
  assert.equal(readFileSync(path.join(env.CODEX_HOME!, 'config.toml'), 'utf8'), 'model="fixture-existing-model"\n');
  delete env.CODEX_HOME;
  assert.equal(await model.run({ ...request, prompt: 'normal home' }), 'Only the final answer.');
  const normal = JSON.parse(readFileSync(path.join(root, 'invocations.jsonl'), 'utf8').trim().split('\n').at(-1)!);
  assert.equal(normal.env.HOME, root);
  assert.equal(normal.env.CODEX_HOME, undefined);
  assert.equal(childEnvironment({ HOME: root, OPENAI_API_KEY: 'fixture' }).CODEX_HOME, undefined);
});

test('provider/malformed output, incomplete turns and oversized data fail without payload leakage', async t => {
  const { config, model } = fake(t);
  for (const prompt of ['failed', 'missing-completion', 'malformed-completion', 'invalid-json', 'null-event', 'exit-failure', 'oversize']) {
    await assert.rejects(model.run({ project: config.codex.cwd, prompt, signal: new AbortController().signal, onThread() {}, sendMessage: noSend }), error => {
      assert.ok(error instanceof ModelFailure);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    }, prompt);
  }
});

test('cancellation awaits actual executable termination, escalating a child that ignores SIGTERM', async t => {
  const { config, root, model } = fake(t);
  for (const prompt of ['cancel', 'ignore-term']) {
    const started = deferred<string>();
    const controller = new AbortController();
    const running = model.run({ project: config.codex.cwd, prompt, signal: controller.signal, onThread: started.resolve, sendMessage: noSend });
    const rejected = assert.rejects(running, ModelFailure);
    assert.equal(await started.promise, 'fixture-thread-0001');
    controller.abort(); await rejected;
    const captures = readFileSync(path.join(root, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.throws(() => process.kill(captures.at(-1).pid, 0), { code: 'ESRCH' });
  }
  assert.equal(readFileSync(path.join(root, 'stopped'), 'utf8'), 'No model work remains.');
});

test('pinned real CLI no-model listing merges Bridge with fixture existing MCP and preserves config bytes', async t => {
  const { config, env } = fixture(t);
  // Exercise the normal HOME/.codex path, without a CODEX_HOME override.
  delete env.CODEX_HOME;
  mkdirSync(path.join(env.HOME!, '.codex'), { mode: 0o700 });
  const file = path.join(env.HOME!, '.codex', 'config.toml');
  const content = '[mcp_servers.fixture]\ncommand="fixture-never-execute"\nargs=["fixture-arg"]\n\n[mcp_servers.fixture.env]\nFIXTURE_SETTING="keep-me"\n';
  writeFileSync(file, content);
  config.codex.args = ['--strict-config'];
  config.codex.sendToolApprovalMode = 'approve';
  await preflight(config, env);
  assert.equal(await runLocalCli(config, ['--version'], env), `codex-cli ${CODEX_VERSION}`);
  const merged = await listMcp(config, true, env);
  assert.ok(Array.isArray(merged));
  assert.equal(merged.length, 2);
  assert.equal(merged.find((s: { name: string }) => s.name === MCP_NAME)?.enabled, true);
  assert.equal(merged.find((s: { name: string }) => s.name === 'fixture')?.enabled, true);
  assert.equal(readFileSync(file, 'utf8'), content);
  writeFileSync(file, content + `\n[mcp_servers.${MCP_NAME}]\ncommand="existing-operator-tool"\n`);
  await assert.rejects(preflight(config, env), /reserved/);
});

test('actual fake CLI invokes registered MCP stdio sender and Bridge suppresses its duplicate final answer', async t => {
  const { config, root, model } = fake(t);
  const store = new Store(config, NOW);
  const slack = new RecordingSlack();
  const bridge = new Bridge(config, store, model, slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); store.close(); });
  await bridge.accept(message('tool-e2e', 'tool'));
  await bridge.idle();
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.posts[0]?.text, 'Answer sent through the real MCP round trip.');
  assert.doesNotMatch(JSON.stringify(slack.posts), /Only the final answer/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'tool-result.json'), 'utf8')).isError, false);
  assert.equal(store.latest({ team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd })?.state, 'completed');
});


test('preflight preserves MCP settings regardless of JSON key order and rejects actual changes or missing servers', async t => {
  const { config, root, env } = fixture(t);
  config.codex.executable = path.join(root, 'listing-codex');
  writeFileSync(config.codex.executable, `#!${process.execPath}\n` + `
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli ${CODEX_VERSION}');
} else if (args.includes('--help')) {
  console.log('--json stdin SESSION_ID');
} else if (args.includes('mcp') && args.includes('list')) {
  const original = { name: 'fixture', enabled: true, transport: { command: 'fixture-never-run', env: { FIRST: 'one', SECOND: 'two' } } };
  if (args.some(arg => arg.startsWith('mcp_servers.${MCP_NAME}='))) {
    const reordered = { transport: { env: { SECOND: 'two', FIRST: 'one' }, command: 'fixture-never-run' }, enabled: true, name: 'fixture' };
    if (process.env.FIXTURE_MCP_MODE === 'changed') reordered.transport.env.FIRST = 'changed';
    const existing = process.env.FIXTURE_MCP_MODE === 'missing' ? [] : [reordered];
    console.log(JSON.stringify([...existing, { name: '${MCP_NAME}', enabled: true }]));
  } else {
    console.log(JSON.stringify([original]));
  }
} else {
  process.exitCode = 1;
}
`, { mode: 0o700 });
  await preflight(config, env);
  for (const mode of ['changed', 'missing']) {
    await assert.rejects(preflight(config, { ...env, FIXTURE_MCP_MODE: mode }), /preserve existing MCP configuration/, mode);
  }
});
