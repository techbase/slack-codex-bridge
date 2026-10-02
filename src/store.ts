import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory, SetupError, type Config } from './config.js';

export type JobState = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export type Delivery = 'pending' | 'sending' | 'sent' | 'uncertain';
export interface Scope { team: string; channel: string; root: string; project: string }
export interface Job extends Scope {
  id: string;
  event_id: string;
  user: string;
  prompt: string | null;
  state: JobState;
  // Retain the schema's original column for the optional attachment notice.
  ack: 'pending' | 'sent' | 'uncertain' | 'skipped';
  delivery: Delivery;
  reason: string | null;
  created: number;
  updated: number;
}

function safeDatabaseFile(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      throw new SetupError('State files must be private regular files owned by this account.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export class Store {
  private db!: DatabaseSync;
  private lock: DatabaseSync;
  private closed = false;

  constructor(readonly config: Config, now: number) {
    privateDirectory(config.stateDir, 'stateDir');
    const lockPath = path.join(config.stateDir, 'instance.sqlite');
    const dbPath = path.join(config.stateDir, 'bridge.sqlite');
    for (const base of [lockPath, dbPath]) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) safeDatabaseFile(base + suffix);
    }
    this.lock = new DatabaseSync(lockPath);
    chmodSync(lockPath, 0o600);
    try {
      // An OS-owned SQLite lock has no stale PID or crash-recovery race.
      this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch {
      this.lock.close();
      throw new SetupError('Another Bridge instance owns this state directory (or the instance lock is unavailable).');
    }
    try {
      this.db = new DatabaseSync(dbPath);
      chmodSync(dbPath, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1) throw new SetupError('Unsupported state schema; use the matching Bridge version.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          team TEXT NOT NULL, channel TEXT NOT NULL, root TEXT NOT NULL, project TEXT NOT NULL,
          thread_id TEXT NOT NULL, updated INTEGER NOT NULL,
          PRIMARY KEY (team, channel, root, project)
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
          team TEXT NOT NULL, channel TEXT NOT NULL, root TEXT NOT NULL, project TEXT NOT NULL,
          user TEXT NOT NULL, prompt TEXT, state TEXT NOT NULL, ack TEXT NOT NULL,
          delivery TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(state, created);
        CREATE INDEX IF NOT EXISTS jobs_scope ON jobs(team, channel, root, project, created);
        PRAGMA user_version=1;
      `);
      this.db.prepare(`UPDATE jobs SET state='interrupted', prompt=NULL, reason='restart', updated=?
        WHERE state IN ('queued','active')`).run(now);
      this.db.exec(`UPDATE jobs SET delivery='uncertain' WHERE delivery IN ('pending','sending');
        UPDATE jobs SET ack='uncertain' WHERE ack='pending'`);
      this.cleanup(now);
    } catch (error) {
      this.db?.close();
      this.lock.close();
      throw error;
    }
  }

  claimEvent(id: string, now: number): 'new' | 'duplicate' | 'full' {
    if (this.db.prepare('SELECT 1 FROM events WHERE id=?').get(id)) return 'duplicate';
    const count = (this.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
    if (count >= this.config.maxRetainedEvents) return 'full';
    this.db.prepare('INSERT INTO events VALUES (?,?)').run(id, now);
    return 'new';
  }

  enqueue(scope: Scope, eventId: string, user: string, prompt: string, now: number): Job | undefined {
    const count = (this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','active')").get() as { n: number }).n;
    if (count >= this.config.maxPending) return;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO jobs (id,event_id,team,channel,root,project,user,prompt,state,ack,delivery,created,updated)
      VALUES (?,?,?,?,?,?,?,?,'queued','pending','pending',?,?)`)
      .run(id, eventId, scope.team, scope.channel, scope.root, scope.project, user, prompt, now, now);
    return this.job(id)!;
  }

  job(id: string): Job | undefined { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job | undefined; }
  queued(): Job[] { return this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created, rowid").all() as unknown as Job[]; }
  unfinished(): Job[] { return this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','active') ORDER BY created, rowid").all() as unknown as Job[]; }
  latest(scope: Scope): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE team=? AND channel=? AND root=? AND project=? ORDER BY created DESC, rowid DESC LIMIT 1')
      .get(scope.team, scope.channel, scope.root, scope.project) as unknown as Job | undefined;
  }
  inScope(scope: Scope): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE team=? AND channel=? AND root=? AND project=? AND state IN ('queued','active') ORDER BY created, rowid")
      .all(scope.team, scope.channel, scope.root, scope.project) as unknown as Job[];
  }
  acknowledge(id: string, state: 'sent' | 'uncertain' | 'skipped'): void {
    this.db.prepare('UPDATE jobs SET ack=? WHERE id=?').run(state, id);
  }
  activate(id: string, now: number): void {
    this.db.prepare("UPDATE jobs SET state='active',updated=? WHERE id=? AND state='queued'").run(now, id);
  }
  finish(id: string, state: Exclude<JobState, 'queued' | 'active'>, reason: string | null, now: number): void {
    this.db.prepare('UPDATE jobs SET state=?,prompt=NULL,reason=?,updated=? WHERE id=?').run(state, reason, now, id);
  }
  delivery(id: string, state: Delivery): void { this.db.prepare('UPDATE jobs SET delivery=? WHERE id=?').run(state, id); }
  thread(scope: Scope): string | undefined {
    return (this.db.prepare('SELECT thread_id FROM sessions WHERE team=? AND channel=? AND root=? AND project=?')
      .get(scope.team, scope.channel, scope.root, scope.project) as { thread_id: string } | undefined)?.thread_id;
  }
  saveThread(scope: Scope, thread: string, now: number): void {
    this.db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?) ON CONFLICT(team,channel,root,project)
      DO UPDATE SET thread_id=excluded.thread_id,updated=excluded.updated`)
      .run(scope.team, scope.channel, scope.root, scope.project, thread, now);
  }
  touchThread(scope: Scope, now: number): void {
    this.db.prepare('UPDATE sessions SET updated=? WHERE team=? AND channel=? AND root=? AND project=?')
      .run(now, scope.team, scope.channel, scope.root, scope.project);
  }
  cleanup(now: number): void {
    const cutoff = now - this.config.retentionMs;
    this.db.prepare("DELETE FROM jobs WHERE state NOT IN ('queued','active') AND updated<?").run(cutoff);
    this.db.prepare('DELETE FROM events WHERE created<?').run(cutoff);
    this.db.prepare(`DELETE FROM sessions WHERE updated<? AND NOT EXISTS (
      SELECT 1 FROM jobs WHERE jobs.team=sessions.team AND jobs.channel=sessions.channel
      AND jobs.root=sessions.root AND jobs.project=sessions.project AND jobs.state IN ('queued','active'))`).run(cutoff);
  }
  counts(): { events: number; jobs: number; sessions: number } {
    return Object.fromEntries(['events', 'jobs', 'sessions'].map(table => [table,
      (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n])) as { events: number; jobs: number; sessions: number };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
    finally {
      try { this.db.close(); }
      finally { this.lock.close(); }
    }
  }
}
