import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'techbase-bridge', version: '0.2.0' });
async function call(endpoint: 'send' | 'state', input: unknown) {
  const failure = { isError: true, content: [{ type: 'text' as const, text: endpoint === 'send' ? 'Delivery is uncertain or the sender is unavailable. Do not retry.' : 'Observation is unconfirmed; inspect recorded status before repeating.' }] };
  try {
    const url = process.env[endpoint === 'send' ? 'BRIDGE_SEND_URL' : 'BRIDGE_STATE_URL'];
    const token = process.env.BRIDGE_SEND_TOKEN;
    if (!url || !new RegExp('^http://127\\.0\\.0\\.1:\\d+/' + endpoint + '$').test(url) || !token) return failure;
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
    const result = await response.json() as { ok?: unknown; message?: unknown };
    if (typeof result.ok !== 'boolean' || typeof result.message !== 'string') return failure;
    return { isError: !result.ok, content: [{ type: 'text' as const, text: result.message }] };
  } catch { return failure; }
}
server.registerTool('send_message', {
  description: 'Send Slack mrkdwn text to the originating thread or a configured alias. Use kind outcome for a terminal answer in the originating thread; progress is the default. Mentions/previews are disabled. Never retry uncertain delivery. After any send, Bridge suppresses its automatic final answer.',
  inputSchema: z.object({ text: z.string().min(1).max(48_000), destination: z.string().max(40).optional(), kind: z.enum(['progress', 'outcome']).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, input => call('send', input));
if (process.env.BRIDGE_STATE_URL) server.registerTool('report_state', {
  description: 'Record bounded lifecycle metadata through the configured operator extension for this exact request. It does not approve actions or send Slack messages. The operator context defines accepted data. Use a stable id per observation; inspect status before repeating an unconfirmed operation.',
  inputSchema: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), data: z.record(z.string(), z.unknown()) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, input => call('state', input));
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; });
