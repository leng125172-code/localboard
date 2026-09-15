import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
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
      CREATE TABLE IF NOT EXISTS agent_contexts (
        context_key TEXT PRIMARY KEY,
        session_id TEXT,
        agent_id TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        reported_by_agent INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        github_account TEXT,
        favorite_projects_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `);
    ensureColumn(this.db, 'notes', 'visible', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(this.db, 'notes', 'desktop_pinned', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'notes', 'font_size', 'INTEGER NOT NULL DEFAULT 14');
    ensureColumn(this.db, 'projects', 'reported_by_agent', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      UPDATE projects
      SET reported_by_agent=1
      WHERE EXISTS (
        SELECT 1 FROM agent_contexts
        WHERE source NOT LIKE 'e2e%'
          AND json_extract(agent_contexts.payload_json, '$.repository.projectId')=projects.project_id
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

  getGitHubCache(key, maxAgeSeconds = 30) {
    const row = this.db.prepare('SELECT value_json AS valueJson, fetched_at AS fetchedAt FROM github_cache WHERE cache_key=?').get(key);
    if (!row) return null;
    if (Date.now() - new Date(row.fetchedAt).getTime() > Number(maxAgeSeconds) * 1000) return null;
    return JSON.parse(row.valueJson);
  }

  putGitHubCache(key, value) {
    this.db.prepare(`
      INSERT INTO github_cache(cache_key,value_json,fetched_at) VALUES (?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,fetched_at=excluded.fetched_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  clearGitHubCache() {
    return { deleted: this.db.prepare('DELETE FROM github_cache').run().changes };
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

  upsertAgentContext(context) {
    if (!context?.contextKey) throw new Error('contextKey is required');
    if (!context.repository || typeof context.repository !== 'object') throw new Error('repository context is required');
    const value = {
      ...context,
      contextKey: String(context.contextKey),
      source: String(context.source ?? 'unknown'),
      status: String(context.status ?? 'active'),
      updatedAt: new Date().toISOString()
    };
    this.db.prepare(`
      INSERT INTO agent_contexts(context_key,session_id,agent_id,source,status,payload_json,updated_at)
      VALUES (@contextKey,@sessionId,@agentId,@source,@status,@payloadJson,@updatedAt)
      ON CONFLICT(context_key) DO UPDATE SET session_id=excluded.session_id,
        agent_id=excluded.agent_id,source=excluded.source,status=excluded.status,
        payload_json=excluded.payload_json,updated_at=excluded.updated_at
    `).run({
      contextKey: value.contextKey,
      sessionId: value.sessionId ?? null,
      agentId: value.agentId ?? null,
      source: value.source,
      status: value.status,
      payloadJson: JSON.stringify(value),
      updatedAt: value.updatedAt
    });
    return value;
  }

  listAgentContexts(options = {}) {
    const includeEnded = options.includeEnded !== false;
    const activeSince = new Date(Date.now() - Number(options.maxAgeHours ?? 24) * 60 * 60 * 1000).toISOString();
    const staleBefore = Date.now() - Number(options.staleAfterMinutes ?? 30) * 60 * 1000;
    const rows = includeEnded
      ? this.db.prepare('SELECT payload_json AS payloadJson, updated_at AS updatedAt FROM agent_contexts ORDER BY updated_at DESC').all()
      : this.db.prepare("SELECT payload_json AS payloadJson, updated_at AS updatedAt FROM agent_contexts WHERE status != 'ended' AND updated_at >= ? ORDER BY updated_at DESC").all(activeSince);
    return rows.map((row) => {
      const value = JSON.parse(row.payloadJson);
      if (value.status === 'active' && new Date(row.updatedAt).getTime() < staleBefore) return { ...value, status: 'stale' };
      return value;
    });
  }

  agentStatus(options = {}) {
    const contexts = this.listAgentContexts({ includeEnded: false, maxAgeHours: options.maxAgeHours ?? 24,
      staleAfterMinutes: options.staleAfterMinutes ?? 30 });
    const connected = contexts.filter((item) => item.status !== 'stale');
    const counts = {};
    for (const context of connected) counts[context.status] = (counts[context.status] ?? 0) + 1;
    return {
      connected: connected.length,
      mainAgents: connected.filter((item) => !item.agentId).length,
      subagents: connected.filter((item) => item.agentId).length,
      stale: contexts.length - connected.length,
      counts,
      contexts
    };
  }

  deleteAgentContext(contextKey) {
    return { deleted: this.db.prepare('DELETE FROM agent_contexts WHERE context_key=?').run(contextKey).changes === 1 };
  }

  upsertProject(context, options = {}) {
    if (!context?.projectId || !context?.cwd) throw new Error('projectId and cwd are required');
    const path = context.repoRoot ?? context.cwd;
    const existing = this.db.prepare(`SELECT project_id AS projectId,pinned,github_account AS githubAccount,
      favorite_projects_json AS favoriteProjectsJson,reported_by_agent AS reportedByAgent,created_at AS createdAt FROM projects WHERE project_id=? OR path=?
      ORDER BY project_id=? DESC LIMIT 1`).get(context.projectId, path, context.projectId);
    if (existing && existing.projectId !== context.projectId) {
      this.db.prepare('DELETE FROM projects WHERE project_id=?').run(existing.projectId);
    }
    const now = new Date().toISOString();
    const value = {
      ...context,
      pinned: Boolean(existing?.pinned),
      githubAccount: existing?.githubAccount ?? context.expectedGithubAccount ?? null,
      favoriteProjects: existing ? JSON.parse(existing.favoriteProjectsJson) : [],
      reportedByAgent: Boolean(existing?.reportedByAgent || options.reportedByAgent !== false),
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now
    };
    this.db.prepare(`
      INSERT INTO projects(project_id,path,kind,payload_json,reported_by_agent,pinned,github_account,favorite_projects_json,created_at,last_seen_at)
      VALUES (@projectId,@path,@kind,@payloadJson,@reportedByAgent,@pinned,@githubAccount,@favoriteProjectsJson,@createdAt,@lastSeenAt)
      ON CONFLICT(project_id) DO UPDATE SET path=excluded.path,kind=excluded.kind,payload_json=excluded.payload_json,
        reported_by_agent=MAX(projects.reported_by_agent,excluded.reported_by_agent),last_seen_at=excluded.last_seen_at
    `).run({
      projectId: value.projectId,
      path,
      kind: value.projectKind,
      payloadJson: JSON.stringify(value),
      reportedByAgent: value.reportedByAgent ? 1 : 0,
      pinned: value.pinned ? 1 : 0,
      githubAccount: value.githubAccount,
      favoriteProjectsJson: JSON.stringify(value.favoriteProjects),
      createdAt: value.createdAt,
      lastSeenAt: value.lastSeenAt
    });
    return value;
  }

  listProjects(options = {}) {
    const maxAgeDays = Number(options.maxAgeDays ?? 30);
    const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
    return this.db.prepare(`SELECT payload_json AS payloadJson,pinned,github_account AS githubAccount,
      favorite_projects_json AS favoriteProjectsJson,created_at AS createdAt,last_seen_at AS lastSeenAt
      FROM projects WHERE reported_by_agent=1 AND (pinned=1 OR last_seen_at>=?) ORDER BY pinned DESC,last_seen_at DESC`).all(cutoff)
      .map(projectRow)
      .filter((project) => existsSync(project.repoRoot ?? project.cwd));
  }

  getProject(projectId) {
    const row = this.db.prepare(`SELECT payload_json AS payloadJson,pinned,github_account AS githubAccount,
      favorite_projects_json AS favoriteProjectsJson,created_at AS createdAt,last_seen_at AS lastSeenAt
      FROM projects WHERE project_id=?`).get(projectId);
    return row ? projectRow(row) : null;
  }

  updateProjectPreferences(projectId, patch = {}) {
    const current = this.getProject(projectId);
    if (!current) throw new Error(`Project not found: ${projectId}`);
    const pinned = patch.pinned === undefined ? current.pinned : Boolean(patch.pinned);
    const githubAccount = patch.githubAccount === undefined ? current.githubAccount : patch.githubAccount;
    const favoriteProjects = patch.favoriteProjects === undefined ? current.favoriteProjects : [...new Set(patch.favoriteProjects.map(String))];
    this.db.prepare(`UPDATE projects SET pinned=?,github_account=?,favorite_projects_json=? WHERE project_id=?`)
      .run(pinned ? 1 : 0, githubAccount ?? null, JSON.stringify(favoriteProjects), projectId);
    return { ...current, pinned, githubAccount, favoriteProjects };
  }

  deleteProject(projectId) {
    return { deleted: this.db.prepare('DELETE FROM projects WHERE project_id=?').run(projectId).changes === 1 };
  }

  saveNote(note) {
    const existing = note.id ? this.db.prepare(`
      SELECT id,title,body,color,x,y,width,height,always_on_top AS alwaysOnTop,visible,
             desktop_pinned AS desktopPinned,font_size AS fontSize,updated_at AS updatedAt
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
      visible: (note.visible ?? Boolean(existing?.visible ?? true)) ? 1 : 0,
      desktopPinned: (note.desktopPinned ?? Boolean(existing?.desktopPinned ?? false)) ? 1 : 0,
      fontSize: Math.max(11, Math.min(24, Number(note.fontSize ?? existing?.fontSize ?? 14))),
      updatedAt: now
    };
    this.db.prepare(`
      INSERT INTO notes(id,title,body,color,x,y,width,height,always_on_top,visible,desktop_pinned,font_size,updated_at)
      VALUES (@id,@title,@body,@color,@x,@y,@width,@height,@alwaysOnTop,@visible,@desktopPinned,@fontSize,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body,
        color=excluded.color, x=excluded.x, y=excluded.y, width=excluded.width,
        height=excluded.height, always_on_top=excluded.always_on_top,visible=excluded.visible,
        desktop_pinned=excluded.desktop_pinned,font_size=excluded.font_size,updated_at=excluded.updated_at
    `).run(value);
    return { ...value, alwaysOnTop: Boolean(value.alwaysOnTop), visible: Boolean(value.visible), desktopPinned: Boolean(value.desktopPinned) };
  }

  listNotes() {
    return this.db.prepare(`
      SELECT id,title,body,color,x,y,width,height,always_on_top AS alwaysOnTop,visible,
             desktop_pinned AS desktopPinned,font_size AS fontSize,updated_at AS updatedAt
      FROM notes ORDER BY updated_at DESC
    `).all().map((note) => ({ ...note, alwaysOnTop: Boolean(note.alwaysOnTop), visible: Boolean(note.visible), desktopPinned: Boolean(note.desktopPinned) }));
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

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function projectRow(row) {
  return {
    ...JSON.parse(row.payloadJson),
    pinned: Boolean(row.pinned),
    githubAccount: row.githubAccount ?? null,
    favoriteProjects: JSON.parse(row.favoriteProjectsJson ?? '[]'),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt
  };
}
