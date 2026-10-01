import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Bridge, route } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { Store, type Scope } from '../src/store.js';
import { ControlledModel, deferred, fixture, ManualClock, mention, NOW, RecordingSlack } from './helpers.js';

function setup(t: TestContext, overrides: Partial<Config> = {}) {
  const { config } = fixture(t, overrides);
  const store = new Store(config, NOW);
  const model = new ControlledModel();
  const slack = new RecordingSlack();
  const clock = new ManualClock();
  const logs: { reason: string; id?: string }[] = [];
  const bridge = new Bridge(config, store, model, slack, ['fixture-secret'], (reason, id) => logs.push({ reason, id }), clock);
  t.after(async () => { await bridge.shutdown(); store.close(); });
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.channels.CPROJECT! };
  return { config, store, model, slack, clock, bridge, logs, scope };
}

test('Slack authorization rejects workspace, channel, user, shared, bot, edit, system, stale and implicit events before persistence or reply', async t => {
  const { config, bridge, store, model, slack } = setup(t);
  const invalid = [
    mention('wrong-team', 'question', {}, { team_id: 'TOTHER' }),
    mention('wrong-user', 'question', { user: 'UEVE' }),
    mention('wrong-channel', 'question', { channel: 'CUNKNOWN' }),
    mention('wrong-event-team', 'question', { team: 'TOTHER' }),
    mention('wrong-user-team', 'question', { user_team: 'TOTHER' }),
    mention('shared', 'question', {}, { is_ext_shared_channel: true }),
    mention('bot', 'question', { bot_id: 'BFIXTURE' }),
    mention('own', 'question', { user: 'UBRIDGE' }),
    mention('edit', 'question', { subtype: 'message_changed' }),
    mention('edited', 'question', { edited: {} }),
    mention('system', 'question', { type: 'message', subtype: 'channel_join' }),
    mention('implicit', 'question', { text: 'Hello Bridge' }),
    mention('escaped', 'question', { text: '&lt;@UBRIDGE&gt; hi' }),
    mention('timestamp', 'question', { thread_ts: '<!channel>' }),
    mention('old', 'question', {}, { event_time: (NOW - config.retentionMs) / 1000 - 1 }),
    mention('future', 'question', {}, { event_time: NOW / 1000 + 301 }),
  ];
  for (const value of invalid) { assert.equal(route(config, value, NOW), undefined); await bridge.accept(value); }
  assert.deepEqual(store.counts(), { events: 0, jobs: 0, sessions: 0 });
  assert.equal(model.calls.length, 0);
  assert.equal(slack.posts.length, 0);
});

test('mention routing fixes project and thread; help/status are deterministic, oversize input is not stored', async t => {
  const { bridge, store, model, slack, scope } = setup(t, { maxInputChars: 30 });
  await bridge.accept(mention('help', 'help'));
  await bridge.accept(mention('status', 'status'));
  await bridge.accept(mention('oversize', 'x'.repeat(31)));
  assert.equal(store.counts().jobs, 0);
  assert.equal(model.calls.length, 0);
  assert.match(slack.posts[0]!.text, /Read-only/);
  assert.match(slack.posts[1]!.text, /No requests/);
  assert.match(slack.posts[2]!.text, /too long/);
  await bridge.accept(mention('question', 'cwd=/etc: explain this'));
  const call = await model.started(1);
  assert.equal(call.request.project, scope.project);
  assert.equal(store.thread(scope), 'fixture-thread-1');
  call.result.resolve('A bounded final answer.');
  await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'completed');
  assert.equal(store.latest(scope)?.prompt, null);
  for (const post of slack.posts) {
    assert.equal(post.channel, scope.channel); assert.equal(post.thread_ts, scope.root);
    assert.equal(post.parse, 'none'); assert.equal(post.mrkdwn, false); assert.equal(post.unfurl_links, false); assert.equal(post.link_names, false);
  }
});

test('duplicate events never queue or reply twice; follow-ups resume and new threads/channels/projects stay separate', async t => {
  const { bridge, model, slack } = setup(t);
  const original = mention('original');
  await bridge.accept(original);
  await bridge.accept(original);
  assert.equal(slack.posts.length, 1);
  const first = await model.started(1);
  first.result.resolve('First.'); await bridge.idle();
  await bridge.accept(original);
  assert.equal(model.calls.length, 1);
  await bridge.accept(mention('followup', 'Correction', { ts: '1800000000.000002', thread_ts: '1800000000.000001' }));
  const next = await model.started(2);
  assert.equal(next.request.threadId, 'fixture-thread-1');
  next.result.resolve('Corrected.'); await bridge.idle();
  for (const [id, event] of [
    ['thread', { ts: '1800000000.000010' }],
    ['channel', { channel: 'CALIAS' }],
    ['project', { channel: 'CSECOND' }],
  ] as const) {
    await bridge.accept(mention(id, 'New question', event));
    const call = await model.started(model.calls.length);
    assert.equal(call.request.threadId, undefined);
    call.result.resolve('Separate.'); await bridge.idle();
  }
  assert.equal(model.calls.length, 5);
});

