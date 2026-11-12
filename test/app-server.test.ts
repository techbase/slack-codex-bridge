import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { AppServer, AppServerModel } from '../src/app-server.js';
import { Bridge } from '../src/bridge.js';
import { ModelFailure, preflight } from '../src/codex.js';
import { Store } from '../src/store.js';
import { deferred, fixture, ManualClock, message, NOW, RecordingSlack } from './helpers.js';

function fake(t: TestContext) {
  const f = fixture(t);
  f.config.codex.transport = 'app-server';
  f.config.codex.executable = path.join(f.root, 'fake-app-server');
  writeFileSync(f.config.codex.executable, `#!${process.execPath}\n` + readFileSync(new URL('../../test/fixtures/fake-app-server.cjs', import.meta.url), 'utf8'), { mode: 0o700 });
  const model = new AppServerModel(f.config, f.env);
  return { ...f, model, records: () => readFileSync(path.join(f.root, 'rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
const noSend = async () => ({ ok: false, message: 'No live sends.' });

test('native sessions preserve configured argv, normal auth/environment, explicit IDs and effective permissions on resume', async t => {
  const { config, env, model, records } = fake(t);
  config.codex.args = ['--profile', 'fictional', '-c', 'approval_policy="on-request"'];
  Object.assign(env, { SLACK_BOT_TOKEN: 'xoxb-fictional', SLACK_APP_TOKEN: 'xapp-fictional', OPENAI_API_KEY: 'fictional-auth' });
  const ids: string[] = [];
  const request = { parentContext: { parentTs: '1800000000.000001', replyTs: '1800000000.000002', status: 'available' as const, text: 'Own-bot proposal: review Fixture Widget release notes.' }, project: config.codex.cwd, prompt: 'first', signal: new AbortController().signal, onThread: (id: string) => ids.push(id), sendMessage: noSend };
  assert.equal(await model.run(request), 'Native final answer.');
  assert.equal(await model.run({ ...request, threadId: ids[0], prompt: 'follow-up' }), 'Native final answer.');
  assert.deepEqual(ids, ['fixture-native-0001', 'fixture-native-0001']);
  const starts = records().filter(r => r.start).map(r => r.start);
  for (const start of starts) {
    assert.deepEqual(start.args.slice(0, config.codex.args.length), config.codex.args);
    assert.equal(start.args.at(-1), 'app-server');
    assert.equal(start.env.OPENAI_API_KEY, env.OPENAI_API_KEY);
    assert.equal(start.env.HOME, env.HOME);
    assert.equal(start.env.SLACK_BOT_TOKEN, undefined);
    assert.equal(start.env.SLACK_APP_TOKEN, undefined);
    assert.equal(start.cwd, config.codex.cwd);
    assert.throws(() => process.kill(start.pid, 0), { code: 'ESRCH' });
  }
  assert.match(records().find(r => r.method === 'turn/start').params.input[0].text, /Own-bot proposal: review Fixture Widget release notes/);
  const resume = records().find(r => r.method === 'thread/resume');
  assert.equal(resume.params.threadId, ids[0]);
  assert.equal(resume.params.excludeTurns, true);
  assert.equal(resume.params.approvalPolicy, 'on-request');
  assert.equal(resume.params.approvalsReviewer, 'user');
  assert.equal(records().filter(r => r.method === 'turn/start')[1].params.input[0].text.endsWith('follow-up'), true);
});

test('native approvals, file changes, permission grants, questions and MCP forms receive explicit human responses', async t => {
  const { config, model, records } = fake(t);
  for (const prompt of ['approval', 'files', 'permissions', 'question', 'form']) {
    assert.equal(await model.run({ project: config.codex.cwd, prompt, signal: new AbortController().signal, onThread() {}, sendMessage: noSend,
      interact: async (interaction, signal) => {
        assert.equal(signal.aborted, false);
        if (prompt === 'question') { assert.equal(interaction.parse('answer', '99'), undefined); return interaction.parse('answer', '2'); }
        if (prompt === 'form') {
          assert.equal(interaction.parse('approve', ''), undefined);
          assert.equal(interaction.parse('answer', '{}'), undefined);
          assert.equal(interaction.parse('answer', '{"decision":"invalid"}'), undefined);
          return interaction.parse('answer', '{"decision":"accept"}');
        }
        assert.equal(interaction.parse('answer', 'yes'), undefined);
        return interaction.parse('approve', '');
      } }), 'Native final answer.');
  }
  assert.deepEqual(records().filter(r => r.answer).map(r => r.answer), [
    { decision: 'accept' }, { decision: 'accept' }, { permissions: { network: { enabled: true } }, scope: 'turn' },
    { answers: { choice: { answers: ['Two'] } } }, { action: 'accept', content: { decision: 'accept' }, _meta: null },
  ]);
});

test('plain human replies answer native questions and denials without starting another turn; cancelled prompts expire', async t => {
  const { config, model, records } = fake(t);
  const store = new Store(config, NOW);
  const slack = new RecordingSlack();
  let promptPosted = deferred();
  const original = slack.post.bind(slack);
  slack.post = async post => { await original(post); if (/Prompt:/.test(post.text)) promptPosted.resolve(); };
  const bridge = new Bridge(config, store, model, slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); store.close(); });
  await bridge.accept(message('ask-question', 'question'));
  await promptPosted.promise;
  await bridge.accept(message('plain-answer', '2', { thread_ts: '1800000000.000001' }));
  await bridge.idle();
  assert.deepEqual(records().filter(r => r.answer).map(r => r.answer), [{ answers: { choice: { answers: ['Two'] } } }]);
  promptPosted = deferred();
  await bridge.accept(message('ask-again', 'approval', { thread_ts: '1800000000.000001' }));
  await promptPosted.promise;
  await bridge.accept(message('plain-deny', 'deny', { thread_ts: '1800000000.000001', user: 'UOPERATOR' }));
  await bridge.idle();
  assert.deepEqual(records().filter(r => r.answer).at(-1).answer, { decision: 'decline' });
  promptPosted = deferred();
  await bridge.accept(message('ask-cancel', 'approval', { thread_ts: '1800000000.000001' }));
  await promptPosted.promise;
  const id = /Prompt: ([a-f0-9]{24})/.exec(slack.posts.at(-1)!.text)![1];
  await bridge.accept(message('cancel-wait', 'cancel', { thread_ts: '1800000000.000001' }));
  await bridge.idle();
  await bridge.accept(message('stale-approval', `approve ${id}`, { thread_ts: '1800000000.000001' }));
  assert.match(slack.posts.at(-1)!.text, /No matching live prompt/);
  assert.equal(records().filter(r => r.method === 'turn/start').length, 3);
  assert.equal(records().filter(r => r.answer).length, 2);
});

test('native question identifiers remain opaque data when constructing answer maps', async t => {
  const { config, model, records } = fake(t);
  await model.run({ project: config.codex.cwd, prompt: 'question-key', signal: new AbortController().signal, onThread() {}, sendMessage: noSend,
    interact: async prompt => prompt.parse('answer', '2') });
  const answer = records().find(r => r.answer).answer.answers;
  assert.equal(Object.hasOwn(answer, '__proto__'), true);
  assert.deepEqual(answer['__proto__'], { answers: ['Two'] });
});

test('uncertain approval delivery stops the native turn without approving or retrying', async t => {
  const { config, model, records } = fake(t);
  const store = new Store(config, NOW);
  const slack = new RecordingSlack(); slack.failOn = 1;
  const bridge = new Bridge(config, store, model, slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); store.close(); });
  await bridge.accept(message('uncertain-prompt', 'approval'));
  await bridge.idle();
  assert.equal(records().filter(r => r.answer).length, 0);
  const job = store.latest({ team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd })!;
  assert.equal(job.state, 'failed'); assert.equal(job.delivery, 'uncertain');
});

