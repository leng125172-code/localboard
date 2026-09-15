import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, StateDatabase } from '../src/core/state-db.mjs';

test('persists idempotency and merges partial note updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-db-'));
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    state.putIdempotent('same-op', { ok: true });
    assert.deepEqual(state.getIdempotent('same-op'), { ok: true });
    const note = state.saveNote({ title: 'A', body: 'keep me', color: '#fff3a6' });
    state.saveNote({ id: note.id, x: 42 });
    assert.equal(state.listNotes()[0].body, 'keep me');
    assert.equal(state.listNotes()[0].x, 42);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps concurrent Codex contexts isolated by context key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-contexts-'));
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    const repository = { cwd: 'C:/repo', isGitRepository: true, syncReason: 'github-not-configured' };
    state.upsertAgentContext({ contextKey: 'codex:a:main', sessionId: 'a', status: 'active', repository });
    state.upsertAgentContext({ contextKey: 'codex:b:main', sessionId: 'b', status: 'active', repository });
    state.upsertAgentContext({ contextKey: 'codex:a:main', sessionId: 'a', status: 'idle', repository });
    const contexts = state.listAgentContexts();
    assert.equal(contexts.length, 2);
    assert.equal(contexts.find((item) => item.sessionId === 'a').status, 'idle');
    assert.equal(contexts.find((item) => item.sessionId === 'b').status, 'active');
    assert.equal(state.listAgentContexts({ staleAfterMinutes: -1 }).find((item) => item.sessionId === 'b').status, 'stale');
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps a Codex session bound to its exact launch directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-launch-directory-'));
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    const launchRepository = { cwd: 'D:/GitRepos/GithubCode', projectId: 'path:parent', isGitRepository: false };
    const nestedRepository = { cwd: 'D:/GitRepos/GithubCode/leng125172-code/localboard', repoRoot: 'D:/GitRepos/GithubCode/leng125172-code/localboard', projectId: 'worktree:nested', isGitRepository: true };
    state.upsertAgentContext({ contextKey: 'codex:session:main', eventName: 'SessionStart', repository: launchRepository });
    const updated = state.upsertAgentContext({ contextKey: 'codex:session:main', source: 'skill', repository: nestedRepository });
    assert.equal(updated.repository.cwd, launchRepository.cwd);
    assert.equal(updated.repository.projectId, launchRepository.projectId);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates a discovered path from non-Git to Git without duplicate projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-project-migration-'));
  const work = join(root, 'work');
  await mkdir(work);
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    state.upsertProject({ projectId: 'path:one', projectKind: 'non-git', repositoryName: 'work', cwd: work, isGitRepository: false });
    state.updateProjectPreferences('path:one', { pinned: true });
    const migrated = state.upsertProject({ projectId: 'worktree:one', projectKind: 'git', repositoryName: 'work', cwd: work, repoRoot: work, isGitRepository: true });
    assert.equal(migrated.pinned, true);
    assert.equal(state.listProjects({ includeTemporary: true }).length, 1);
    assert.equal(state.listProjects()[0].projectId, 'worktree:one');
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('hides reported projects after their working directory is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-project-expiry-'));
  const work = join(root, 'temporary-work');
  await mkdir(work);
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    state.upsertProject({ projectId: 'path:temp', projectKind: 'non-git', repositoryName: 'temp', cwd: work, isGitRepository: false });
    assert.equal(state.listProjects().length, 0);
    assert.equal(state.listProjects({ includeTemporary: true }).length, 1);
    state.updateProjectPreferences('path:temp', { pinned: true });
    assert.equal(state.listProjects().length, 1);
    await rm(work, { recursive: true, force: true });
    assert.equal(state.listProjects().length, 0);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not list a path that was only inspected by the desktop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-project-source-'));
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    const project = { projectId: 'path:desktop', projectKind: 'non-git', repositoryName: 'desktop', cwd: root, isGitRepository: false };
    state.upsertProject(project, { reportedByAgent: false });
    assert.equal(state.listProjects({ includeTemporary: true }).length, 0);
    state.upsertProject(project, { reportedByAgent: true });
    assert.equal(state.listProjects({ includeTemporary: true }).length, 1);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates legacy notes without losing data and adds layout state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-note-migration-'));
  const path = join(root, 'state.sqlite3');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, color TEXT NOT NULL,
      x INTEGER, y INTEGER, width INTEGER NOT NULL, height INTEGER NOT NULL,
      always_on_top INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  legacy.prepare(`INSERT INTO notes(id,title,body,color,x,y,width,height,always_on_top,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run('legacy', '旧便签', '不得丢失', '#fff3a6', 1, 2, 320, 280, 1, new Date().toISOString());
  legacy.close();

  const state = new StateDatabase(path);
  try {
    const [note] = state.listNotes();
    assert.equal(note.id, 'legacy');
    assert.equal(note.body, '不得丢失');
    assert.deepEqual(note.layout, {});
    assert.deepEqual(note.dock, {});

    state.saveNote({ id: 'legacy', layout: { preset: 'medium', sections: [30, 17, 23, 30] }, dock: { edge: 'left' } });
    const updated = state.listNotes()[0];
    assert.equal(updated.body, '不得丢失');
    assert.deepEqual(updated.layout, { preset: 'medium', sections: [30, 17, 23, 30] });
    assert.deepEqual(updated.dock, { edge: 'left' });
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('persists normalized settings, supports partial sticky patches, and resets defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-settings-'));
  const path = join(root, 'state.sqlite3');
  let state = new StateDatabase(path);
  try {
    assert.deepEqual(state.getSettings(), DEFAULT_SETTINGS);
    const patched = state.patchSettings({
      theme: 'dark',
      projectPaneExpanded: true,
      sticky: { snapDistance: 24, collapseDelay: 900 }
    });
    assert.equal(patched.theme, 'dark');
    assert.equal(patched.projectPaneExpanded, true);
    assert.deepEqual(patched.sticky, {
      snapDistance: 24,
      collapseDelay: 900,
      handleWidth: 12,
      defaultPreset: 'medium',
      reduceMotion: false
    });

    state.close();
    state = new StateDatabase(path);
    assert.equal(state.getSettings().theme, 'dark');
    assert.equal(state.getSettings().sticky.snapDistance, 24);

    const normalized = state.patchSettings({ theme: 'purple', mica: 'yes', sticky: {
      snapDistance: 1000, handleWidth: 1, defaultPreset: 'giant', reduceMotion: true
    } });
    assert.equal(normalized.theme, 'dark');
    assert.equal(normalized.mica, true);
    assert.equal(normalized.sticky.snapDistance, 64);
    assert.equal(normalized.sticky.handleWidth, 4);
    assert.equal(normalized.sticky.defaultPreset, 'medium');
    assert.equal(normalized.sticky.reduceMotion, true);

    assert.deepEqual(state.resetSettings(), DEFAULT_SETTINGS);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('normalizes malformed note JSON and preserves valid layout on partial updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-note-json-'));
  const path = join(root, 'state.sqlite3');
  const state = new StateDatabase(path);
  try {
    const note = state.saveNote({ layout: { preset: 'small' }, dockJson: '{"edge":"right"}' });
    state.saveNote({ id: note.id, body: 'changed', layout: ['not-an-object'], dockJson: '{broken' });
    const updated = state.listNotes()[0];
    assert.deepEqual(updated.layout, { preset: 'small' });
    assert.deepEqual(updated.dock, { edge: 'right' });

    state.db.prepare("UPDATE notes SET layout_json='null', dock_json='[]' WHERE id=?").run(note.id);
    const malformed = state.listNotes()[0];
    assert.deepEqual(malformed.layout, {});
    assert.deepEqual(malformed.dock, {});
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
