import { spawn } from 'node:child_process';
import { childEnvironment, ModelFailure } from './codex.js';
import type { SendResult } from './send.js';
import type { Job } from './store.js';
import type { ParentContext } from './parent-context.js';

export type HumanMessageResult = { handled: boolean; response?: string; context?: unknown; receipt?: string };
export type HumanMessageDelivery = { receipt: string; delivered: boolean };
function validReceipt(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 200 && !value.includes('\0');
}
/** Operator-owned extension. Only accepted human events reach this fixed command. */
export async function humanMessage(command: string[], job: Job, parent: ParentContext | undefined, signal: AbortSignal, delivery?: HumanMessageDelivery, observation?: { id: string; data: Record<string, unknown> }): Promise<HumanMessageResult> {
  signal.throwIfAborted();
  if (delivery !== undefined && (!validReceipt(delivery.receipt) || typeof delivery.delivered !== 'boolean')) throw new ModelFailure('invalid_result');
  return new Promise((resolve, reject) => {
    let out = '', failed = false;
    const child = spawn(command[0]!, command.slice(1), { env: childEnvironment(), stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const abort = () => { failed = true; kill(); };
    const timer = setTimeout(abort, 20_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { out += data; if (out.length > 64_000) abort(); });
    child.stdin.on('error', () => { failed = true; });
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); kill();
      if (failed || code !== 0 || signal.aborted) { reject(new ModelFailure('model_failed')); return; }
      try {
        const result = JSON.parse(out) as HumanMessageResult;
        if (!result || typeof result !== 'object' || typeof result.handled !== 'boolean'
            || Object.keys(result).some(k => !['handled', 'response', 'context', 'receipt'].includes(k))
            || (result.response !== undefined && (typeof result.response !== 'string' || result.response.length > 16_000))
            || (result.receipt !== undefined && !validReceipt(result.receipt))
            || (result.handled && !result.response?.trim())) throw Error();
        resolve(result);
      } catch { reject(new ModelFailure('invalid_result')); }
    });
    child.stdin.end(JSON.stringify({ version: 1, phase: observation ? 'observation' : delivery ? 'delivery' : 'message', jobId: job.id, ...(observation ? { observationId: observation.id, observation: observation.data } : {}), ...(delivery === undefined ? {} : { receipt: delivery.receipt, delivered: delivery.delivered }), eventId: job.event_id, messageTs: job.message_ts, team: job.team, channel: job.channel,
      root: job.root, actor: job.user, project: job.project, text: job.prompt, parent }));
    if (signal.aborted) abort();
  });
}

/** Records bounded operator-owned metadata for this exact invocation, never human approval. */
export async function humanMessageObservation(command: string[], job: Job, input: unknown, signal: AbortSignal): Promise<SendResult> {
  if (signal.aborted) return { ok: false, message: 'Request stopped; no observation recorded.' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Use id and data.' };
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(k => !['id', 'data'].includes(k)) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) || !value.data || typeof value.data !== 'object' || Array.isArray(value.data) || Buffer.byteLength(JSON.stringify(value.data)) > 16000) return { ok: false, message: 'Invalid observation; nothing recorded.' };
  try {
    const result = await humanMessage(command, job, undefined, signal, undefined, { id: value.id, data: value.data as Record<string, unknown> });
    if (result.handled) return { ok: false, message: 'Operator observation was not accepted.' };
    const message = JSON.stringify(result.context ?? { recorded: false });
    if (message.length > 16000) return { ok: false, message: 'Operator result exceeds the bound; inspect status before repeating.' };
    return { ok: !!result.context && typeof result.context === 'object' && (result.context as Record<string, unknown>).recorded === true, message };
  } catch { return { ok: false, message: 'Observation could not be confirmed. Inspect recorded status before repeating.' }; }
}
