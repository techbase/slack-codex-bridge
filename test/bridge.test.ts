import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Bridge, route } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { Store, type Scope } from '../src/store.js';
import { ControlledModel, deferred, fixture, ManualClock, message, NOW, RecordingSlack } from './helpers.js';

function setup(t: TestContext, overrides: Partial<Config> = {}) {
  const { config } = fixture(t, overrides);
  const store = new Store(config, NOW);
  const model = new ControlledModel();
  const slack = new RecordingSlack();
  const clock = new ManualClock();
  const logs: { reason: string; id?: string }[] = [];
  const bridge = new Bridge(config, store, model, slack, ['fixture-secret'], (reason, id) => logs.push({ reason, id }), clock);
  t.after(async () => { await bridge.shutdown(); store.close(); });
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  return { config, store, model, slack, clock, bridge, logs, scope };
}

test('Slack authorization rejects workspace, channel, user, shared, bot, edit, system, stale events before persistence or reply', async t => {
  const { config, bridge, store, model, slack } = setup(t);
  const invalid = [
    message('wrong-team', 'question', {}, { team_id: 'TOTHER' }),
    message('wrong-user', 'question', { user: 'UEVE' }),
    message('wrong-channel', 'question', { channel: 'CUNKNOWN' }),
    message('wrong-event-team', 'question', { team: 'TOTHER' }),
    message('wrong-user-team', 'question', { user_team: 'TOTHER' }),
    message('shared', 'question', {}, { is_ext_shared_channel: true }),
    message('bot', 'question', { bot_id: 'BFIXTURE' }),
    message('own', 'question', { user: 'UBRIDGE' }),
    message('edit', 'question', { subtype: 'message_changed' }),
    message('edited', 'question', { edited: {} }),
    message('system', 'question', { type: 'message', subtype: 'channel_join' }),
    message('timestamp', 'question', { thread_ts: '<!channel>' }),
    message('old', 'question', {}, { event_time: (NOW - config.retentionMs) / 1000 - 1 }),
    message('future', 'question', {}, { event_time: NOW / 1000 + 301 }),
  ];
  for (const value of invalid) { assert.equal(route(config, value, NOW), undefined); await bridge.accept(value); }
  assert.deepEqual(store.counts(), { events: 0, jobs: 0, sessions: 0 });
  assert.equal(model.calls.length, 0);
  assert.equal(slack.posts.length, 0);
});

test('ordinary message routing fixes project and thread; help/status are deterministic, oversize input is not stored', async t => {
  const { bridge, store, model, slack, scope } = setup(t, { maxInputChars: 30 });
  await bridge.accept(message('help', 'help'));
  await bridge.accept(message('status', 'status'));
  await bridge.accept(message('oversize', 'x'.repeat(31)));
  assert.equal(store.counts().jobs, 0);
  assert.equal(model.calls.length, 0);
  assert.match(slack.posts[0]!.text, /existing permissions/);
  assert.match(slack.posts[1]!.text, /No requests/);
  assert.match(slack.posts[2]!.text, /too long/);
  await bridge.accept(message('question', 'cwd=/etc: explain this'));
  const call = await model.started(1);
  assert.equal(call.request.project, scope.project);
  assert.equal(store.thread(scope), 'fixture-thread-1');
  call.result.resolve('A bounded final answer.');
  await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'completed');
  assert.equal(store.latest(scope)?.prompt, null);
  for (const post of slack.posts) {
    assert.equal(post.channel, scope.channel); assert.equal(post.thread_ts, scope.root);
    assert.equal(Object.hasOwn(post, 'parse'), false); assert.equal(post.mrkdwn, true); assert.equal(post.unfurl_links, false); assert.equal(post.link_names, false);
  }
});

test('duplicate events never queue or reply twice; follow-ups resume and new threads/channels stay separate', async t => {
  const { bridge, model, slack } = setup(t);
  const original = message('original');
  await bridge.accept(original);
  await bridge.accept(original);
  assert.equal(slack.posts.length, 1);
  const first = await model.started(1);
  first.result.resolve('First.'); await bridge.idle();
  await bridge.accept(original);
  assert.equal(model.calls.length, 1);
  await bridge.accept(message('followup', 'Correction', { ts: '1800000000.000002', thread_ts: '1800000000.000001' }));
  const next = await model.started(2);
  assert.equal(next.request.threadId, 'fixture-thread-1');
  next.result.resolve('Corrected.'); await bridge.idle();
  for (const [id, event] of [
    ['thread', { ts: '1800000000.000010' }],
    ['channel', { channel: 'CALIAS' }],
    ['second-channel', { channel: 'CSECOND' }],
  ] as const) {
    await bridge.accept(message(id, 'New question', event));
    const call = await model.started(model.calls.length);
    assert.equal(call.request.threadId, undefined);
    call.result.resolve('Separate.'); await bridge.idle();
  }
  assert.equal(model.calls.length, 5);
});

