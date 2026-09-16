import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Artifact, Document, Event, Integration, Repository, Run, User } from '../../../shared/types.js';
import { hash, redact } from './security.js';
interface Sql { query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> }
export class Store {
  private constructor(private db: Sql, private closer: () => Promise<void>) {}
  static async open(directory?: string, databaseUrl?: string) {
    let store: Store;
    if (databaseUrl) { const pool = new pg.Pool({ connectionString: databaseUrl }); store = new Store(pool, () => pool.end()); }
    else { if (directory) await mkdir(directory, { recursive: true }); const db = new PGlite(directory ? join(directory, 'database') : undefined); await db.waitReady; store = new Store(db, () => db.close()); }
    await store.migrate(); return store;
  }
  async migrate() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz DEFAULT now());`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS entities (id text PRIMARY KEY, kind text NOT NULL, data jsonb NOT NULL);`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, repository_id text NOT NULL, status text NOT NULL, data jsonb NOT NULL, lease_token text, lease_until timestamptz);`);
    await this.db.query(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_repository ON runs(repository_id) WHERE status IN ('queued','running','repairing','needs_input','awaiting_approval');`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, run_id text NOT NULL, data jsonb NOT NULL);`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS run_events ON events(run_id,id);`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, data jsonb NOT NULL, created_at timestamptz DEFAULT now());`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL);`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS monitors (run_id text PRIMARY KEY, failures integer NOT NULL DEFAULT 0, last_check timestamptz, incident_run_id text);`);
    await this.db.query(`INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;`);
  }
  async put<T extends { id: string }>(kind: string, value: T) { await this.db.query('INSERT INTO entities(id,kind,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=$3', [value.id, kind, JSON.stringify(value)]); }
  async get<T>(kind: string, id: string): Promise<T | undefined> { return (await this.db.query<{ data: T }>('SELECT data FROM entities WHERE kind=$1 AND id=$2', [kind, id])).rows[0]?.data; }
  async list<T>(kind: string): Promise<T[]> { return (await this.db.query<{ data: T }>('SELECT data FROM entities WHERE kind=$1 ORDER BY data->>\'createdAt\' DESC', [kind])).rows.map(x => x.data); }
  repositories() { return this.list<Repository>('repository'); }
  documents() { return this.list<Document>('document'); }
  integrations() { return this.list<Integration>('integration'); }
  async searchDocuments(query: string): Promise<Document[]> {
    const terms = query.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g)?.slice(0, 30).join(' OR ') || '';
    if (!terms) return [];
    return (await this.db.query<{ data: Document }>(`SELECT data FROM entities WHERE kind='document' AND to_tsvector('english',(data->>'title')||' '||(data->>'content')) @@ websearch_to_tsquery('english',$1) ORDER BY ts_rank(to_tsvector('english',data->>'content'),websearch_to_tsquery('english',$1)) DESC LIMIT 8`, [terms])).rows.map(x => x.data);
  }
  async insertRun(run: Run) { await this.db.query('INSERT INTO runs(id,repository_id,status,data) VALUES($1,$2,$3,$4)', [run.id, run.repositoryId, run.status, JSON.stringify(run)]); }
  async getRun(id: string): Promise<Run | undefined> { return (await this.db.query<{ data: Run }>('SELECT data FROM runs WHERE id=$1', [id])).rows[0]?.data; }
  async runs() { return (await this.db.query<{ data: Run }>('SELECT data FROM runs ORDER BY data->>\'createdAt\' DESC LIMIT 200')).rows.map(x => x.data); }
  async saveRun(run: Run, token?: string) {
    run.updatedAt = new Date().toISOString();
    const result = await this.db.query(`UPDATE runs SET status=$2,data=$3 WHERE id=$1 ${token ? 'AND lease_token=$4' : ''} RETURNING id`, [run.id, run.status, JSON.stringify(run), ...(token ? [token] : [])]);
    if (!result.rows.length) throw new Error('Run lease lost; stale worker cannot write');
  }
  async claim(id: string): Promise<{ run: Run; token: string } | undefined> {
    const token = randomUUID();
    const result = await this.db.query<{ data: Run }>(`UPDATE runs SET lease_token=$2,lease_until=now()+interval '45 seconds' WHERE id=$1 AND status IN ('queued','running','repairing') AND (lease_until IS NULL OR lease_until<now()) RETURNING data`, [id, token]);
    return result.rows[0] ? { run: result.rows[0].data, token } : undefined;
  }
  async heartbeat(id: string, token: string) { await this.db.query("UPDATE runs SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND lease_token=$2", [id, token]); }
  async release(id: string, token: string) { await this.db.query('UPDATE runs SET lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2', [id, token]); }
  async revoke(id: string) { await this.db.query('UPDATE runs SET lease_until=NULL,lease_token=NULL WHERE id=$1', [id]); }
  async event(run: Run, kind: string, message: string, data?: unknown) {
    const event = { runId: run.id, phase: run.phase, time: new Date().toISOString(), kind, message: redact(message), data };
    await this.db.query('INSERT INTO events(run_id,data) VALUES($1,$2)', [run.id, JSON.stringify(event)]);
  }
  async events(id: string, after = 0): Promise<Event[]> { return (await this.db.query<{ id: number; data: Event }>('SELECT id,data FROM events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 500', [id, after])).rows.map(x => ({ ...x.data, id: Number(x.id) })); }
  async artifact(run: Run, name: string, content: string) {
    const clean = redact(content); const artifact: Artifact = { id: randomUUID(), runId: run.id, name, hash: hash(clean), candidateSha: run.candidateSha || run.baseSha || '', createdAt: new Date().toISOString(), content: clean };
    await this.put('artifact', artifact); return artifact;
  }
  async artifacts(runId: string): Promise<Artifact[]> { const artifacts = await this.list<Artifact>('artifact'); return artifacts.filter(a => a.runId === runId).map(({ content: _content, ...a }) => a); }
  async audit(actor: string, action: string, data: unknown) { await this.db.query('INSERT INTO audit(actor,action,data) VALUES($1,$2,$3)', [actor, action, JSON.stringify(data)]); }
  async audits() { return (await this.db.query('SELECT * FROM audit ORDER BY id DESC LIMIT 200')).rows; }
  async session(id: string) { return (await this.db.query<{ data: { user: User; csrf: string } }>('SELECT data FROM sessions WHERE id=$1 AND expires_at>now()', [id])).rows[0]?.data; }
  async setSession(id: string, user: User, csrf: string) { await this.db.query("INSERT INTO sessions(id,data,expires_at) VALUES($1,$2,now()+interval '12 hours')", [id, JSON.stringify({ user, csrf })]); }
  async deleteSession(id: string) { await this.db.query('DELETE FROM sessions WHERE id=$1', [id]); }
  async monitor(id: string) { await this.db.query('INSERT INTO monitors(run_id) VALUES($1) ON CONFLICT DO NOTHING', [id]); return (await this.db.query<{ failures: number; last_check: Date | null; incident_run_id: string | null }>('SELECT * FROM monitors WHERE run_id=$1', [id])).rows[0]; }
  async updateMonitor(id: string, failures: number, incident?: string | null) { await this.db.query('UPDATE monitors SET failures=$2,last_check=now(),incident_run_id=COALESCE($3,incident_run_id) WHERE run_id=$1', [id, failures, incident || null]); }
  close() { return this.closer(); }
}