test('unsupported, secret, mismatched and failed protocol interactions fail without approval or provider leakage', async t => {
  const { config, model, records } = fake(t);
  for (const prompt of ['unknown', 'secret', 'wrong-thread', 'malformed', 'failed', 'exit-failure']) {
    await assert.rejects(model.run({ project: config.codex.cwd, prompt, signal: new AbortController().signal, onThread() {}, sendMessage: noSend,
      interact: async () => { assert.fail('No unauthorized interaction should reach Slack'); } }), error => error instanceof ModelFailure && !error.message.includes('PRIVATE'), prompt);
  }
  assert.equal(records().filter(r => r.answer).length, 0);
});

test('cancellation and server resolution discard pending approvals and await process exit', async t => {
  const { config, model, records } = fake(t);
  const controller = new AbortController();
  const asked = deferred();
  const running = model.run({ project: config.codex.cwd, prompt: 'approval', signal: controller.signal, onThread() {}, sendMessage: noSend,
    interact: (_, signal) => { asked.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } });
  const rejected = assert.rejects(running, ModelFailure);
  await asked.promise; controller.abort(); await rejected;
  let resolved = false;
  await model.run({ project: config.codex.cwd, prompt: 'resolved', signal: new AbortController().signal, onThread() {}, sendMessage: noSend,
    interact: (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { resolved = true; reject(new Error('resolved')); }, { once: true })) });
  assert.equal(resolved, true);
  assert.equal(records().filter(r => r.answer).length, 0);
  for (const start of records().filter(r => r.start).map(r => r.start)) assert.throws(() => process.kill(start.pid, 0), { code: 'ESRCH' });
});

