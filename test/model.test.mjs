import test from 'node:test';
import assert from 'node:assert/strict';
import { createTodo, normalizeTodoFile, updateTodo } from '../src/core/model.mjs';

test('creates and updates a personal todo', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  const todo = createTodo({ id: 't1', title: '  Ship MVP  ', tags: ['mvp', 'mvp'], priority: 2 }, now);
  assert.equal(todo.title, 'Ship MVP');
  assert.deepEqual(todo.tags, ['mvp']);
  assert.equal(updateTodo(todo, { status: 'done' }, new Date('2026-09-15T00:00:00Z')).status, 'done');
});

test('rejects remote items in the tracked personal file', () => {
  assert.throws(() => normalizeTodoFile({ schemaVersion: 1, todos: [{
    id: 'x', title: 'Remote', description: '', status: 'todo', priority: 0, tags: [], dueAt: null,
    createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z', source: { kind: 'github' }
  }] }), /personal todos/);
});

