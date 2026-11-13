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
let runtimeStatus = 'active';
let turnStatus = 'inProgress';
let statusReads = 0;
function finish(status = 'completed') {
  runtimeStatus = 'idle'; turnStatus = status;
  notify('item/completed', { threadId: thread, turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer', text: 'Native final answer.', phase: 'final_answer' } });
  notify('turn/completed', { threadId: thread, turn: { id: 'turn-1', status } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); log(m);
  if (m.method === 'initialize') result(m.id, { userAgent: 'fixture' });
  else if (m.method === 'config/read') result(m.id, { config: { approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write', model_reasoning_effort: process.env.FIXTURE_REASONING_EFFORT ?? 'medium' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    thread = m.params.threadId ?? thread;
    result(m.id, { thread: { id: thread } });
  } else if (m.method === 'thread/read') {
    statusReads++;
    if (['reconcile-active', 'reconcile-notLoaded', 'reconcile-foreign'].includes(prompt) && statusReads > 1) finish();
    result(m.id, { thread: { id: thread, status: { type: runtimeStatus } } });
  } else if (m.method === 'thread/turns/list') {
    result(m.id, { data: [{ id: prompt === 'reconcile-foreign' ? 'another-turn' : 'turn-1', status: turnStatus }], nextCursor: null });
  } else if (m.method === 'turn/start') {
    prompt = m.params.input[0].text.split('\n\nSlack message:\n').at(-1);
    notify('turn/started', { threadId: thread, turn: { id: 'turn-1' } });
    result(m.id, { turn: { id: 'turn-1' } });
    notify('item/completed', { threadId: thread, turnId: 'turn-1', item: { type: 'reasoning', text: 'PRIVATE reasoning' } });
    notify('item/completed', { threadId: thread, turnId: 'turn-1', item: { type: 'agentMessage', phase: 'commentary', text: 'PRIVATE commentary; this is not a Slack reply.' } });
    if (prompt === 'exit-failure') { process.stderr.write('PRIVATE provider diagnostics'); process.exit(1); }
    if (prompt === 'malformed') { process.stdout.write('PRIVATE invalid JSON\n'); return; }
    if (prompt === 'hold' || prompt === 'ignore-term') {
      if (prompt === 'ignore-term') process.on('SIGTERM', () => {});
      return;
    }
    if (prompt.startsWith('reconcile-') && prompt !== 'reconcile-waiting') {
      runtimeStatus = prompt === 'reconcile-active' ? 'active' : prompt === 'reconcile-notLoaded' ? 'notLoaded' : 'idle';
      turnStatus = prompt === 'reconcile-interrupted' || prompt === 'reconcile-active' || prompt === 'reconcile-notLoaded' || prompt === 'reconcile-foreign' ? 'interrupted' : prompt === 'reconcile-failed' ? 'failed' : 'completed';
      if (['reconcile-completed', 'reconcile-poll'].includes(prompt)) notify('item/completed', { threadId: thread, turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer', text: 'Native final answer.', phase: 'final_answer' } });
      if (prompt !== 'reconcile-poll') notify('thread/status/changed', { threadId: thread, status: { type: 'idle' } });
      return;
    }
    if (prompt === 'native-error' || prompt === 'foreign-native-error') {
      notify('error', { threadId: thread, turnId: prompt === 'native-error' ? 'turn-1' : 'another-turn', willRetry: false, error: { message: 'PRIVATE native error' } });
      if (prompt === 'foreign-native-error') finish();
      return;
    }
    if (prompt === 'native-closed') { notify('thread/closed', { threadId: thread }); return; }
    const params = { threadId: prompt === 'wrong-thread' ? 'wrong' : thread, turnId: 'turn-1', itemId: 'item-1', reason: 'Fixture request' };
    let method;
    if (['approval', 'wrong-thread', 'resolved', 'ignore-term-approval', 'reconcile-waiting'].includes(prompt)) {
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
    } else if (prompt === 'url') { method = 'mcpServer/elicitation/request'; params.mode = 'url'; params.serverName = 'fixture'; params.message = 'Complete the fictional connection'; params.url = 'https://example.invalid/connect'; }
    else if (prompt === 'form') { method = 'mcpServer/elicitation/request'; params.mode = 'form'; params.serverName = 'fixture'; params.message = 'Tool confirmation'; params.requestedSchema = { type: 'object', properties: { decision: { type: 'string', enum: ['accept', 'decline'] } }, required: ['decision'] }; }
    else if (['empty-form', 'empty-form-openai', 'empty-form-camel', 'optional-form', 'constrained-form', 'dynamic-form'].includes(prompt)) {
      method = 'mcpServer/elicitation/request'; params.mode = prompt === 'empty-form-openai' ? 'openai/form' : prompt === 'empty-form-camel' ? 'openaiForm' : 'form';
      params.serverName = 'fixture_apps'; params.message = 'Allow Fixture Calendar to run tool "fixture_calendar.cancel_scheduled_post"?';
      params.requestedSchema = { type: 'object', properties: prompt === 'optional-form' ? { note: { type: 'string' } } : {}, ...(prompt === 'constrained-form' ? { minProperties: 1 } : {}), ...(prompt === 'dynamic-form' ? { additionalProperties: { type: 'string' } } : {}) };
    }
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