test('native cancellation waits for exit and kills a process that ignores termination', async t => {
  const { config, model, records } = fake(t);
  const asked = deferred(); const controller = new AbortController();
  const running = model.run({ project: config.codex.cwd, prompt: 'ignore-term-approval', signal: controller.signal, onThread() {}, sendMessage: noSend,
    interact: (_, signal) => { asked.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } });
  const rejected = assert.rejects(running, ModelFailure);
  await asked.promise; controller.abort(); await rejected;
  assert.throws(() => process.kill(records().filter(r => r.start).at(-1).start.pid, 0), { code: 'ESRCH' });
});

test('real pinned app-server initializes and reads layered config without a model or changing configuration', async t => {
  const { config, env } = fixture(t);
  config.codex.transport = 'app-server';
  config.codex.args = ['-c', 'approval_policy="on-request"', '-c', 'sandbox_workspace_write.network_access=true'];
  const file = path.join(env.CODEX_HOME!, 'config.toml');
  const content = 'model_reasoning_effort="low"\n';
  writeFileSync(file, content);
  await preflight(config, env);
  const rpc = new AppServer(config, Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)), AbortSignal.timeout(10_000));
  try {
    await rpc.initialize();
    const response = await rpc.request('config/read', { cwd: config.codex.cwd, includeLayers: false });
    assert.equal(response.config.approval_policy, 'on-request');
    assert.equal(response.config.sandbox_workspace_write.network_access, true);
    assert.equal(response.config.model_reasoning_effort, 'low');
  } finally { await rpc.close(); }
  assert.equal(readFileSync(file, 'utf8'), content);
});

