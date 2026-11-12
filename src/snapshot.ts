import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Config } from './config.js';
import { safeDatabaseFile } from './store.js';

type SnapshotInput = { cursor?: string; limit?: number };
function parseInput(value: unknown): { after?: [number, string]; limit: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid snapshot request.');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['cursor', 'limit'].includes(key))) throw Error('Invalid snapshot request.');
  const limit = raw.limit ?? 50;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw Error('Invalid snapshot page limit.');
  let after: [number, string] | undefined;
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(raw.cursor)) throw Error('Invalid snapshot cursor.');
    try {
      const decoded: unknown = JSON.parse(Buffer.from(raw.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isSafeInteger(decoded[0]) || decoded[0] < 0
          || typeof decoded[1] !== 'string' || !/^[a-f0-9-]{36}$/.test(decoded[1])) throw Error();
      after = decoded as [number, string];
    } catch { throw Error('Invalid snapshot cursor.'); }
  }
  return { after, limit: Number(limit) };
}

/** Operator-only observation. Never acquires the service lock or runs recovery. */
export function readBridgeSnapshot(config: Config, value: SnapshotInput = {}, now = Date.now(), secrets: string[] = []) {
  const { after, limit } = parseInput(value);
  const file = path.join(config.stateDir, 'bridge.sqlite');
  safeDatabaseFile(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (![1, 2, 3].includes(version)) throw Error('Unsupported Bridge snapshot schema.');
    const names = new Set((db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(row => row.name));
    const optional = (name: string, fallback: string) => names.has(name) ? 'j.' + name : fallback;
    const marks = (values: string[]) => values.map(() => '?').join(',');
    const where = ['j.team=?', 'j.project=?', 'j.channel IN (' + marks(config.incomingChannelIds) + ')', 'j.user IN (' + marks(config.allowedUserIds) + ')'];
    const parameters: (string | number)[] = [config.teamId, config.codex.cwd, ...config.incomingChannelIds, ...config.allowedUserIds];
    if (after) { where.push('(j.created>? OR (j.created=? AND j.id>?))'); parameters.push(after[0], after[0], after[1]); }
    const sql = 'SELECT j.*, ' + optional('request_text', "substr(coalesce(j.prompt,''),1,4000)") + ' AS snapshot_text, '
      + optional('request_truncated', "length(coalesce(j.prompt,''))>4000") + ' AS snapshot_text_truncated, '
      + optional('outcome_text', "''") + ' AS snapshot_outcome, '
      + optional('outcome_truncated', '0') + ' AS snapshot_outcome_truncated, '
      + optional('final_delivery', "'unknown'") + ' AS snapshot_outcome_delivery, '
      + optional('turn_id', 'NULL') + ' AS snapshot_turn_id, '
      + (names.has('native_thread_id') ? 'coalesce(j.native_thread_id,s.thread_id)' : 's.thread_id') + ' AS snapshot_thread_id '
      + 'FROM jobs j LEFT JOIN sessions s ON s.team=j.team AND s.channel=j.channel AND s.root=j.root AND s.project=j.project '
      + 'WHERE ' + where.join(' AND ') + ' ORDER BY j.created,j.id LIMIT ?';
    const rows = db.prepare(sql).all(...parameters, limit + 1) as Record<string, unknown>[];
    const clean = (value: unknown): string => {
      let text = typeof value === 'string' ? value : '';
      for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
      return text.slice(0, 4000);
    };
    const jobs = rows.slice(0, limit).map(row => ({
      id: row.id, eventId: row.event_id, messageTs: row.message_ts ?? '', team: row.team, channel: row.channel, root: row.root,
      user: row.user, project: row.project, text: clean(row.snapshot_text), textTruncated: !!row.snapshot_text_truncated,
      state: row.state, reason: row.reason, delivery: row.delivery, outcomeDelivery: row.snapshot_outcome_delivery,
      createdAt: new Date(Number(row.created)).toISOString(), updatedAt: new Date(Number(row.updated)).toISOString(),
      ...(row.snapshot_thread_id ? { threadId: row.snapshot_thread_id } : {}),
      ...(row.snapshot_turn_id ? { turnId: row.snapshot_turn_id } : {}),
      ...(row.snapshot_outcome ? { outcome: clean(row.snapshot_outcome), outcomeTruncated: !!row.snapshot_outcome_truncated } : {}),
    }));
    const last = rows[Math.min(limit, rows.length) - 1];
    return { version: 1, generatedAt: new Date(now).toISOString(), jobs,
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.created, last.id])).toString('base64url') : null };
  } finally { db.close(); }
}

export async function snapshotInput(): Promise<SnapshotInput> {
  let body = '';
  for await (const data of process.stdin) {
    body += data.toString();
    if (Buffer.byteLength(body) > 2048) throw Error('Snapshot input exceeds its bound.');
  }
  try { return body.trim() ? JSON.parse(body) as SnapshotInput : {}; }
  catch { throw Error('Invalid snapshot request JSON.'); }
}
