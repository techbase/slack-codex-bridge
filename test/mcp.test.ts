import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_ENTRY, openSender } from '../src/mcp.js';
import { TurnSender } from '../src/send.js';
import { Store, type Scope } from '../src/store.js';
import { deferred, fixture, NOW, RecordingSlack } from './helpers.js';

test('actual MCP stdio client/server round trip enforces default thread, aliases, safe output and arbitrary destination rejection', async t => {
  const { config, env } = fixture(t);
  const store = new Store(config, NOW);
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  const job = store.enqueue(scope, 'fixture-send', 'UALICE', 'request', NOW)!;
  const slack = new RecordingSlack();
  const controller = new AbortController();
  const sender = new TurnSender(config, job, store, slack, ['fixture-secret'], controller.signal);
  const broker = await openSender(sender.send);
  const client = new Client({ name: 'fixture', version: '1.0.0' });
  t.after(async () => { await client.close(); await broker.close(); store.close(); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP_ENTRY], env: { ...env as Record<string, string>, ...broker.env }, stderr: 'ignore' }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['send_message']);
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'send_message', arguments: args });
  for (const args of [{ text: '\u0000   ' }, { text: 'No', destination: 'CARBITRARY' }, { text: 'No', destination: '__proto__' },
    { text: 'No', channel: 'CUNKNOWN' }, { text: 'No', team: 'TOTHER' }, { text: 'No', thread_ts: 'other' }]) {
    assert.equal((await call(args)).isError, true);
    assert.equal(slack.posts.length, 0);
  }
  const first = await call({ text: '*Hello* <!channel> <@UALICE> fixture-secret <https://example.invalid|Visit site>' });
  assert.equal(first.isError, false);
  assert.equal(slack.posts[0]?.channel, 'CPROJECT');
  assert.equal(slack.posts[0]?.thread_ts, scope.root);
  assert.match(slack.posts[0]!.text, /&lt;!channel&gt;/);
  assert.match(slack.posts[0]!.text, /\[redacted\]/);
  assert.match(slack.posts[0]!.text, /\*Hello\*/);
  assert.match(slack.posts[0]!.text, /<https:\/\/example\.invalid\|Visit site>/);
  assert.equal(slack.posts[0]?.mrkdwn, true);
  assert.equal(slack.posts[0]?.link_names, false);
  assert.equal(slack.posts[0]?.unfurl_links, false);
  assert.equal((await call({ text: 'News', destination: 'updates' })).isError, false);
  assert.equal(slack.posts[1]?.channel, 'CUPDATES');
  assert.equal(slack.posts[1]?.thread_ts, undefined);
  assert.equal(store.job(job.id)?.delivery, 'sent');
  controller.abort();
  assert.equal((await call({ text: 'Too late' })).isError, true);
  assert.equal(slack.posts.length, 2);
  const unauthorized = await fetch(broker.env.BRIDGE_SEND_URL!, { method: 'POST', body: '{"text":"No"}' });
  assert.equal(unauthorized.status, 403);
  assert.equal(slack.posts.length, 2);
});

test('sender records uncertain partial delivery, refuses retries and preserves uncertainty on restart', async t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW);
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  const job = store.enqueue(scope, 'uncertain', 'UALICE', 'request', NOW)!;
  const slack = new RecordingSlack(); slack.failOn = 2;
  const sender = new TurnSender(config, job, store, slack, [], new AbortController().signal);
  const result = await sender.send({ text: 'x'.repeat(7000) });
  assert.equal(result.ok, false);
  assert.match(result.message, /uncertain/);
  assert.equal(slack.posts.length, 2);
  assert.equal((await sender.send({ text: 'Retry' })).ok, false);
  assert.equal(slack.posts.length, 2);
  store.finish(job.id, 'completed', null, NOW);
  store.close();
  const reopened = new Store(config, NOW + 1);
  try {
    assert.equal(reopened.job(job.id)?.state, 'completed');
    assert.equal(reopened.job(job.id)?.delivery, 'uncertain');
    assert.equal(reopened.queued().length, 0);
  } finally { reopened.close(); }
});

test('sender serializes concurrent calls, bounds the total output and rechecks cancellation before later chunks', async t => {
  const { config } = fixture(t, { maxOutputChars: 8000 });
  const store = new Store(config, NOW); t.after(() => store.close());
  const job = store.enqueue({ team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd }, 'cancel-send', 'UALICE', 'request', NOW)!;
  const controller = new AbortController();
  const gate = deferred();
  const entered = deferred();
  const slack = new RecordingSlack();
  slack.post = async message => { slack.posts.push(message); entered.resolve(); await gate.promise; };
  const sender = new TurnSender(config, job, store, slack, [], controller.signal);
  assert.equal((await sender.send({ text: 'x'.repeat(8001) })).ok, false);
  const pending = sender.send({ text: 'x'.repeat(7000) });
  await entered.promise;
  assert.equal((await sender.send({ text: 'Concurrent' })).ok, false);
  controller.abort(); gate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(slack.posts.length, 1);
  assert.equal(store.job(job.id)?.delivery, 'uncertain');
});

test('broker closes its capability after settlement and a disconnected client cannot trigger an unhandled response error', async () => {
  const entered = deferred();
  const release = deferred();
  let sends = 0;
  const broker = await openSender(async () => { sends++; entered.resolve(); await release.promise; return { ok: true, message: 'Sent' }; });
  const controller = new AbortController();
  const request = fetch(broker.env.BRIDGE_SEND_URL!, { method: 'POST', headers: { authorization: `Bearer ${broker.env.BRIDGE_SEND_TOKEN}` }, body: '{"text":"fixture"}', signal: controller.signal });
  const aborted = assert.rejects(request);
  await entered.promise;
  controller.abort();
  const closed = broker.close();
  release.resolve();
  await aborted; await closed;
  await assert.rejects(fetch(broker.env.BRIDGE_SEND_URL!, { method: 'POST', body: '{}' }));
  assert.equal(sends, 1);
});