test('Slack thread replies resolve native prompts once; other users/threads, malformed and obsolete replies do not launch work', async t => {
  const { config, model, records } = fake(t);
  config.turnTimeoutMs = 0;
  const store = new Store(config, NOW);
  const posted = deferred<string>();
  const slack = new RecordingSlack();
  const original = slack.post.bind(slack);
  slack.post = async post => { await original(post); const id = /Prompt: ([a-f0-9]{24})/.exec(post.text)?.[1]; if (id) posted.resolve(id); };
  const clock = new ManualClock();
  const bridge = new Bridge(config, store, model, slack, [], () => {}, clock);
  t.after(async () => { await bridge.shutdown(); store.close(); });
  await bridge.accept(message('native-start', 'approval'));
  const id = await posted.promise;
  await bridge.accept(message('wrong-user', `approve ${id}`, { user: 'UBOB', thread_ts: '1800000000.000001' }));
  await bridge.accept(message('wrong-thread', `approve ${id}`, { thread_ts: '1800000000.000002' }));
  await bridge.accept(message('bad-answer', `approve ${id} anything-extra`, { thread_ts: '1800000000.000001' }));
  assert.equal(records().filter(r => r.answer).length, 0);
  await bridge.accept(message('prompt-status', 'status', { thread_ts: '1800000000.000001' }));
  assert.match(slack.posts.at(-1)!.text, /Waiting for your response/);
  clock.advance(1_800_001); // Explicit zero deadline preserves a waiting native session.
  await bridge.accept(message('human-answer', `approve ${id}`, { thread_ts: '1800000000.000001' }));
  await bridge.accept(message('duplicate-answer', `approve ${id}`, { thread_ts: '1800000000.000001' }));
  await bridge.idle();
  assert.deepEqual(records().filter(r => r.answer).map(r => r.answer), [{ decision: 'accept' }]);
  assert.equal(records().filter(r => r.method === 'turn/start').length, 1);
  assert.match(JSON.stringify(slack.posts), /Native final answer/);
  assert.doesNotMatch(JSON.stringify(slack.posts), /PRIVATE/);
});


function waitingBridge(t: TestContext, capacity?: number) {
  const f = fake(t);
  f.config.turnTimeoutMs = 0;
  if (capacity !== undefined) f.config.maxPending = capacity;
  const store = new Store(f.config, NOW), slack = new RecordingSlack(), posted = deferred<string>();
  const post = slack.post.bind(slack);
  slack.post = async value => { await post(value); const id = /Prompt: ([a-f0-9]{24})/.exec(value.text)?.[1]; if (id) posted.resolve(id); };
  const bridge = new Bridge(f.config, store, f.model, slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); store.close(); });
  const scope = { team: f.config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: f.config.codex.cwd };
  return { ...f, store, slack, posted, bridge, scope };
}

test('ordinary follow-ups withdraw every native approval family and resume the same chat without granting or replaying', async t => {
  for (const kind of ['approval', 'files', 'permissions', 'url']) await t.test(kind, async t => {
    const f = waitingBridge(t);
    await f.bridge.accept(message('start', kind));
    const id = await f.posted.promise;
    const prior = f.store.latest(f.scope)!;
    const question = 'Where? It is connected online and on my other Mac.';
    const event = message('followup', question, { thread_ts: f.scope.root, ts: '1800000000.000002' });
    await f.bridge.accept(event);
    await f.bridge.idle();
    const records = f.records();
    assert.equal(records.filter(r => r.answer).length, 0);
    assert.equal(records.filter(r => r.method === 'turn/start').length, 2);
    assert.ok(records.filter(r => r.method === 'turn/start')[1].params.input[0].text.endsWith(question));
    assert.equal(records.find(r => r.method === 'thread/resume').params.threadId, 'fixture-native-0001');
    assert.equal(f.store.job(prior.id)?.state, 'interrupted');
    assert.equal(f.store.job(prior.id)?.reason, 'followup');
    assert.match(f.slack.posts.map(p => p.text).join('\n'), /approval was withdrawn; no permission was granted/);
    assert.doesNotMatch(f.slack.posts.map(p => p.text).join('\n'), /Invalid prompt response/);
    assert.throws(() => process.kill(records.find(r => r.start).start.pid, 0), { code: 'ESRCH' });
    await f.bridge.accept(event);
    await f.bridge.accept(message('obsolete', 'approve ' + id, { thread_ts: f.scope.root }));
    assert.equal(f.records().filter(r => r.method === 'turn/start').length, 2);
    assert.match(f.slack.posts.at(-1)!.text, /No matching live prompt/);
  });
});

