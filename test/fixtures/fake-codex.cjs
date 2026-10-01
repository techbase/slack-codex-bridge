// Fixture CLI executable: captures the real process boundary; never calls a model.
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { input += data; });
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(process.env.HOME, 'invocations.jsonl'), JSON.stringify({ args, env: process.env, input, cwd: process.cwd(), pid: process.pid }) + '\n');
  const prompt = input.split('\n\nSlack message:\n').slice(1).join('\n\nSlack message:\n');
  const resumeIndex = args.indexOf('resume');
  const thread = resumeIndex < 0 ? 'fixture-thread-0001' : args[resumeIndex + 1];
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  if (prompt === 'cancel' || prompt === 'ignore-term') {
    process.on('SIGTERM', () => {
      if (prompt === 'ignore-term') return;
      fs.writeFileSync(path.join(process.env.HOME, 'stopped'), 'No model work remains.');
      process.exit(0);
    });
  }
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  if (prompt === 'cancel' || prompt === 'ignore-term') { setInterval(() => {}, 1000); return; }
  if (prompt === 'invalid-json') { process.stdout.write('PRIVATE-invalid-provider-json\n'); return; }
  if (prompt === 'null-event') { emit(null); return; }
  if (prompt === 'exit-failure') { process.stderr.write('PRIVATE-provider-error'); process.exitCode = 1; return; }
  if (prompt === 'failed') { emit({ type: 'turn.failed', error: { message: 'PRIVATE-provider-error' } }); return; }
  if (prompt === 'tool') {
    const { Client } = await import(process.env.FIXTURE_MCP_CLIENT);
    const { StdioClientTransport } = await import(process.env.FIXTURE_MCP_STDIO);
    const override = args.find(arg => arg.startsWith('mcp_servers.techbase_bridge='));
    const command = JSON.parse(override.match(/command=("(?:\\.|[^"\\])*"),args=/)[1]);
    const mcpArgs = JSON.parse(override.match(/,args=(\[.*?\]),env_vars=/)[1]);
    const client = new Client({ name: 'fake-codex', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command, args: mcpArgs, env: process.env, stderr: 'ignore' }));
    const result = await client.callTool({ name: 'send_message', arguments: { text: 'Answer sent through the real MCP round trip.' } });
    fs.writeFileSync(path.join(process.env.HOME, 'tool-result.json'), JSON.stringify(result));
    await client.close();
  }
  emit({ type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'PRIVATE-reasoning' } });
  emit({ type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'PRIVATE-command', aggregated_output: 'PRIVATE-output', status: 'completed' } });
  if (prompt !== 'empty') emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: prompt === 'oversize' ? 'x'.repeat(1_000_001) : 'Only the final answer.' } });
  if (prompt !== 'missing-completion') emit({ type: 'turn.completed', usage: prompt === 'malformed-completion' ? null : { input_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } });
});
