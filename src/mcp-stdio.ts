import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'techbase-bridge', version: '0.2.0' });
server.registerTool('send_message', {
  description: 'Send Slack mrkdwn text: *bold* headings, blank lines, short bullets and <https://example.com|label> web links. Bare HTTP/HTTPS URLs also link automatically. Mentions and link previews are disabled. Omit destination (or use thread) to reply in the originating thread, or use an operator-configured alias from the request context. Never retry an uncertain delivery. After any tool send, Bridge suppresses its automatic final answer.',
  inputSchema: z.object({ text: z.string().min(1).max(48_000), destination: z.string().max(40).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async input => {
  const failure = { isError: true, content: [{ type: 'text' as const, text: 'Delivery is uncertain or the sender is unavailable. Do not retry.' }] };
  try {
    const url = process.env.BRIDGE_SEND_URL;
    const token = process.env.BRIDGE_SEND_TOKEN;
    if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/send$/.test(url) || !token) return failure;
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
    const result = await response.json() as { ok?: unknown; message?: unknown };
    if (typeof result.ok !== 'boolean' || typeof result.message !== 'string') return failure;
    return { isError: !result.ok, content: [{ type: 'text' as const, text: result.message }] };
  } catch { return failure; }
});
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; });
