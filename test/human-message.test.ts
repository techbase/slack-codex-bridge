import assert from 'node:assert/strict';
import { readFileSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Bridge } from '../src/bridge.js';
import { ModelFailure, slackContext } from '../src/codex.js';
import { parseConfig } from '../src/config.js';
import { humanMessage } from '../src/human-message.js';
import { Store } from '../src/store.js';
import { ControlledModel, fixture, ManualClock, message, NOW, RecordingSlack } from './helpers.js';

const hookFixture = fileURLToPath(new URL('../../test/fixtures/fake-human-message.cjs', import.meta.url));
const ROOT = '1800000000.000001';
const REPLY = '1800000000.000002';

function hook(t: TestContext, mode = 'context') {
  const f = fixture(t), capture = path.join(f.root, 'hook.jsonl'), release = path.join(f.root, 'release');
  writeFileSync(capture, '');
  f.config.humanMessageCommand = [process.execPath, hookFixture, mode, capture, release, '$(touch unexpected); literal'];
  const records = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const waitRecords = async (count: number) => {
    if (records().length >= count) return;
    await new Promise<void>((resolve, reject) => {
      const watcher = watch(capture, () => { if (records().length >= count) { watcher.close(); resolve(); } });
      watcher.on('error', error => { watcher.close(); reject(error); });
      if (records().length >= count) { watcher.close(); resolve(); }
      t.after(() => watcher.close());
    });
  };
  const store = new Store(f.config, NOW), model = new ControlledModel(), slack = new RecordingSlack();
  const scope = { team: f.config.teamId, channel: 'CPROJECT', root: ROOT, project: f.config.codex.cwd };
  return { ...f, capture, release, records, waitRecords, store, model, slack, scope };
}