test('messages with files queue their text once and thread follow-ups resume the saved conversation', async t => {
  const { bridge, model, slack, store, scope } = setup(t);
  const files = [{ id: 'FFICTURE', url_private: 'https://files.example.invalid/private-screenshot.png' }];
  const original = message('file-original', 'Explain this issue', { subtype: 'file_share', files });
  await bridge.accept(original);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.prompt, 'Explain this issue');
  assert.equal(model.calls[0]!.request.threadId, undefined);
  assert.match(slack.posts[0]!.text, /Queued request.*\n\n.*Attachments.*text only/s);
  model.calls[0]!.result.resolve('Please describe the screenshot.'); await bridge.idle();
  await bridge.accept(original);
  assert.equal(slack.posts.length, 2);

  for (const [id, subtype] of [['file-followup', 'file_share'], ['files-without-subtype', undefined]] as const) {
    await bridge.accept(message(id, 'Here is more context', { subtype, files, ts: '1800000000.000002', thread_ts: scope.root }));
    const call = model.calls.at(-1)!;
    assert.equal(model.calls.length, id === 'file-followup' ? 2 : 3);
    assert.equal(call.request.threadId, 'fixture-thread-1');
    assert.equal(call.request.prompt, 'Here is more context');
    assert.match(slack.posts.at(-1)!.text, /Attachments.*text only/);
    call.result.resolve('Follow-up answered.'); await bridge.idle();
  }
  assert.equal(store.latest(scope)?.state, 'completed');
  assert.equal(store.latest(scope)?.delivery, 'sent');
  assert.ok(slack.posts.every(post => post.channel === scope.channel && post.thread_ts === scope.root));
  assert.doesNotMatch(JSON.stringify(model.calls.map(call => call.request.prompt)) + JSON.stringify(slack.posts), /url_private|private-screenshot/);
});

test('file-share messages retain sender, workspace, channel, edit, shared and bot protections', async t => {
  const { bridge, model, slack, store } = setup(t);
  const files = [{ id: 'FFICTURE' }];
  const invalid = [
    { user: 'UEVE' }, { user: 'UBRIDGE' }, { channel: 'CUNKNOWN' },
    { bot_id: 'BFIXTURE' }, { bot_profile: {} }, { hidden: true }, { edited: {} },
    { team: 'TOTHER' }, { user_team: 'TOTHER' }, { is_ext_shared_channel: true },
    { subtype: 'message_changed' }, { subtype: 'message_deleted' },
    { subtype: 'message_replied' }, { subtype: 'bot_message' }, { subtype: 'unknown' },
  ];
  for (const [index, event] of invalid.entries()) {
    await bridge.accept(message('invalid-file-' + index, 'Question', { subtype: 'file_share', files, ...event }));
  }
  await bridge.accept(message('file-wrong-team', 'Question', { subtype: 'file_share', files }, { team_id: 'TOTHER' }));
  await bridge.accept(message('file-shared-envelope', 'Question', { subtype: 'file_share', files }, { is_ext_shared_channel: true }));
  assert.deepEqual(store.counts(), { events: 0, jobs: 0, sessions: 0 });
  assert.equal(model.calls.length, 0);
  assert.equal(slack.posts.length, 0);
});

