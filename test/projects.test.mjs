import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectsApi } from '../src/github/projects.mjs';

test('uses an ID variable for single-select project options', async () => {
  let captured;
  const api = new ProjectsApi({ graphql: async (query, variables) => {
    captured = { query, variables };
    return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } };
  } });
  await api.setField({ projectId: 'p', itemId: 'i', fieldId: 'f', valueType: 'single-select', value: 'option' });
  assert.match(captured.query, /\$value: ID!/);
  assert.equal(captured.variables.value, 'option');
});

