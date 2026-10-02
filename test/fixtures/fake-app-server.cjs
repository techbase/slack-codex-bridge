// Version-shaped stdio fixture: no Slack connection or model calls.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, value) => emit({ id, result: value });
const notify = (method, params) => emit({ method, params });
const log = message => fs.appendFileSync(path.join(process.env.HOME, 'rpc.jsonl'), JSON.stringify(message) + '\n');
log({ start: { args: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid } });
let thread = 'fixture-native-0001';
let prompt = '';
let waiting;
function finish(status = 'completed') {
  notify('item/completed', { threadId: thread, turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer', text: 'Native final answer.', phase: 'final_answer' } });
  notify('turn/completed', { threadId: thread, turn: { id: 'turn-1', status } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); log(m);
  if (m.method === 'initialize') result(m.id, { userAgent: 'fixture' });
  else if (m.method === 'config/read') result(m.id, { config: { approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    thread = m.params.threadId ?? thread;
    result(m.id, { thread: { id: thread } });
  } else if (m.method === 'turn/start') {
    prompt = m.params.input[0].text.split('\n\nSlack message:\n').at(-1);
    notify('turn/started', { threadId: thread, turn: { id: 'turn-1' } });
    result(m.id, { turn: { id: 'turn-1' } });
    notify('item/completed', { threadId: thread, turnId: 'turn-1', item: { type: 'reasoning', text: 'PRIVATE reasoning' } });
    if (prompt === 'exit-failure') { process.stderr.write('PRIVATE provider diagnostics'); process.exit(1); }
    if (prompt === 'malformed') { process.stdout.write('PRIVATE invalid JSON\n'); return; }
    if (prompt === 'hold' || prompt === 'ignore-term') {
      if (prompt === 'ignore-term') process.on('SIGTERM', () => {});
      return;
    }
    const params = { threadId: prompt === 'wrong-thread' ? 'wrong' : thread, turnId: 'turn-1', itemId: 'item-1', reason: 'Fixture request' };
    let method;
    if (['approval', 'wrong-thread', 'resolved', 'ignore-term-approval'].includes(prompt)) {
      if (prompt === 'ignore-term-approval') process.on('SIGTERM', () => {});
      method = 'item/commandExecution/requestApproval'; params.command = 'printf fixture'; params.cwd = process.cwd();
    }
    else if (prompt === 'files') {
      method = 'item/fileChange/requestApproval';
      notify('item/started', { threadId: thread, turnId: 'turn-1', item: { id: 'item-1', type: 'fileChange', changes: [{ path: '/fictional/change.txt', diff: '+ fixture' }] } });
    } else if (prompt === 'permissions') { method = 'item/permissions/requestApproval'; params.permissions = { network: { enabled: true }, fileSystem: null }; }
    else if (['question', 'secret', 'question-key'].includes(prompt)) {
      method = 'item/tool/requestUserInput';
      params.questions = [{ id: prompt === 'question-key' ? '__proto__' : 'choice', question: 'Which option?', isSecret: prompt === 'secret', isOther: false, options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }];
    } else if (prompt === 'form') { method = 'mcpServer/elicitation/request'; params.mode = 'form'; params.serverName = 'fixture'; params.message = 'Tool confirmation'; params.requestedSchema = { type: 'object', properties: { decision: { type: 'string', enum: ['accept', 'decline'] } }, required: ['decision'] }; }
    else if (prompt === 'unknown') method = 'item/unrecognized/requestApproval';
    else { finish(prompt === 'failed' ? 'failed' : 'completed'); return; }
    waiting = 41;
    emit({ id: waiting, method, params });
    if (prompt === 'resolved') { notify('serverRequest/resolved', { threadId: thread, requestId: waiting }); finish(); }
  } else if (m.id === waiting && 'result' in m) {
    log({ answer: m.result });
    notify('serverRequest/resolved', { threadId: thread, requestId: waiting });
    finish();
  }
});
