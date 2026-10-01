// Launched by the official SDK, with a generated absolute Node shebang.
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { input += data; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'invocations.jsonl'), JSON.stringify({ args, env: process.env, input, pid: process.pid }) + '\n');
  const resumeIndex = args.indexOf('resume');
  const thread = resumeIndex < 0 ? 'fixture-thread-0001' : args[resumeIndex + 1];
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  if (input === 'cancel') {
    process.on('SIGTERM', () => {
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'stopped'), 'No model work remains.');
      process.exit(0);
    });
  }
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  if (input === 'cancel') { setInterval(() => {}, 1000); return; }
  if (input === 'invalid-json') { process.stdout.write('PRIVATE-invalid-provider-json\n'); return; }
  if (input === 'exit-failure') { process.stderr.write('PRIVATE-provider-error'); process.exitCode = 1; return; }
  if (input === 'failed') { emit({ type: 'turn.failed', error: { message: 'PRIVATE-provider-error' } }); return; }
  emit({ type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'PRIVATE-reasoning' } });
  emit({ type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'PRIVATE-command', aggregated_output: 'PRIVATE-output', status: 'completed' } });
  if (input !== 'empty') emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: input === 'oversize' ? 'x'.repeat(1_000_001) : 'Only the final answer.' } });
  if (input !== 'missing-completion') emit({ type: 'turn.completed', usage: input === 'malformed-completion' ? null : { input_tokens: 2, cached_input_tokens: 0, output_tokens: 3 } });
});