test('attachment-only messages explain the text limitation without queuing or replaying; mention-only still applies', async t => {
  const { bridge, model, slack, store, scope } = setup(t);
  const files = [{ id: 'FFICTURE' }];
  for (const [id, event] of [
    ['empty-file', { subtype: 'file_share', files }],
    ['no-file-text', { subtype: 'file_share', files, text: undefined }],
    ['ordinary-with-files', { files }],
  ] as const) {
    const body = message(id, '', { ...event, ts: '1800000000.000002', thread_ts: scope.root });
    await bridge.accept(body);
    await bridge.accept(body);
  }
  assert.equal(slack.posts.length, 3);
  assert.ok(slack.posts.every(post => /attachment.*text only.*Nothing was queued/s.test(post.text)));
  assert.ok(slack.posts.every(post => post.thread_ts === scope.root));
  assert.equal(store.counts().jobs, 0);
  assert.equal(model.calls.length, 0);

  const restricted = setup(t, { mentionOnly: true });
  await restricted.bridge.accept(message('implicit-file', 'Question', { subtype: 'file_share', files }));
  assert.deepEqual(restricted.store.counts(), { events: 0, jobs: 0, sessions: 0 });
  assert.equal(restricted.slack.posts.length, 0);
  await restricted.bridge.accept(message('explicit-file', '<@UBRIDGE>', { subtype: 'file_share', files }));
  assert.equal(restricted.model.calls.length, 0);
  assert.match(restricted.slack.posts[0]!.text, /Nothing was queued/);
});

test('bounded admission serializes the fixed CLI cwd across channels', async t => {
  const { bridge, model, slack } = setup(t, { maxPending: 3 });
  await bridge.accept(message('first'));
  await bridge.accept(message('second', 'Second', { channel: 'CALIAS' }));
  await bridge.accept(message('third', 'Third', { channel: 'CSECOND' }));
  await bridge.accept(message('full', 'Fourth'));
  assert.equal(model.calls.length, 1);
  assert.match(slack.posts.at(-1)!.text, /queue is full/);
  model.calls[0]!.result.resolve('First complete.');
  const second = await model.started(2);
  assert.equal(second.request.project, model.calls[0]!.request.project);
  second.result.resolve('Second complete.');
  const third = await model.started(3);
  third.result.resolve('Third complete.');
  await bridge.idle();
});

test('requester and operator cancellation is thread-scoped and stops queued/active requests without replay', async t => {
  const { bridge, model, slack, store, scope } = setup(t);
  await bridge.accept(message('alice'));
  await bridge.accept(message('queued', 'Next'));
  await bridge.accept(message('bob-cancel', 'cancel', { user: 'UBOB' }));
  assert.match(slack.posts.at(-1)!.text, /Only the requester/);
  assert.equal(model.calls[0]!.request.signal.aborted, false);
  await bridge.accept(message('other-thread', 'cancel', { ts: '1800000000.000003' }));
  assert.equal(model.calls[0]!.request.signal.aborted, false);
  await bridge.accept(message('alice-cancel', 'cancel'));
  await bridge.idle();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.equal(store.latest(scope)?.state, 'cancelled');
  await bridge.accept(message('after-cancel', 'Try again'));
  const resumed = await model.started(2);
  assert.equal(resumed.request.threadId, 'fixture-thread-1');
  await bridge.accept(message('operator-cancel', 'cancel', { user: 'UOPERATOR' }));
  await bridge.idle();
  assert.equal(resumed.request.signal.aborted, true);
});

test('timeout and queued expiry use controlled time and never overlap a previous turn', async t => {
  const { bridge, model, clock, store, scope } = setup(t, { turnTimeoutMs: 1000, queueTtlMs: 1000 });
  await bridge.accept(message('timeout'));
  const timedOutId = store.latest(scope)!.id;
  await bridge.accept(message('expires'));
  clock.advance(1000);
  await bridge.idle();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.equal(store.job(timedOutId)?.state, 'timed_out');
  assert.equal(store.latest(scope)?.state, 'interrupted');
  await bridge.accept(message('status', 'status'));
});

test('clean shutdown awaits cancellation, interrupts queued work and stops admission', async t => {
  const { bridge, model, store, scope, slack } = setup(t);
  await bridge.accept(message('active'));
  await bridge.accept(message('queued'));
  await bridge.shutdown();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.equal(store.latest(scope)?.state, 'interrupted');
  const before = slack.posts.length;
  await bridge.accept(message('after-shutdown'));
  assert.equal(slack.posts.length, before);
});

test('model success with Slack delivery failure stays completed across duplicate events and restart', async t => {
  const { bridge, model, store, config, scope, slack, logs } = setup(t);
  const event = message('completed');
  await bridge.accept(event);
  slack.failOn = 2;
  model.calls[0]!.result.resolve('The answer contains fixture-secret and <!channel> <@UALICE>.');
  await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'completed');
  assert.equal(store.latest(scope)?.delivery, 'uncertain');
  assert.match(slack.posts[1]!.text, /\[redacted\]/);
  assert.doesNotMatch(slack.posts[1]!.text, /fixture-secret|<!channel>|<@UALICE>/);
  await bridge.accept(event);
  await bridge.accept(message('status', 'status'));
  assert.match(slack.posts.at(-1)!.text, /completed.*uncertain/);
  assert.equal(model.calls.length, 1);
  assert.deepEqual(logs.map(log => log.reason), ['slack_delivery_uncertain']);
  await bridge.shutdown(); store.close();
  const reopened = new Store(config, NOW + 1);
  try {
    assert.equal(reopened.claimEvent('completed', NOW + 1), 'duplicate');
    assert.equal(reopened.latest(scope)?.state, 'completed');
    assert.equal(reopened.queued().length, 0);
  } finally { reopened.close(); }
});

