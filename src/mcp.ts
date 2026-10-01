import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { SendMessage } from './send.js';

export const MCP_NAME = 'techbase_bridge';
export const MCP_ENTRY = fileURLToPath(new URL('./mcp-stdio.js', import.meta.url));
export const MCP_ENV = ['BRIDGE_SEND_URL', 'BRIDGE_SEND_TOKEN'];

/** Supported per-invocation Codex TOML override, never an operator file edit. */
export function mcpOverrides(): string[] {
  const table = `command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(MCP_ENTRY)}],env_vars=${JSON.stringify(MCP_ENV)},enabled=true,required=true,tool_timeout_sec=120`;
  return ['-c', `mcp_servers.${MCP_NAME}={${table}}`];
}

/** Loopback transport gives the stdio process a turn capability, never Slack tokens. */
export async function openSender(send: SendMessage): Promise<{ env: Record<string, string>; close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  let closing = false;
  const pending = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 10_000, headersTimeout: 5000 }, (req, res) => {
    const respond = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' });
      res.end(JSON.stringify(body));
    };
    if (closing || req.method !== 'POST' || req.url !== '/send' || req.headers.authorization !== `Bearer ${token}`) {
      respond(403, { ok: false, message: 'Sender unavailable.' }); return;
    }
    const task = (async () => {
      try {
        let data = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
          data += chunk;
          if (data.length > 256_000) { respond(413, { ok: false, message: 'Message too large; nothing sent.' }); return; }
        }
        let input: unknown;
        try { input = JSON.parse(data); }
        catch { respond(400, { ok: false, message: 'Invalid arguments; nothing sent.' }); return; }
        if (closing) { respond(403, { ok: false, message: 'Sender unavailable.' }); return; }
        respond(200, await send(input));
      } catch { respond(500, { ok: false, message: 'Delivery is uncertain. Do not retry.' }); }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => { pending.delete(task); res.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    env: { BRIDGE_SEND_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`, BRIDGE_SEND_TOKEN: token },
    async close() {
      closing = true;
      // No new calls after the model settles. Await any admitted Slack send.
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await Promise.all([...pending]);
      await closed;
    },
  };
}
