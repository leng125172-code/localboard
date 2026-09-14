import { randomUUID } from 'node:crypto';

export const TODO_STATUSES = new Set(['todo', 'doing', 'done', 'cancelled']);

export function emptyTodoFile() {
  return { schemaVersion: 1, todos: [] };
}

export function normalizeTodoFile(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Todo file must be an object');
  if (value.schemaVersion !== 1) throw new Error(`Unsupported todo schema: ${value.schemaVersion}`);
  if (!Array.isArray(value.todos)) throw new TypeError('todos must be an array');
  const ids = new Set();
  const todos = value.todos.map((todo) => {
    validateTodo(todo);
    if (ids.has(todo.id)) throw new Error(`Duplicate todo id: ${todo.id}`);
    ids.add(todo.id);
    return { ...todo, tags: [...(todo.tags ?? [])] };
  });
  return { schemaVersion: 1, todos };
}

export function createTodo(input, now = new Date()) {
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('Todo title is required');
  const timestamp = now.toISOString();
  const todo = {
    id: input.id ?? randomUUID(),
    title,
    description: String(input.description ?? ''),
    status: input.status ?? 'todo',
    priority: Number(input.priority ?? 0),
    tags: [...new Set((input.tags ?? []).map(String).map((tag) => tag.trim()).filter(Boolean))],
    dueAt: input.dueAt ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    source: { kind: 'personal' }
  };
  validateTodo(todo);
  return todo;
}

export function updateTodo(todo, patch, now = new Date()) {
  const next = {
    ...todo,
    ...(patch.title !== undefined ? { title: String(patch.title).trim() } : {}),
    ...(patch.description !== undefined ? { description: String(patch.description) } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.priority !== undefined ? { priority: Number(patch.priority) } : {}),
    ...(patch.tags !== undefined ? { tags: [...new Set(patch.tags.map(String))] } : {}),
    ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
    updatedAt: now.toISOString()
  };
  validateTodo(next);
  return next;
}

export function validateTodo(todo) {
  if (!todo || typeof todo !== 'object') throw new TypeError('Todo must be an object');
  if (typeof todo.id !== 'string' || !todo.id) throw new Error('Todo id is required');
  if (typeof todo.title !== 'string' || !todo.title.trim()) throw new Error('Todo title is required');
  if (!TODO_STATUSES.has(todo.status)) throw new Error(`Invalid todo status: ${todo.status}`);
  if (!Number.isInteger(todo.priority) || todo.priority < 0 || todo.priority > 3) {
    throw new Error('Todo priority must be an integer from 0 to 3');
  }
  if (!Array.isArray(todo.tags) || todo.tags.some((tag) => typeof tag !== 'string')) {
    throw new TypeError('Todo tags must be strings');
  }
  if (todo.dueAt !== null && Number.isNaN(Date.parse(todo.dueAt))) throw new Error('dueAt must be ISO date/time or null');
  if (todo.source?.kind !== 'personal') throw new Error('Tracked todo files may only contain personal todos');
}

