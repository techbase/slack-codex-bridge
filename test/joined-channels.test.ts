import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from '@slack/bolt';
import { Bridge, route } from '../src/bridge.js';
import { parseConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { appOptions, slackParentReader, wireSlack } from '../src/slack.js';
import { readBridgeSnapshot } from '../src/snapshot.js';
import { ControlledModel, fixture, ManualClock, message, NOW, RecordingSlack } from './helpers.js';

test('joined channels are explicit opt-in and do not require a manual list', t => {
  const { config } = fixture(t);
  assert.equal(config.incomingChannelMode, 'allowlist');
  assert.throws(() => parseConfig({ ...config, incomingChannelMode: 'all' }));
  assert.throws(() => parseConfig({ ...config, incomingChannelMode: null }));
  assert.throws(() => parseConfig({ ...config, incomingChannelMode: 'joined', incomingChannelIds: null }));
  assert.throws(() => parseConfig({ ...config, incomingChannelIds: [] }));
  assert.deepEqual(parseConfig({ ...config, incomingChannelMode: 'joined', incomingChannelIds: [] }).incomingChannelIds, []);
  const raw = { ...config, incomingChannelMode: 'joined' as const };
  delete (raw as Partial<typeof raw>).incomingChannelIds;
  assert.deepEqual(parseConfig(raw).incomingChannelIds, []);
});

test('joined mode requires a channel event authorized to this bot and preserves all existing admission gates', t => {
  const { config } = fixture(t, { incomingChannelMode: 'joined', incomingChannelIds: [] });
  const event = { channel: 'CINVITED', channel_type: 'channel' };
  assert.ok(route(config, message('new-public', 'Question', event), NOW));
  assert.ok(route(config, message('new-private', 'Question', { channel: 'GINVITED', channel_type: 'group' }), NOW));
  for (const candidate of [
    message('missing-type', 'Question', { channel: 'CINVITED' }),
    message('dm', 'Question', { channel: 'DINVITED', channel_type: 'im' }),
    message('mpim', 'Question', { channel: 'GINVITED', channel_type: 'mpim' }),
    message('bad-channel', 'Question', { ...event, channel: 'Cbad!' }),
    message('auth-missing', 'Question', event, { authorizations: undefined }),
    message('auth-user', 'Question', event, { authorizations: [{ team_id: 'TEXAMPLE', user_id: 'UALICE', is_bot: false }] }),
    message('auth-team', 'Question', event, { authorizations: [{ team_id: 'TOTHER', user_id: 'UBRIDGE', is_bot: true }] }),
    message('team', 'Question', event, { team_id: 'TOTHER' }),
    message('actor', 'Question', { ...event, user: 'UEVE' }),
    message('shared', 'Question', event, { is_ext_shared_channel: true }),
    message('bot', 'Question', { ...event, bot_id: 'BBOT' }),
    message('edit', 'Question', { ...event, subtype: 'message_changed' }),
    message('old', 'Question', event, { event_time: (NOW - config.retentionMs) / 1000 - 1 }),
  ]) assert.equal(route(config, candidate, NOW), undefined);
  assert.equal(route({ ...config, incomingChannelMode: 'allowlist' }, message('explicit', 'Question', event), NOW), undefined);
  assert.equal(route({ ...config, mentionOnly: true }, message('unmentioned', 'Question', event), NOW), undefined);
  assert.ok(route({ ...config, mentionOnly: true }, message('mention', '<@UBRIDGE> Question', event), NOW));
});

test('real Bolt dispatch, tool/final replies, continuation and snapshots work in an unlisted joined channel', async t => {
  const { config } = fixture(t, { incomingChannelMode: 'joined', incomingChannelIds: [] });
  const store = new Store(config, NOW), model = new ControlledModel(), slack = new RecordingSlack();
  const bridge = new Bridge(config, store, model, slack, [], () => {}, new ManualClock());
  t.after(async () => { await bridge.shutdown(); store.close(); });
  const options = appOptions('xoxb-fixture', 'xapp-fixture', () => {});
  const app = new App({ ...options, clientOptions: { ...options.clientOptions, fetch: async url => {
    assert.match(String(url), /\/auth.test$/);
    return new Response(JSON.stringify({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: 'BFIXTURE' }), { headers: { 'content-type': 'application/json' } });
  } } });
  await app.init(); wireSlack(app, bridge, () => {});
  const event = { channel: 'CINVITED', channel_type: 'channel' };
  await app.processEvent({ body: message('first', 'Question', event), ack: async () => {} });
  const first = await model.started(1);
  assert.equal((await first.request.sendMessage({ text: 'Progress' })).ok, true);
  assert.equal((await first.request.sendMessage({ text: 'Elsewhere', destination: 'COTHER' })).ok, false);
  first.result.resolve('Finished'); await bridge.idle();
  await app.processEvent({ body: message('follow', 'Follow up', { ...event, ts: '1800000000.000002', thread_ts: '1800000000.000001' }), ack: async () => {} });
  const follow = await model.started(2);
  assert.equal(follow.request.threadId, 'fixture-thread-1');
  follow.result.resolve('Follow-up answer'); await bridge.idle();
  assert.ok(slack.posts.length >= 2);
  for (const post of slack.posts) { assert.equal(post.channel, 'CINVITED'); assert.equal(post.thread_ts, '1800000000.000001'); }
  const scope = { team: config.teamId, channel: 'CINVITED', root: '1800000000.000001', project: config.codex.cwd };
  store.enqueue({ ...scope, channel: 'DPRIVATE' }, 'dm-row', 'UALICE', 'Private', NOW);
  store.enqueue({ ...scope, channel: 'Cbad!' }, 'malformed-row', 'UALICE', 'Invalid', NOW);
  store.enqueue({ ...scope, team: 'TOTHER' }, 'foreign-row', 'UALICE', 'Foreign', NOW);
  store.enqueue(scope, 'other-user-row', 'UEVE', 'Other user', NOW);
  store.enqueue({ ...scope, project: '/another/project' }, 'other-cwd-row', 'UALICE', 'Other cwd', NOW);
  const jobs = readBridgeSnapshot(config, {}, NOW).jobs;
  assert.equal(jobs.length, 2); assert.ok(jobs.every(j => j.channel === 'CINVITED'));
  assert.equal(readBridgeSnapshot({ ...config, incomingChannelMode: 'allowlist', incomingChannelIds: ['CPROJECT'] }, {}, NOW).jobs.length, 0);
});

test('joined-channel parent reads stay constrained to the exact own-bot parent', async t => {
  const { config } = fixture(t, { incomingChannelMode: 'joined', incomingChannelIds: [] });
  let calls = 0;
  const options = appOptions('xoxb-fixture', 'xapp-fixture', () => {});
  const app = new App({ ...options, clientOptions: { ...options.clientOptions, fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, messages: [{ ts: '1800000000.000001', user: 'UBRIDGE', text: 'A proposal' }] }), { headers: { 'content-type': 'application/json' } });
  } } });
  await app.init();
  const scope = { team: config.teamId, channel: 'GINVITED', root: '1800000000.000001', project: config.codex.cwd };
  const reader = slackParentReader(app, config), signal = new AbortController().signal;
  assert.equal((await reader(scope, '1800000000.000002', signal))?.text, 'A proposal');
  assert.equal(await reader({ ...scope, channel: 'DINVITED' }, '1800000000.000002', signal), undefined);
  assert.equal(await reader({ ...scope, team: 'TOTHER' }, '1800000000.000002', signal), undefined);
  assert.equal(calls, 1);
});
