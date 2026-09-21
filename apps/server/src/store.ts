import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  Artifact,
  ContextSource,
  Document,
  Event,
  Integration,
  Repository,
  Run,
  User,
} from '../../../shared/types.js';
import { hash, redact } from './security.js';
interface Sql {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export class Store {
  private constructor(
    private db: Sql,
    private closer: () => Promise<void>,
  ) {}
  static async open(directory?: string, databaseUrl?: string) {
    let store: Store;
    if (databaseUrl) {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      store = new Store(pool, () => pool.end());
    } else {
      if (directory) await mkdir(directory, { recursive: true });
      const db = new PGlite(directory ? join(directory, 'database') : undefined);
      await db.waitReady;
      store = new Store(db, () => db.close());
    }
    await store.migrate();
    return store;
  }
  async migrate() {
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz DEFAULT now());`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS entities (id text PRIMARY KEY, kind text NOT NULL, data jsonb NOT NULL);`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, repository_id text NOT NULL, status text NOT NULL, data jsonb NOT NULL);`,
    );
    await this.db.query(`DROP INDEX IF EXISTS one_active_repository;`);
    await this.db.query(
      `CREATE UNIQUE INDEX one_active_repository ON runs(repository_id) WHERE status IN ('running','repairing','needs_input','needs_review','awaiting_approval');`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, run_id text NOT NULL, data jsonb NOT NULL);`,
    );
    await this.db.query(`CREATE INDEX IF NOT EXISTS run_events ON events(run_id,id);`);
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, data jsonb NOT NULL, created_at timestamptz DEFAULT now());`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL);`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS monitors (run_id text PRIMARY KEY, failures integer NOT NULL DEFAULT 0, last_check timestamptz, incident_run_id text);`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS secrets (id text PRIMARY KEY, value text NOT NULL, updated_at timestamptz DEFAULT now());`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS document_chunks (
        document_id text NOT NULL,
        chunk_index integer NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        PRIMARY KEY(document_id, chunk_index)
      );`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS document_chunks_search ON document_chunks USING gin(to_tsvector('english', title || ' ' || content));`,
    );
    await this.db.query(`INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;`);
    const version = await this.db.query<{ version: number }>('SELECT version FROM schema_migrations WHERE version=2');
    if (!version.rows.length) {
      await this.db.query("DELETE FROM runs WHERE data->'workspace' IS NULL");
      await this.db.query(`INSERT INTO schema_migrations(version) VALUES (2);`);
    }
    const searchVersion = await this.db.query<{ version: number }>(
      'SELECT version FROM schema_migrations WHERE version=3',
    );
    if (!searchVersion.rows.length) {
      for (const document of await this.documents()) await this.indexDocument(document);
      await this.db.query(`INSERT INTO schema_migrations(version) VALUES (3);`);
    }
  }
  async put<T extends { id: string }>(kind: string, value: T) {
    await this.db.query('INSERT INTO entities(id,kind,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=$3', [
      value.id,
      kind,
      JSON.stringify(value),
    ]);
  }
  async get<T>(kind: string, id: string): Promise<T | undefined> {
    return (await this.db.query<{ data: T }>('SELECT data FROM entities WHERE kind=$1 AND id=$2', [kind, id])).rows[0]
      ?.data;
  }
  async list<T>(kind: string): Promise<T[]> {
    return (
      await this.db.query<{ data: T }>("SELECT data FROM entities WHERE kind=$1 ORDER BY data->>'createdAt' DESC", [
        kind,
      ])
    ).rows.map((x) => x.data);
  }
  async delete(kind: string, id: string) {
    await this.db.query('DELETE FROM entities WHERE kind=$1 AND id=$2', [kind, id]);
  }
  repositories() {
    return this.list<Repository>('repository');
  }
  documents() {
    return this.list<Document>('document');
  }
  integrations() {
    return this.list<Integration>('integration');
  }
  private documentChunks(content: string, size = 1_800, overlap = 200) {
    const chunks: string[] = [];
    let start = 0;
    while (start < content.length) {
      let end = Math.min(start + size, content.length);
      if (end < content.length) {
        const paragraph = content.lastIndexOf('\n\n', end);
        const line = content.lastIndexOf('\n', end);
        const boundary = Math.max(paragraph, line);
        if (boundary > start + size / 2) end = boundary;
      }
      const chunk = content.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      if (end >= content.length) break;
      start = Math.max(start + 1, end - overlap);
    }
    return chunks;
  }
  private async indexDocument(document: Document) {
    await this.db.query('DELETE FROM document_chunks WHERE document_id=$1', [document.id]);
    for (const [index, content] of this.documentChunks(document.content).entries())
      await this.db.query('INSERT INTO document_chunks(document_id,chunk_index,title,content) VALUES($1,$2,$3,$4)', [
        document.id,
        index,
        document.title,
        content,
      ]);
  }
  async putDocument(document: Document) {
    await this.put('document', document);
    await this.indexDocument(document);
  }
  async searchDocuments(query: string): Promise<ContextSource[]> {
    const search = query.trim().slice(0, 2_000);
    if (!search) return [];
    const rows = await this.db.query<{ data: Document; excerpt: string }>(
      `WITH search_query AS (
        SELECT websearch_to_tsquery('english', replace($1, ' ', ' OR ')) AS value
      ), matches AS (
        SELECT document_id, chunk_index,
          ts_rank_cd(to_tsvector('english', title || ' ' || content), search_query.value) AS rank,
          ts_headline('english', content, search_query.value,
            'StartSel=<<, StopSel=>>, MaxFragments=3, MaxWords=100, MinWords=20') AS excerpt
        FROM document_chunks, search_query
        WHERE to_tsvector('english', title || ' ' || content) @@ search_query.value
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY document_id ORDER BY rank DESC, chunk_index) AS document_rank
        FROM matches
      )
      SELECT entity.data, ranked.excerpt
      FROM ranked
      JOIN entities entity ON entity.id=ranked.document_id AND entity.kind='document'
      WHERE ranked.document_rank=1
      ORDER BY ranked.rank DESC
      LIMIT 4`,
      [search],
    );
    let remaining = 6_000;
    return rows.rows.flatMap(({ data, excerpt }) => {
      if (remaining <= 0) return [];
      const bounded = excerpt.slice(0, Math.min(1_800, remaining));
      remaining -= bounded.length;
      return [{ id: data.id, title: data.title, version: data.version, hash: data.hash, excerpt: bounded }];
    });
  }
  async insertRun(run: Run) {
    await this.db.query('INSERT INTO runs(id,repository_id,status,data) VALUES($1,$2,$3,$4)', [
      run.id,
      run.repositoryId,
      run.status,
      JSON.stringify(run),
    ]);
  }
  async getRun(id: string): Promise<Run | undefined> {
    return (await this.db.query<{ data: Run }>('SELECT data FROM runs WHERE id=$1', [id])).rows[0]?.data;
  }
  async runs() {
    return (
      await this.db.query<{ data: Run }>("SELECT data FROM runs ORDER BY data->>'createdAt' DESC LIMIT 200")
    ).rows.map((x) => x.data);
  }
  async saveRun(run: Run) {
    run.updatedAt = new Date().toISOString();
    const result = await this.db.query('UPDATE runs SET status=$2,data=$3 WHERE id=$1 RETURNING id', [
      run.id,
      run.status,
      JSON.stringify(run),
    ]);
    if (!result.rows.length) throw new Error('Run no longer exists');
  }
  async event(run: Run, kind: string, message: string, data?: unknown) {
    const event = {
      runId: run.id,
      phase: run.phase,
      time: new Date().toISOString(),
      kind,
      message: redact(message),
      data,
    };
    await this.db.query('INSERT INTO events(run_id,data) VALUES($1,$2)', [run.id, JSON.stringify(event)]);
  }
  async events(id: string): Promise<Event[]> {
    return (
      await this.db.query<{ id: number; data: Event }>(
        'SELECT id,data FROM events WHERE run_id=$1 ORDER BY id LIMIT 500',
        [id],
      )
    ).rows.map((x) => ({ ...x.data, id: Number(x.id) }));
  }
  async artifact(run: Run, name: string, content: string) {
    const clean = redact(content);
    const artifact: Artifact = {
      id: randomUUID(),
      runId: run.id,
      name,
      hash: hash(clean),
      candidateDigest: run.candidateDigest || run.workspace.digest,
      createdAt: new Date().toISOString(),
      content: clean,
    };
    await this.put('artifact', artifact);
    return artifact;
  }
  async artifacts(runId: string): Promise<Artifact[]> {
    const artifacts = await this.list<Artifact>('artifact');
    return artifacts.filter((a) => a.runId === runId).map(({ content: _content, ...a }) => a);
  }
  async audit(actor: string, action: string, data: unknown) {
    await this.db.query('INSERT INTO audit(actor,action,data) VALUES($1,$2,$3)', [actor, action, JSON.stringify(data)]);
  }
  async audits() {
    return (await this.db.query('SELECT * FROM audit ORDER BY id DESC LIMIT 200')).rows;
  }
  async session(id: string) {
    return (
      await this.db.query<{ data: { user: User; csrf: string } }>(
        'SELECT data FROM sessions WHERE id=$1 AND expires_at>now()',
        [id],
      )
    ).rows[0]?.data;
  }
  async setSession(id: string, user: User, csrf: string) {
    await this.db.query("INSERT INTO sessions(id,data,expires_at) VALUES($1,$2,now()+interval '12 hours')", [
      id,
      JSON.stringify({ user, csrf }),
    ]);
  }
  async deleteSession(id: string) {
    await this.db.query('DELETE FROM sessions WHERE id=$1', [id]);
  }
  async monitor(id: string) {
    await this.db.query('INSERT INTO monitors(run_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    return (
      await this.db.query<{ failures: number; last_check: Date | null }>('SELECT * FROM monitors WHERE run_id=$1', [id])
    ).rows[0];
  }
  async updateMonitor(id: string, failures: number) {
    await this.db.query('UPDATE monitors SET failures=$2,last_check=now() WHERE run_id=$1', [id, failures]);
  }
  async setSecret(id: string, value: string) {
    await this.db.query(
      'INSERT INTO secrets(id,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(id) DO UPDATE SET value=$2,updated_at=now()',
      [id, value],
    );
  }
  async secret(id: string) {
    return (await this.db.query<{ value: string }>('SELECT value FROM secrets WHERE id=$1', [id])).rows[0]?.value;
  }
  async deleteSecret(id: string) {
    await this.db.query('DELETE FROM secrets WHERE id=$1', [id]);
  }
  close() {
    return this.closer();
  }
}
