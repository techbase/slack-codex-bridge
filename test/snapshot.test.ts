import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readBridgeSnapshot } from '../src/snapshot.js';
import { Store, type Scope } from '../src/store.js';
import { fixture, NOW } from './helpers.js';

test('snapshot is paginated, route-scoped and read-only while the live instance holds its lock', t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW); t.after(() => store.close());
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const job = store.enqueue(scope, 'event-' + i, 'UALICE', 'Request ' + i, NOW + i, '1800000000.000001')!;
    store.acknowledge(job.id, 'skipped'); ids.push(job.id);
  }
  const other = store.enqueue({ ...scope, team: 'TOTHER' }, 'other', 'UALICE', 'Another team', NOW)!;
  store.activate(ids[0]!, NOW); store.saveThread(scope, 'native-thread', NOW); store.saveJobThread(ids[0]!, 'exact-original-thread', NOW); store.saveTurn(ids[0]!, 'exact-turn', NOW);
  const before = store.job(ids[0]!);
  const first = readBridgeSnapshot(config, { limit: 2 }, NOW);
  assert.equal(first.version, 1); assert.equal(first.jobs.length, 2);
  assert.deepEqual(first.jobs.map(job => job.id), ids.slice(0, 2));
  assert.equal(first.jobs[0]!.state, 'active'); assert.equal(first.jobs[0]!.text, 'Request 0');
  assert.equal(first.jobs[0]!.outcomeDelivery, 'unknown');
  assert.equal(first.jobs[0]!.threadId, 'exact-original-thread'); assert.equal(first.jobs[0]!.turnId, 'exact-turn');
  assert.equal(first.jobs[0]!.createdAt, new Date(NOW).toISOString());
  assert.ok(first.nextCursor);
  const second = readBridgeSnapshot(config, { limit: 2, cursor: first.nextCursor }, NOW);
  assert.deepEqual(second.jobs.map(job => job.id), ids.slice(2));
  assert.equal(second.nextCursor, null);
  assert.equal(first.jobs.some(job => job.id === other.id), false);
  assert.deepEqual(store.job(ids[0]!), before);
});

test('snapshot retains bounded original context and separates progress delivery from final proof', t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW); t.after(() => store.close());
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  const job = store.enqueue(scope, 'event', 'UALICE', 'secret-needle ' + 'q'.repeat(5000), NOW)!;
  store.delivery(job.id, 'sent');
  store.finish(job.id, 'completed', null, NOW, 'secret-needle ' + 'a'.repeat(5000));
  let result = readBridgeSnapshot(config, {}, NOW, ['secret-needle']);
  assert.equal(result.jobs[0]!.outcomeDelivery, 'unknown');
  assert.equal(result.jobs[0]!.textTruncated, true); assert.equal(result.jobs[0]!.outcomeTruncated, true);
  assert.equal(result.jobs[0]!.text.length <= 4000, true);
  assert.equal(result.jobs[0]!.outcome!.length <= 4000, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-needle/);
  store.outcomeDelivery(job.id, 'sent');
  result = readBridgeSnapshot(config, {}, NOW);
  assert.equal(result.jobs[0]!.outcomeDelivery, 'sent');
  assert.equal(store.job(job.id)?.prompt, null);
});

test('snapshot reads older schemas without migrating or recovering their jobs', t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW);
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  const job = store.enqueue(scope, 'legacy', 'UALICE', 'Legacy accepted request', NOW)!;
  store.activate(job.id, NOW); store.close();
  const file = path.join(config.stateDir, 'bridge.sqlite');
  const db = new DatabaseSync(file);
  for (const name of ['request_text', 'request_truncated', 'outcome_text', 'outcome_truncated', 'turn_id', 'native_thread_id', 'final_delivery']) db.exec('ALTER TABLE jobs DROP COLUMN ' + name);
  db.exec('PRAGMA user_version=2'); db.close(); chmodSync(file, 0o600);
  const before = readFileSync(file);
  const result = readBridgeSnapshot(config, {}, NOW);
  assert.equal(result.jobs[0]!.text, 'Legacy accepted request');
  assert.equal(result.jobs[0]!.state, 'active');
  assert.equal(result.jobs[0]!.outcomeDelivery, 'unknown');
  assert.deepEqual(readFileSync(file), before);
});

test('snapshot rejects invalid bounds/cursors without echoing private input', t => {
  const { config } = fixture(t);
  const store = new Store(config, NOW); t.after(() => store.close());
  for (const input of [{ limit: 0 }, { limit: 101 }, { cursor: 'private invalid cursor' }, { cursor: Buffer.from('["private", "bad"]').toString('base64url') }, { other: 'private' }]) {
    assert.throws(() => readBridgeSnapshot(config, input), error => error instanceof Error && !error.message.includes('private'));
  }
});

test('snapshot CLI bypasses doctor, auth/model startup and instance recovery', t => {
  const { config, root } = fixture(t);
  const store = new Store(config, NOW); t.after(() => store.close());
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  const job = store.enqueue(scope, 'event', 'UALICE', 'Read-only CLI fixture', NOW)!; store.activate(job.id, NOW);
  const file = path.join(root, 'config.json'); writeFileSync(file, JSON.stringify({ ...config, codex: { ...config.codex, executable: '/does/not/exist' } }));
  const result = spawnSync(process.execPath, [new URL('../src/main.js', import.meta.url).pathname, 'snapshot'], {
    input: JSON.stringify({ limit: 1 }), env: { PATH: process.env.PATH, BRIDGE_CONFIG: file, OPENSSL_CONF: '/dev/null' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).jobs[0].state, 'active');
  assert.equal(store.job(job.id)?.state, 'active');
});
