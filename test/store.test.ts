import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, lstatSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store, type Scope } from '../src/store.js';
import { fixture, NOW } from './helpers.js';

test('SQLite enforces same-directory instance exclusion, persisted sessions and conservative restart recovery', t => {
  const { config } = fixture(t);
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  const first = new Store(config, NOW);
  assert.throws(() => new Store(config, NOW), /Another Bridge instance/);
  const active = first.enqueue(scope, 'active', 'UALICE', 'sensitive prompt', NOW)!;
  first.claimEvent('active', NOW);
  first.acknowledge(active.id, 'sent'); first.activate(active.id, NOW);
  first.saveThread(scope, 'fixture-id', NOW);
  const queued = first.enqueue(scope, 'queued', 'UALICE', 'queued prompt', NOW)!;
  const done = first.enqueue(scope, 'done', 'UALICE', 'done prompt', NOW)!;
  first.finish(done.id, 'completed', null, NOW); first.delivery(done.id, 'sending');
  first.close();
  const reopened = new Store(config, NOW + 1);
  try {
    assert.equal(reopened.job(active.id)?.state, 'interrupted');
    assert.equal(reopened.job(active.id)?.prompt, null);
    assert.equal(reopened.job(queued.id)?.state, 'interrupted');
    assert.equal(reopened.job(done.id)?.state, 'completed');
    assert.equal(reopened.job(done.id)?.delivery, 'uncertain');
    assert.equal(reopened.queued().length, 0);
    assert.equal(reopened.thread(scope), 'fixture-id');
    assert.equal(reopened.claimEvent('active', NOW + 1), 'duplicate');
    for (const variant of [{ ...scope, team: 'TOTHER' }, { ...scope, project: '/fixture/other' }, { ...scope, root: 'different' }, { ...scope, channel: 'COTHER' }]) {
      assert.equal(reopened.thread(variant), undefined);
    }
    assert.equal(lstatSync(path.join(config.stateDir, 'bridge.sqlite')).mode & 0o077, 0);
  } finally { reopened.close(); }
});

test('OS releases instance lock after a child process is killed; durable active work is not replayed', async t => {
  const { config } = fixture(t);
  const storeUrl = new URL('../src/store.js', import.meta.url).href;
  const script = `import {Store} from ${JSON.stringify(storeUrl)};
    const config=JSON.parse(process.argv[1]); const store=new Store(config,${NOW});
    const job=store.enqueue({team:config.teamId,channel:'CPROJECT',root:'1800000000.000001',project:config.codex.cwd},'crash','UALICE','fixture prompt',${NOW});
    store.activate(job.id,${NOW}); process.stdout.write('locked\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(config)], { env: { ...process.env, OPENSSL_CONF: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  assert.throws(() => new Store(config, NOW), /Another Bridge instance/);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const reopened = new Store(config, NOW + 1);
  try {
    assert.equal(reopened.unfinished().length, 0);
    assert.equal(reopened.latest({ team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd })?.state, 'interrupted');
  } finally { reopened.close(); }
});

test('retention bounds terminal prompts/session metadata and dedup rows without evicting live dedup to admit work', t => {
  const { config } = fixture(t, { maxRetainedEvents: 10 });
  const store = new Store(config, NOW);
  const scope: Scope = { team: config.teamId, channel: 'CPROJECT', root: '1800000000.000001', project: config.codex.cwd };
  try {
    for (let i = 0; i < 10; i++) assert.equal(store.claimEvent(`event-${i}`, NOW), 'new');
    assert.equal(store.claimEvent('full', NOW), 'full');
    assert.equal(store.claimEvent('event-0', NOW), 'duplicate');
    const job = store.enqueue(scope, 'event-0', 'UALICE', 'fixture prompt', NOW)!;
    store.saveThread(scope, 'session', NOW);
    store.cleanup(NOW + config.retentionMs + 1);
    assert.equal(store.thread(scope), 'session'); // Pending conversation is not orphaned.
    store.finish(job.id, 'cancelled', 'requested', NOW);
    store.cleanup(NOW + config.retentionMs + 1);
    assert.deepEqual(store.counts(), { events: 0, jobs: 0, sessions: 0 });
  } finally { store.close(); }
});

test('unsupported schema and unsafe state permissions/symlinks fail closed', t => {
  const { config, root } = fixture(t);
  const file = path.join(config.stateDir, 'bridge.sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version=999'); db.close(); chmodSync(file, 0o600);
  assert.throws(() => new Store(config, NOW), /Unsupported state schema/);
  chmodSync(file, 0o644);
  assert.throws(() => new Store(config, NOW), /private regular files/);
  const otherState = path.join(root, 'project2'); chmodSync(otherState, 0o700);
  symlinkSync(file, path.join(otherState, 'bridge.sqlite'));
  assert.throws(() => new Store({ ...config, stateDir: otherState }, NOW), /private regular files/);
});
