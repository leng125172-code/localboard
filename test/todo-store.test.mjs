import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TodoStore } from '../src/core/todo-store.mjs';
import { createTodo } from '../src/core/model.mjs';

test('serializes concurrent mutations without losing todos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-store-'));
  try {
    const store = new TodoStore(join(root, '.localboard', 'todos.json'));
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.mutate((file) => ({
      schemaVersion: 1,
      todos: [...file.todos, createTodo({ id: `t${index}`, title: `Todo ${index}` })]
    }))));
    const data = await store.read();
    assert.equal(data.todos.length, 20);
    assert.equal(new Set(data.todos.map((todo) => todo.id)).size, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