test('a long answer stops at an uncertain chunk and a duplicate event never resends or reruns it', async t => {
  const { bridge, model, store, scope, slack } = setup(t);
  const event = message('long-answer');
  await bridge.accept(event);
  slack.failOn = 3; // Acknowledgement, delivered first chunk, uncertain second chunk.
  model.calls[0]!.result.resolve('x'.repeat(12_000));
  await bridge.idle();
  assert.equal(slack.posts.length, 3);
  assert.ok(slack.posts.every(post => post.text.length <= 3000));
  assert.equal(store.latest(scope)?.state, 'completed');
  assert.equal(store.latest(scope)?.delivery, 'uncertain');
  await bridge.accept(event);
  assert.equal(slack.posts.length, 3);
  assert.equal(model.calls.length, 1);
});

test('uncertain acknowledgement fails closed without launching a model; raw provider failures stay local-safe', async t => {
  const { bridge, model, slack, store, scope, logs } = setup(t);
  slack.failOn = 1;
  await bridge.accept(message('ack-fails'));
  assert.equal(model.calls.length, 0);
  assert.equal(store.latest(scope)?.state, 'interrupted');
  await bridge.accept(message('model-fails'));
  model.calls[0]!.result.reject(new Error('PRIVATE provider payload fixture-secret'));
  await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'failed');
  assert.doesNotMatch(JSON.stringify(slack.posts) + JSON.stringify(logs), /PRIVATE|provider payload|fixture-secret/);
});

test('cancel waits for model settlement before reusing a project, even if the model returns after abort', async t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW);
  const gate = deferred<string>();
  const started: AbortSignal[] = [];
  const second = deferred();
  const bridge = new Bridge(config, store, { async run(request) {
    started.push(request.signal);
    if (started.length === 1) return gate.promise;
    second.resolve(); return 'Next answer';
  } }, new RecordingSlack(), [], () => {}, new ManualClock());
  t.after(async () => { gate.resolve('Late result'); await bridge.shutdown(); store.close(); });
  await bridge.accept(message('first'));
  await bridge.accept(message('next', 'Question', { user: 'UBOB' }));
  await bridge.accept(message('cancel-first', 'cancel'));
  assert.equal(started[0]!.aborted, true);
  assert.equal(started.length, 1);
  gate.resolve('Late result');
  await second.promise; await bridge.idle();
  assert.equal(started.length, 2);
});

test('acknowledgement failure after queued cancellation preserves cancellation and its delivered outcome', async t => {
  const { bridge, slack, store, model, scope } = setup(t);
  const ack = deferred();
  slack.post = async message => {
    slack.posts.push(message);
    if (message.text.startsWith('Queued')) { await ack.promise; throw new Error('uncertain ack'); }
  };
  const question = bridge.accept(message('queued'));
  await bridge.accept(message('cancel', 'cancel'));
  ack.resolve(); await question;
  assert.equal(model.calls.length, 0);
  assert.equal(store.latest(scope)?.state, 'cancelled');
  assert.equal(store.latest(scope)?.ack, 'uncertain');
  assert.equal(store.latest(scope)?.delivery, 'sent');
});

test('an active cancellation send failure stays uncertain even when the cancel control reply succeeds later', async t => {
  const { bridge, slack, store, scope } = setup(t);
  const control = deferred();
  const storedUncertain = deferred();
  const recordDelivery = store.delivery.bind(store);
  store.delivery = (id, state) => {
    recordDelivery(id, state);
    if (state === 'uncertain') storedUncertain.resolve();
  };
  slack.post = async message => {
    slack.posts.push(message);
    if (message.text.startsWith('Cancellation requested')) await control.promise;
    if (message.text.includes('cancelled. No automatic retry.')) throw new Error('uncertain outcome');
  };
  await bridge.accept(message('active'));
  const cancelling = bridge.accept(message('cancel', 'cancel'));
  await storedUncertain.promise;
  control.resolve(); await cancelling; await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'cancelled');
  assert.equal(store.latest(scope)?.delivery, 'uncertain');
});

