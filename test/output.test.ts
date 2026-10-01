import assert from 'node:assert/strict';
import test from 'node:test';
import { MESSAGE_CHARS, slackChunks } from '../src/output.js';

test('malicious Slack syntax and escaped syntax cannot become active mentions, links or formatting', () => {
  const result = slackChunks('<!channel> <@UALICE> <#CSECRET|secret> <https://example.invalid|click> &lt;@UBOB&gt; @here *bold*\u0000', [], 1000);
  assert.equal(result.length, 1);
  assert.equal(result[0], '&lt;!channel&gt; &lt;@UALICE&gt; &lt;#CSECRET|secret&gt; &lt;https://example.invalid|click&gt; &amp;lt;@UBOB&amp;gt; @here *bold*');
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
