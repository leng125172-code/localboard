import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class StateDatabase {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT UNIQUE NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        event_name TEXT NOT NULL,
        cwd TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        color TEXT NOT NULL,
        x INTEGER,
        y INTEGER,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        always_on_top INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_cache (
        cache_key TEXT PRIMARY KEY,
        etag TEXT,
        value_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
  }

  getIdempotent(key) {
    if (!key) return null;
    const row = this.db.prepare('SELECT result_json FROM idempotency WHERE key = ?').get(key);
    return row ? JSON.parse(row.result_json) : null;
  }

  putIdempotent(key, result) {
    if (!key) return;
    this.db.prepare('INSERT OR IGNORE INTO idempotency(key, result_json, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(result), new Date().toISOString());
  }

  recordAgentEvent(payload, eventKey) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO agent_events(event_key, session_id, turn_id, event_name, cwd, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventKey,
      payload.session_id ?? null,
      payload.turn_id ?? null,
      payload.hook_event_name ?? 'unknown',
      payload.cwd ?? null,
      JSON.stringify(payload),
      new Date().toISOString()
    );
    return { inserted: result.changes === 1 };
  }

  listAgentEvents(limit = 100) {
    return this.db.prepare(`
      SELECT event_key AS eventKey, session_id AS sessionId, turn_id AS turnId,
             event_name AS eventName, cwd, created_at AS createdAt
      FROM agent_events ORDER BY id DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit))));
  }

  saveNote(note) {
    const existing = note.id ? this.db.prepare(`
      SELECT id,title,body,color,x,y,width,height,always_on_top AS alwaysOnTop,updated_at AS updatedAt
      FROM notes WHERE id=?
    `).get(note.id) : null;
    const now = new Date().toISOString();
    const requestedColor = note.color ?? existing?.color ?? '#fff3a6';
    const value = {
      id: note.id || randomUUID(),
      title: String(note.title ?? existing?.title ?? '便签'),
      body: String(note.body ?? existing?.body ?? ''),
      color: /^#[0-9a-f]{6}$/i.test(requestedColor) ? requestedColor : '#fff3a6',
      x: note.x ?? existing?.x ?? null,
      y: note.y ?? existing?.y ?? null,
      width: Number(note.width ?? existing?.width ?? 320),
      height: Number(note.height ?? existing?.height ?? 280),
      alwaysOnTop: (note.alwaysOnTop ?? Boolean(existing?.alwaysOnTop ?? true)) ? 1 : 0,
      updatedAt: now
    };
    this.db.prepare(`
      INSERT INTO notes(id,title,body,color,x,y,width,height,always_on_top,updated_at)
      VALUES (@id,@title,@body,@color,@x,@y,@width,@height,@alwaysOnTop,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body,
        color=excluded.color, x=excluded.x, y=excluded.y, width=excluded.width,
        height=excluded.height, always_on_top=excluded.always_on_top, updated_at=excluded.updated_at
    `).run(value);
    return { ...value, alwaysOnTop: Boolean(value.alwaysOnTop) };
  }

  listNotes() {
    return this.db.prepare(`
      SELECT id,title,body,color,x,y,width,height,always_on_top AS alwaysOnTop,updated_at AS updatedAt
      FROM notes ORDER BY updated_at DESC
    `).all().map((note) => ({ ...note, alwaysOnTop: Boolean(note.alwaysOnTop) }));
  }

  deleteNote(id) {
    return { deleted: this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes === 1 };
  }

  enqueue(kind, payload, idempotencyKey) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox(id,kind,idempotency_key,payload_json,status,created_at,updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, kind, idempotencyKey, JSON.stringify(payload), now, now);
    return this.db.prepare(`
      SELECT id,kind,idempotency_key AS idempotencyKey,payload_json AS payloadJson,status,attempts,last_error AS lastError,
             created_at AS createdAt,updated_at AS updatedAt FROM outbox WHERE idempotency_key = ?
    `).get(idempotencyKey);
  }

  markOutbox(id, status, error = null) {
    this.db.prepare(`UPDATE outbox SET status=?, attempts=attempts+1, last_error=?, updated_at=? WHERE id=?`)
      .run(status, error, new Date().toISOString(), id);
  }

  listOutbox(status = null) {
    const sql = `SELECT id,kind,idempotency_key AS idempotencyKey,payload_json AS payloadJson,status,attempts,
      last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt FROM outbox`;
    const rows = status
      ? this.db.prepare(`${sql} WHERE status=? ORDER BY created_at`).all(status)
      : this.db.prepare(`${sql} ORDER BY created_at`).all();
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payloadJson), payloadJson: undefined }));
  }

  setCache(key, value, etag = null) {
    this.db.prepare(`
      INSERT INTO github_cache(cache_key,etag,value_json,fetched_at) VALUES (?,?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET etag=excluded.etag,value_json=excluded.value_json,fetched_at=excluded.fetched_at
    `).run(key, etag, JSON.stringify(value), new Date().toISOString());
  }

  getCache(key) {
    const row = this.db.prepare('SELECT etag,value_json AS valueJson,fetched_at AS fetchedAt FROM github_cache WHERE cache_key=?').get(key);
    return row ? { etag: row.etag, value: JSON.parse(row.valueJson), fetchedAt: row.fetchedAt } : null;
  }

  close() {
    this.db.close();
  }
}