test('a slow acknowledgement cannot reorder queued questions for the same project', async t => {
  const { bridge, slack, model } = setup(t);
  const firstAck = deferred();
  slack.post = async message => {
    slack.posts.push(message);
    if (slack.posts.length === 1) await firstAck.promise;
  };
  const first = bridge.accept(message('first', 'First question'));
  await bridge.accept(message('followup', 'Second question'));
  assert.equal(model.calls.length, 0);
  firstAck.resolve(); await first;
  const call = await model.started(1);
  assert.equal(call.request.prompt, 'First question');
  call.result.resolve('First answer.');
  const followup = await model.started(2);
  assert.equal(followup.request.prompt, 'Second question');
  assert.equal(followup.request.threadId, 'fixture-thread-1');
  followup.result.resolve('Second answer.'); await bridge.idle();
});

test('unexpected persistence failure stops admission, aborts work and reports only a safe diagnostic to the service owner', async t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW);
  const model = new ControlledModel();
  const slack = new RecordingSlack();
  const logs: string[] = [];
  let fatal = 0;
  const bridge = new Bridge(config, store, model, slack, [], reason => logs.push(reason), new ManualClock(), () => { fatal++; });
  t.after(async () => { await bridge.shutdown(); store.close(); });
  await bridge.accept(message('active'));
  store.cleanup = () => { throw new Error('PRIVATE persistence payload'); };
  bridge.start();
  await bridge.shutdown();
  await bridge.accept(message('after-failure'));
  assert.equal(fatal, 1);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.deepEqual(logs, ['maintenance_failed']);
  assert.doesNotMatch(JSON.stringify(slack.posts), /PRIVATE/);
});

test('mention-only mode filters ordinary text before storage but accepts an explicit mention through the same message event', async t => {
  const { config, bridge, store, model } = setup(t, { mentionOnly: true });
  for (const text of ['Hello Bridge', '&lt;@UBRIDGE&gt; hi']) {
    const body = message('implicit-' + text.length, text);
    assert.equal(route(config, body, NOW), undefined);
    await bridge.accept(body);
  }
  assert.deepEqual(store.counts(), { events: 0, jobs: 0, sessions: 0 });
  await bridge.accept(message('explicit', '<@UBRIDGE> Follow up'));
  const call = await model.started(1);
  assert.equal(call.request.prompt, 'Follow up');
  call.result.resolve('Answer'); await bridge.idle();
});

test('tool success or uncertainty suppresses final fallback, including a later CLI failure; duplicates never rerun', async t => {
  for (const uncertain of [false, true]) {
    const { bridge, model, store, scope, slack } = setup(t);
    const event = message('tool-' + uncertain);
    await bridge.accept(event);
    if (uncertain) slack.failOn = 2;
    const call = await model.started(1);
    const sent = await call.request.sendMessage({ text: 'Tool answer' });
    assert.equal(sent.ok, !uncertain);
    if (uncertain) {
      assert.equal((await call.request.sendMessage({ text: 'Do not duplicate' })).ok, false);
      call.result.resolve('Do not duplicate final');
    } else call.result.reject(new Error('PRIVATE provider error after tool success'));
    await bridge.idle();
    assert.equal(slack.posts.length, 2);
    assert.equal(store.latest(scope)?.state, uncertain ? 'completed' : 'failed');
    assert.equal(store.latest(scope)?.delivery, uncertain ? 'uncertain' : 'sent');
    await bridge.accept(event);
    assert.equal(slack.posts.length, 2);
    assert.equal(model.calls.length, 1);
  }
});

test('absent final output without a tool send fails; a rejected destination still allows final fallback', async t => {
  const { bridge, model, store, scope, slack } = setup(t);
  await bridge.accept(message('empty'));
  model.calls[0]!.result.resolve(''); await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'failed');
  assert.match(slack.posts.at(-1)!.text, /invalid_result/);
  await bridge.accept(message('bad-destination'));
  const call = await model.started(2);
  assert.equal((await call.request.sendMessage({ text: 'No', destination: 'CARBITRARY' })).ok, false);
  call.result.resolve('Allowed thread fallback'); await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'completed');
  assert.match(slack.posts.at(-1)!.text, /Allowed thread fallback/);
});