test('bounded queue and global concurrency serialize aliases of a project and progress independently across projects', async t => {
  const { bridge, model, slack } = setup(t, { maxPending: 3, maxConcurrentProjects: 2 });
  await bridge.accept(mention('first'));
  await bridge.accept(mention('same-project', 'Second', { channel: 'CALIAS' }));
  await bridge.accept(mention('other-project', 'Third', { channel: 'CSECOND' }));
  await bridge.accept(mention('full', 'Fourth'));
  assert.equal(model.calls.length, 2);
  assert.notEqual(model.calls[0]!.request.project, model.calls[1]!.request.project);
  assert.match(slack.posts.at(-1)!.text, /queue is full/);
  model.calls[0]!.result.resolve('First complete.');
  const third = await model.started(3);
  assert.equal(third.request.project, model.calls[0]!.request.project);
  third.result.resolve('Second complete.');
  model.calls[1]!.result.resolve('Other complete.');
  await bridge.idle();
});

test('the global concurrency limit applies across different projects', async t => {
  const { bridge, model } = setup(t, { maxConcurrentProjects: 1 });
  await bridge.accept(mention('first-project'));
  await bridge.accept(mention('second-project', 'Question', { channel: 'CSECOND' }));
  assert.equal(model.calls.length, 1);
  model.calls[0]!.result.resolve('First done.');
  const second = await model.started(2);
  assert.notEqual(second.request.project, model.calls[0]!.request.project);
  second.result.resolve('Second done.'); await bridge.idle();
});

test('requester and operator cancellation is thread-scoped and stops queued/active requests without replay', async t => {
  const { bridge, model, slack, store, scope } = setup(t);
  await bridge.accept(mention('alice'));
  await bridge.accept(mention('queued', 'Next'));
  await bridge.accept(mention('bob-cancel', 'cancel', { user: 'UBOB' }));
  assert.match(slack.posts.at(-1)!.text, /Only the requester/);
  assert.equal(model.calls[0]!.request.signal.aborted, false);
  await bridge.accept(mention('other-thread', 'cancel', { ts: '1800000000.000003' }));
  assert.equal(model.calls[0]!.request.signal.aborted, false);
  await bridge.accept(mention('alice-cancel', 'cancel'));
  await bridge.idle();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.equal(store.latest(scope)?.state, 'cancelled');
  await bridge.accept(mention('after-cancel', 'Try again'));
  const resumed = await model.started(2);
  assert.equal(resumed.request.threadId, 'fixture-thread-1');
  await bridge.accept(mention('operator-cancel', 'cancel', { user: 'UOPERATOR' }));
  await bridge.idle();
  assert.equal(resumed.request.signal.aborted, true);
});

test('timeout and queued expiry use controlled time and never overlap a previous turn', async t => {
  const { bridge, model, clock, store, scope } = setup(t, { turnTimeoutMs: 1000, queueTtlMs: 1000 });
  await bridge.accept(mention('timeout'));
  const timedOutId = store.latest(scope)!.id;
  await bridge.accept(mention('expires'));
  clock.advance(1000);
  await bridge.idle();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.equal(store.job(timedOutId)?.state, 'timed_out');
  assert.equal(store.latest(scope)?.state, 'interrupted');
  await bridge.accept(mention('status', 'status'));
});

test('clean shutdown awaits cancellation, interrupts queued work and stops admission', async t => {
  const { bridge, model, store, scope, slack } = setup(t);
  await bridge.accept(mention('active'));
  await bridge.accept(mention('queued'));
  await bridge.shutdown();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.equal(store.latest(scope)?.state, 'interrupted');
  const before = slack.posts.length;
  await bridge.accept(mention('after-shutdown'));
  assert.equal(slack.posts.length, before);
});

test('model success with Slack delivery failure stays completed across duplicate events and restart', async t => {
  const { bridge, model, store, config, scope, slack, logs } = setup(t);
  const event = mention('completed');
  await bridge.accept(event);
  slack.failOn = 2;
  model.calls[0]!.result.resolve('The answer contains fixture-secret and <!channel> <@UALICE>.');
  await bridge.idle();
  assert.equal(store.latest(scope)?.state, 'completed');
  assert.equal(store.latest(scope)?.delivery, 'uncertain');
  assert.match(slack.posts[1]!.text, /\[redacted\]/);
  assert.doesNotMatch(slack.posts[1]!.text, /fixture-secret|<!channel>|<@UALICE>/);
  await bridge.accept(event);
  await bridge.accept(mention('status', 'status'));
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
  const event = mention('long-answer');
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
  await bridge.accept(mention('ack-fails'));
  assert.equal(model.calls.length, 0);
  assert.equal(store.latest(scope)?.state, 'interrupted');
  await bridge.accept(mention('model-fails'));
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
  await bridge.accept(mention('first'));
  await bridge.accept(mention('next', 'Question', { user: 'UBOB' }));
  await bridge.accept(mention('cancel-first', 'cancel'));
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
  const question = bridge.accept(mention('queued'));
  await bridge.accept(mention('cancel', 'cancel'));
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
  await bridge.accept(mention('active'));
  const cancelling = bridge.accept(mention('cancel', 'cancel'));
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
  const first = bridge.accept(mention('first', 'First question'));
  await bridge.accept(mention('followup', 'Second question'));
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
  await bridge.accept(mention('active'));
  store.cleanup = () => { throw new Error('PRIVATE persistence payload'); };
  bridge.start();
  await bridge.shutdown();
  await bridge.accept(mention('after-failure'));
  assert.equal(fatal, 1);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]!.request.signal.aborted, true);
  assert.deepEqual(logs, ['maintenance_failed']);
  assert.doesNotMatch(JSON.stringify(slack.posts), /PRIVATE/);
});
