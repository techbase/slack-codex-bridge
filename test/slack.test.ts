import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from '@slack/bolt';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { appOptions, safeLogger, slackSender, verifySlackIdentity, wireSlack } from '../src/slack.js';
import { ControlledModel, fixture, ManualClock, message, NOW } from './helpers.js';

test('real Bolt event boundary and WebClient accept ordinary human messages, one ack, thread-only safe output and no HTTP receiver', async t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW);
  const logs: string[] = [];
  const diagnostic = (reason: string) => logs.push(reason);
  const options = appOptions('xoxb-fixture', 'xapp-fixture', diagnostic);
  assert.equal(options.socketMode, true);
  assert.equal(options.clientOptions?.retryConfig?.retries, 0);
  const calls: { url: string; body: string }[] = [];
  const app = new App({ ...options, clientOptions: { ...options.clientOptions, fetch: async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const data = String(url).endsWith('/auth.test') ? { ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: 'BFIXTURE' }
      : { ok: true, ts: '1800000000.000099' };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  } } });
  await app.init();
  await verifySlackIdentity(app, config);
  const model = new ControlledModel();
  const bridge = new Bridge(config, store, model, slackSender(app), [], diagnostic, new ManualClock());
  t.after(async () => { await bridge.shutdown(); store.close(); });
  wireSlack(app, bridge, diagnostic);
  let acknowledgements = 0;
  await app.processEvent({ body: message('real-bolt'), ack: async () => { acknowledgements++; } });
  const call = await model.started(1);
  call.result.resolve('Answer with <!channel> and a file src/example.ts.');
  await bridge.idle();
  assert.equal(acknowledgements, 1);
  const posts = calls.filter(call => call.url.endsWith('/chat.postMessage'));
  assert.equal(posts.length, 2);
  for (const post of posts) {
    const body = new URLSearchParams(post.body);
    assert.equal(body.get('channel'), 'CPROJECT');
    assert.equal(body.get('thread_ts'), '1800000000.000001');
    assert.equal(body.get('parse'), 'none');
    assert.equal(body.get('mrkdwn'), 'false');
    assert.equal(body.get('unfurl_links'), 'false');
    assert.equal(body.get('unfurl_media'), 'false');
    assert.equal(body.get('link_names'), 'false');
  }
  assert.match(new URLSearchParams(posts[1]!.body).get('text')!, /&lt;!channel&gt;/);
  const previous = calls.filter(call => call.url.endsWith('/chat.postMessage')).length;
  await app.processEvent({ body: message('unauthorized', 'Question', { user: 'UEVE' }), ack: async () => {} });
  assert.equal(calls.filter(call => call.url.endsWith('/chat.postMessage')).length, previous);
  assert.equal(model.calls.length, 1);
  assert.deepEqual(logs, []);
});

test('Slack identity mismatch and ambiguous send failure are not silently accepted or retried; logger drops raw arguments', async t => {
  const { config } = fixture(t);
  let requests = 0;
  const reasons: string[] = [];
  const options = appOptions('xoxb-fixture', 'xapp-fixture', reason => reasons.push(reason));
  const app = new App({ ...options, clientOptions: { ...options.clientOptions, fetch: async url => {
    requests++;
    if (String(url).endsWith('/auth.test')) return new Response(JSON.stringify({ ok: true, team_id: 'TOTHER', user_id: 'UOTHER' }), { headers: { 'content-type': 'application/json' } });
    throw new Error('PRIVATE provider token payload');
  } } });
  await app.init();
  await assert.rejects(verifySlackIdentity(app, config), /does not match/);
  await assert.rejects(slackSender(app).post({ channel: 'CPROJECT', thread_ts: '1800000000.000001', text: 'Fixture', mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false }));
  assert.equal(requests, 2);
  const logger = safeLogger(reason => reasons.push(reason));
  logger.error('PRIVATE', { token: 'secret' }); logger.warn('PRIVATE'); logger.debug('PRIVATE');
  assert.doesNotMatch(JSON.stringify(reasons), /PRIVATE|secret/);
});
