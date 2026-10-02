import assert from 'node:assert/strict';
import test from 'node:test';
import { MESSAGE_CHARS, sendText, slackChunks, type SlackPost } from '../src/output.js';

test('Slack mentions and escaped syntax remain literal while web links and formatting survive', () => {
  const result = slackChunks('<!channel> <@UALICE> <#CSECRET|secret> <https://example.invalid|click> &lt;@UBOB&gt; @here *bold*\u0000', [], 1000);
  assert.equal(result.length, 1);
  assert.equal(result[0], '&lt;!channel&gt; &lt;@UALICE&gt; &lt;#CSECRET|secret&gt; <https://example.invalid|click> &amp;lt;@UBOB&amp;gt; @here *bold*');
});

test('only valid HTTP/HTTPS link controls survive, with entities escaped', () => {
  const text = '<https://example.invalid?a=1&b=2|Site & details> <http://example.invalid> <javascript:alert(1)|click> <mailto:someone@example.invalid|Mail> <!here> <!subteam^SUSERS> <https://|bad> <https://example.invalid| >';
  assert.equal(slackChunks(text, [], 2000).join(''), '<https://example.invalid?a=1&amp;b=2|Site &amp; details> <http://example.invalid> &lt;javascript:alert(1)|click&gt; &lt;mailto:someone@example.invalid|Mail&gt; &lt;!here&gt; &lt;!subteam^SUSERS&gt; &lt;https://|bad&gt; &lt;https://example.invalid| &gt;');
  assert.equal(slackChunks('<https://example.invalid|<@UALICE>>', [], 2000).join(''), '&lt;https://example.invalid|&lt;@UALICE&gt;&gt;');
});

test('links stay intact across chunks and paragraph boundaries are preferred', () => {
  const link = '<https://example.invalid/path|Open the project>';
  const prefix = 'x'.repeat(MESSAGE_CHARS - 10);
  const chunks = slackChunks(prefix + link + '\nNext', [], 5000);
  assert.deepEqual(chunks, [prefix, link + '\nNext']);
  const paragraph = 'x'.repeat(2000) + '\n';
  const text = paragraph + 'y'.repeat(2000);
  assert.deepEqual(slackChunks(text, [], 5000), [paragraph, 'y'.repeat(2000)]);
  const oversized = '<https://example.invalid/' + 'x'.repeat(MESSAGE_CHARS) + '|Long>';
  const longChunks = slackChunks(oversized, [], 5000);
  assert.ok(longChunks.every(chunk => chunk.length <= MESSAGE_CHARS));
  assert.equal(longChunks.join(''), '&lt;' + oversized.slice(1, -1) + '&gt;');
});

test('link targets and labels are redacted before formatting and truncation', () => {
  const text = '<https://example.invalid/fixture-secret|fixture-secret details>';
  assert.equal(slackChunks(text, ['fixture-secret'], 2000).join(''), '<https://example.invalid/[redacted]|[redacted] details>');
  assert.doesNotMatch(slackChunks(text, ['fixture-secret'], 35).join(''), /fixture|secret/);
});

test('Slack posts enable formatting and automatic web links without mentions or previews', async () => {
  const posts: SlackPost[] = [];
  const text = '*Projects*\n\n*Example*\nHealthy. <https://example.invalid|Visit site>\nhttps://example.invalid/status\n<!channel> @here';
  await sendText({ async post(message) { posts.push(message); } }, 'CPROJECT', '1800000000.000001', text, [], 2000);
  assert.deepEqual(posts, [{ channel: 'CPROJECT', thread_ts: '1800000000.000001', text: text.replace('<!channel>', '&lt;!channel&gt;'), mrkdwn: true, link_names: false, unfurl_links: false, unfurl_media: false }]);
});

test('redaction precedes truncation and chunk boundaries; output is bounded without broken entities or Unicode', () => {
  const prefix = 'x'.repeat(MESSAGE_CHARS - 3);
  const text = prefix + 'fixture-secret' + '<&>😀'.repeat(10_000);
  const chunks = slackChunks(text, ['fixture', 'fixture-secret', ''], 7000);
  const combined = chunks.join('');
  assert.doesNotMatch(combined, /fixture|secret/);
  assert.match(combined, /\[redacted\]/);
  assert.match(combined, /Answer truncated/);
  assert.ok(chunks.every(chunk => chunk.length <= MESSAGE_CHARS));
  assert.ok(chunks.every(chunk => !/&(?:a|am|amp|l|lt|g|gt)?$/.test(chunk) && !/[\ud800-\udbff]$/.test(chunk)));
  assert.ok(combined.length < 7000 * 5 + 200);
  assert.doesNotMatch(slackChunks('abcfixture-secretZ', ['fixture-secret'], 8).join(''), /fixture/);
  assert.equal(slackChunks('x' + '😀'.repeat(100), [], 100).join(''), 'x' + '😀'.repeat(49) + '\n[Answer truncated by Bridge.]');
});