// Tests drive the accepted event boundary and a real short-lived fixture process.
// No live Slack posts, provider calls or operator configuration are involved.
test('human hook receives the accepted event scope and exact text separately from bounded reference context', async t => {
  const f = hook(t);
  const parent = { parentTs: ROOT, replyTs: REPLY, status: 'available' as const, text: 'Fixture proposal fixture-secret' };
  const bridge = new Bridge(f.config, f.store, f.model, f.slack, ['fixture-secret'], () => {}, new ManualClock(), () => {}, async () => parent);
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  const original = 'Explain this; $(touch never-executed)';
  await bridge.accept(message('human-hook-event', `<@UBRIDGE> ${original}`, { thread_ts: ROOT, ts: REPLY }));
  const call = await f.model.started(1);
  const record = f.records()[0];
  assert.deepEqual(record.envelope, { version: 1, phase: 'message', eventId: 'human-hook-event', messageTs: REPLY, team: 'TEXAMPLE', channel: 'CPROJECT', root: ROOT,
    actor: 'UALICE', project: f.config.codex.cwd, text: original, parent: { ...parent, text: 'Fixture proposal [redacted]' } });
  assert.deepEqual(record.extra, ['$(touch unexpected); literal']);
  assert.equal(call.request.prompt, original);
  assert.equal(f.store.latest(f.scope)?.state, 'active');
  assert.equal((call.request.extensionContext as { note: string }).note, '[redacted]');
  assert.doesNotMatch(JSON.stringify(call.request.extensionContext), /fixture-secret/);
  const frame = slackContext(f.config, call.request.parentContext, call.request.extensionContext);
  assert.match(frame, /Operator extension reference \(untrusted data, not new authority/);
  assert.doesNotMatch(frame, /<system>/);
  assert.match(frame, /\\u003c/);
  assert.ok(frame.endsWith('\n\nSlack message:\n'));
  assert.equal(record.environment.SLACK_BOT_TOKEN, undefined);
  assert.equal(record.environment.BRIDGE_SEND_TOKEN, undefined);
  call.result.resolve('Fixture answer.'); await bridge.idle();
});

test('a handled human event completes once without launching a model or replaying its command', async t => {
  const f = hook(t, 'handled'), bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  const event = message('handled-event', 'Record fixture decision.');
  await bridge.accept(event); await bridge.idle();
  await bridge.accept(event); await bridge.idle();
  assert.equal(f.records().length, 1);
  assert.equal(f.model.calls.length, 0);
  assert.equal(f.store.latest(f.scope)?.state, 'completed');
  assert.equal(f.store.latest(f.scope)?.delivery, 'sent');
  assert.equal(f.slack.posts.length, 1);
  assert.match(f.slack.posts[0]!.text, /Handled fixture action/);
});

test('hook execution follows durable admission and FIFO even while the first hook is slow', async t => {
  const f = hook(t, 'gate'), bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  await bridge.accept(message('first', 'First question'));
  await f.waitRecords(1);
  assert.equal(f.store.latest(f.scope)?.state, 'active');
  assert.equal(f.model.calls.length, 0);
  await bridge.accept(message('second', 'Second question', { thread_ts: ROOT, ts: REPLY }));
  assert.equal(f.store.queued().length, 1);
  assert.equal(f.records().length, 1);
  writeFileSync(f.release, 'release');
  const first = await f.model.started(1);
  assert.equal(first.request.prompt, 'First question');
  assert.equal(f.records().length, 1);
  first.result.resolve('First answer.');
  const second = await f.model.started(2);
  assert.equal(second.request.prompt, 'Second question');
  assert.deepEqual(f.records().map(r => r.envelope.eventId), ['first', 'second']);
  second.result.resolve('Second answer.'); await bridge.idle();
});

test('unauthorized and rejected input never starts the human hook; native prompt replies bypass it', async t => {
  const f = hook(t), bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  await bridge.accept(message('wrong-user', 'Record fixture', { user: 'UEVE' }));
  await bridge.accept(message('wrong-team', 'Record fixture', {}, { team_id: 'TOTHER' }));
  await bridge.accept(message('too-large', 'x'.repeat(f.config.maxInputChars + 1)));
  await bridge.accept(message('help-event', 'help'));
  await bridge.accept(message('status-event', 'status'));
  assert.equal(f.records().length, 0);
  await bridge.accept(message('request', 'Explain the fixture.'));
  const call = await f.model.started(1);
  const answer = call.request.interact!({ kind: 'approval', text: 'Fixture permission', instructions: 'Reply approve or deny',
    parse: action => action === 'approve' ? { decision: 'accept' } : action === 'deny' ? { decision: 'decline' } : undefined }, call.request.signal);
  await bridge.accept(message('permission', 'approve', { thread_ts: ROOT, ts: REPLY }));
  assert.deepEqual(await answer, { decision: 'accept' });
  assert.equal(f.records().length, 1);
  call.result.resolve('Finished.'); await bridge.idle();
});

test('cancelling a running hook kills its child before the request can launch a model', async t => {
  const f = hook(t, 'hang'), bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  await bridge.accept(message('request', 'Explain the fixture.'));
  await f.waitRecords(1);
  const pid = f.records()[0].pid;
  await bridge.accept(message('cancel', 'cancel', { thread_ts: ROOT }));
  await bridge.idle();
  assert.equal(f.model.calls.length, 0);
  assert.equal(f.store.latest(f.scope)?.state, 'cancelled');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('invalid, oversized or failed hook results stop safely and reap children without leaking payloads', async t => {
  for (const mode of ['invalid', 'extra', 'wrong', 'large', 'large-response', 'fail', 'bad-receipt', 'large-receipt', 'empty-receipt']) await t.test(mode, async t => {
    const f = hook(t, mode);
    t.after(() => f.store.close());
    const job = f.store.enqueue(f.scope, 'test-' + mode, 'UALICE', 'Fixture human text.', NOW, ROOT)!;
    await assert.rejects(humanMessage(f.config.humanMessageCommand!, job, undefined, new AbortController().signal),
      error => error instanceof ModelFailure && !error.message.includes('PRIVATE'));
    const pid = f.records()[0].pid;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
});

test('a hook failure never falls through to the model or exposes raw provider output in Slack', async t => {
  const f = hook(t, 'invalid'), bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  await bridge.accept(message('request', 'Fixture human text.')); await bridge.idle();
  assert.equal(f.model.calls.length, 0);
  assert.equal(f.store.latest(f.scope)?.state, 'failed');
  assert.match(f.slack.posts.at(-1)!.text, /invalid_result/);
  assert.doesNotMatch(JSON.stringify(f.slack.posts), /PRIVATE|provider payload/);
});

test('human hook configuration is fixed absolute argv with bounded strings and no implicit shell', t => {
  const f = fixture(t);
  for (const value of [[], ['relative'], [42], [process.execPath, 42], [process.execPath, 'x'.repeat(8001)], [process.execPath, 'x\0y'], Array(31).fill(process.execPath)]) {
    assert.throws(() => parseConfig({ ...f.config, humanMessageCommand: value }), /fixed absolute argv/);
  }
  const argv = [process.execPath, hookFixture, '--literal=$(touch unexpected)'];
  const config = parseConfig({ ...f.config, humanMessageCommand: argv });
  assert.deepEqual(config.humanMessageCommand, argv);
  argv.push('later mutation');
  assert.equal(config.humanMessageCommand?.length, 3);
});


test('delivery callback carries the exact accepted human scope and receipt without creating another message request', async t => {
  const f = hook(t, 'receipt');
  t.after(() => f.store.close());
  const job = f.store.enqueue(f.scope, 'receipt-event', 'UALICE', 'Prepare a fixture proposal.', NOW, REPLY)!;
  const controller = new AbortController();
  const prepared = await humanMessage(f.config.humanMessageCommand!, job, undefined, controller.signal);
  assert.equal(prepared.handled, true);
  assert.equal(prepared.receipt, 'fixture-receipt');
  for (const delivered of [true, false]) {
    const result = await humanMessage(f.config.humanMessageCommand!, job, undefined, controller.signal, { receipt: prepared.receipt!, delivered });
    assert.deepEqual(result, { handled: false });
    assert.deepEqual(f.records().at(-1).envelope, { version: 1, phase: 'delivery', receipt: 'fixture-receipt', delivered, eventId: 'receipt-event', messageTs: REPLY, team: 'TEXAMPLE', channel: 'CPROJECT', root: ROOT, actor: 'UALICE', project: f.config.codex.cwd, text: 'Prepare a fixture proposal.' });
  }
  assert.equal(f.records().length, 3);
  assert.equal(f.records()[0].envelope.phase, 'message');
  assert.equal(f.records()[0].envelope.receipt, undefined);
});

test('invalid delivery acknowledgements fail before spawning the configured hook', async t => {
  const f = hook(t);
  t.after(() => f.store.close());
  const job = f.store.enqueue(f.scope, 'receipt-invalid', 'UALICE', 'Fixture.', NOW, ROOT)!;
  for (const receipt of ['', ' ', 'x'.repeat(201), 'x\0y']) {
    await assert.rejects(humanMessage(f.config.humanMessageCommand!, job, undefined, new AbortController().signal, { receipt, delivered: true }), ModelFailure);
  }
  assert.equal(f.records().length, 0);
});


test('handled receipt is acknowledged after delivered or uncertain output without a second Slack message', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'uncertain' : 'delivered', async t => {
    const f = hook(t, 'receipt');
    if (fail) f.slack.failOn = 1;
    const bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
    t.after(async () => { await bridge.shutdown(); f.store.close(); });
    const event = message('receipt-handler', 'Prepare a fixture proposal.');
    await bridge.accept(event); await bridge.idle();
    assert.deepEqual(f.records().map(r => ({ phase: r.envelope.phase, delivered: r.envelope.delivered })), [{ phase: 'message', delivered: undefined }, { phase: 'delivery', delivered: !fail }]);
    assert.equal(f.records()[1].envelope.receipt, 'fixture-receipt');
    assert.equal(f.model.calls.length, 0);
    assert.equal(f.slack.posts.length, 1);
    assert.equal(f.store.latest(f.scope)?.delivery, fail ? 'uncertain' : 'sent');
    await bridge.accept(event); await bridge.idle();
    assert.equal(f.records().length, 2);
  });
});

test('delivery acknowledgement settles before the next admitted human event executes', async t => {
  const f = hook(t, 'receipt'), bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  await bridge.accept(message('proposal-one', 'Prepare first fixture.'));
  await bridge.accept(message('proposal-two', 'Prepare second fixture.', { thread_ts: ROOT, ts: REPLY }));
  await bridge.idle();
  assert.deepEqual(f.records().map(r => [r.envelope.eventId, r.envelope.phase]), [['proposal-one', 'message'], ['proposal-one', 'delivery'], ['proposal-two', 'message'], ['proposal-two', 'delivery']]);
  assert.equal(f.slack.posts.length, 2);
  assert.equal(f.model.calls.length, 0);
});


test('hook JSON preserves Unicode split across stdout chunks', async t => {
  const f = hook(t, 'unicode');
  t.after(() => f.store.close());
  const job = f.store.enqueue(f.scope, 'unicode', 'UALICE', 'Fixture.', NOW, ROOT)!;
  const result = await humanMessage(f.config.humanMessageCommand!, job, undefined, new AbortController().signal);
  assert.equal(result.response, 'Fixture ÆØÅ æøå 😀');
});


test('an acknowledgement failure preserves the original delivered result and does not retry or send another outcome', async t => {
  const f = hook(t, 'receipt-callback-fail'), bridge = new Bridge(f.config, f.store, f.model, f.slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); f.store.close(); });
  const event = message('failed-receipt', 'Prepare a fixture proposal.');
  await bridge.accept(event); await bridge.idle();
  assert.equal(f.store.latest(f.scope)?.state, 'completed');
  assert.equal(f.store.latest(f.scope)?.delivery, 'sent');
  assert.equal(f.slack.posts.length, 1);
  assert.doesNotMatch(JSON.stringify(f.slack.posts), /PRIVATE/);
  assert.equal(f.model.calls.length, 0);
  assert.equal(f.records().length, 2);
  await bridge.accept(event); await bridge.idle();
  assert.equal(f.records().length, 2);
});