test('another user and rejected oversized follow-ups cannot interrupt a waiting approval; an operator can', async t => {
  const f = waitingBridge(t);
  await f.bridge.accept(message('start', 'approval'));
  await f.posted.promise;
  await f.bridge.accept(message('other-user', 'Why is it waiting?', { thread_ts: f.scope.root, user: 'UBOB' }));
  assert.match(f.slack.posts.at(-1)!.text, /Only the requester or a configured operator/);
  await f.bridge.accept(message('too-long', 'x'.repeat(f.config.maxInputChars + 1), { thread_ts: f.scope.root }));
  assert.match(f.slack.posts.at(-1)!.text, /Request too long/);
  assert.equal(f.records().filter(r => r.method === 'turn/start').length, 1);
  assert.equal(f.store.latest(f.scope)?.state, 'active');
  await f.bridge.accept(message('operator', 'Explain the blocker.', { thread_ts: f.scope.root, user: 'UOPERATOR' }));
  await f.bridge.idle();
  assert.equal(f.records().filter(r => r.method === 'turn/start').length, 2);
  assert.equal(f.records().filter(r => r.answer).length, 0);
});

test('a full queue does not withdraw an approval before the follow-up is admitted', async t => {
  const f = waitingBridge(t, 1);
  await f.bridge.accept(message('start', 'approval'));
  const id = await f.posted.promise;
  await f.bridge.accept(message('full', 'Why?', { thread_ts: f.scope.root }));
  assert.match(f.slack.posts.at(-1)!.text, /queue is full/);
  assert.equal(f.store.latest(f.scope)?.state, 'active');
  await f.bridge.accept(message('answer', 'deny ' + id, { thread_ts: f.scope.root }));
  await f.bridge.idle();
  assert.deepEqual(f.records().filter(r => r.answer).map(r => r.answer), [{ decision: 'decline' }]);
  assert.equal(f.records().filter(r => r.method === 'turn/start').length, 1);
});

test('invalid native question and form answers remain input validation, with no implicit interruption', async t => {
  for (const kind of ['question', 'form']) await t.test(kind, async t => {
    const f = waitingBridge(t);
    await f.bridge.accept(message('start', kind));
    await f.posted.promise;
    await f.bridge.accept(message('bad-input', 'not a valid answer', { thread_ts: f.scope.root }));
    assert.match(f.slack.posts.at(-1)!.text, /Invalid prompt response/);
    assert.equal(f.store.latest(f.scope)?.state, 'active');
    await f.bridge.accept(message('valid-input', kind === 'question' ? '2' : '{"decision":"accept"}', { thread_ts: f.scope.root }));
    await f.bridge.idle();
    assert.equal(f.records().filter(r => r.method === 'turn/start').length, 1);
    assert.equal(f.records().filter(r => r.answer).length, 1);
  });
});


test('uncertain attachment-notice delivery does not withdraw the waiting approval or execute the follow-up', async t => {
  const f = waitingBridge(t);
  await f.bridge.accept(message('start', 'approval'));
  const id = await f.posted.promise;
  f.slack.failOn = f.slack.posts.length + 1;
  await f.bridge.accept(message('attachment-followup', 'Explain this.', { thread_ts: f.scope.root, subtype: 'file_share', files: [{ id: 'FFICTURE' }] }));
  const pending = f.store.inScope(f.scope);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.state, 'active');
  await f.bridge.accept(message('answer', 'deny ' + id, { thread_ts: f.scope.root }));
  await f.bridge.idle();
  assert.equal(f.records().filter(r => r.method === 'turn/start').length, 1);
  assert.deepEqual(f.records().filter(r => r.answer).map(r => r.answer), [{ decision: 'decline' }]);
});
