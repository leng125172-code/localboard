const PROJECT_FRAGMENT = `
  id title shortDescription updatedAt
  fields(first: 100) { nodes {
    ... on ProjectV2Field { id name dataType }
    ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
    ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate duration } } }
  } }
`;

export class ProjectsApi {
  constructor(client) {
    this.client = client;
  }

  async getProject(ownerType, owner, number) {
    const field = ownerType === 'organization' ? 'organization' : 'user';
    const data = await this.client.graphql(`
      query($owner: String!, $number: Int!) {
        ${field}(login: $owner) { projectV2(number: $number) { ${PROJECT_FRAGMENT} } }
      }
    `, { owner, number: Number(number) });
    const project = data.data?.[field]?.projectV2;
    if (!project) throw new Error(`GitHub Project not found: ${ownerType}:${owner}#${number}`);
    return project;
  }

  async listItems(projectId) {
    const items = [];
    let cursor;
    do {
      const data = await this.client.graphql(`
        query($project: ID!, $cursor: String) {
          node(id: $project) { ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id type isArchived updatedAt
                content {
                  __typename
                  ... on DraftIssue { id title body createdAt updatedAt }
                  ... on Issue { id number title body state url updatedAt repository { nameWithOwner } }
                  ... on PullRequest { id number title body state url isDraft updatedAt repository { nameWithOwner } }
                }
                fieldValues(first: 100) { nodes {
                  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
                  ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id name } } }
                  ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id name } } }
                  ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2FieldCommon { id name } } }
                  ... on ProjectV2ItemFieldIterationValue { iterationId title startDate duration field { ... on ProjectV2FieldCommon { id name } } }
                } }
              }
            }
          } }
        }
      `, { project: projectId, cursor });
      const connection = data.data?.node?.items;
      if (!connection) throw new Error(`Project items unavailable: ${projectId}`);
      items.push(...connection.nodes);
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
    } while (cursor);
    return items;
  }

  async setField({ projectId, itemId, fieldId, valueType, value, idempotencyKey, expectedUpdatedAt }) {
    await this.assertUnchanged(itemId, expectedUpdatedAt, 'Project item');
    const shapes = {
      text: { scalar: 'String!', member: 'text' },
      number: { scalar: 'Float!', member: 'number' },
      date: { scalar: 'Date!', member: 'date' },
      'single-select': { scalar: 'ID!', member: 'singleSelectOptionId' },
      iteration: { scalar: 'ID!', member: 'iterationId' }
    };
    const shape = shapes[valueType];
    if (!shape) throw new Error(`Unsupported Project field value type: ${valueType}`);
    const parsedValue = valueType === 'number' ? Number(value) : value;
    const data = await this.client.graphql(`
      mutation($project: ID!, $item: ID!, $field: ID!, $value: ${shape.scalar}, $clientMutationId: String) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $project, itemId: $item, fieldId: $field,
          value: { ${shape.member}: $value }, clientMutationId: $clientMutationId
        }) { projectV2Item { id updatedAt } clientMutationId }
      }
    `, { project: projectId, item: itemId, field: fieldId, value: parsedValue, clientMutationId: idempotencyKey });
    return data.data.updateProjectV2ItemFieldValue;
  }

  async clearField({ projectId, itemId, fieldId, idempotencyKey, expectedUpdatedAt }) {
    await this.assertUnchanged(itemId, expectedUpdatedAt, 'Project item');
    const data = await this.client.graphql(`
      mutation($project: ID!, $item: ID!, $field: ID!, $clientMutationId: String) {
        clearProjectV2ItemFieldValue(input: {
          projectId: $project, itemId: $item, fieldId: $field, clientMutationId: $clientMutationId
        }) { projectV2Item { id updatedAt } clientMutationId }
      }
    `, { project: projectId, item: itemId, field: fieldId, clientMutationId: idempotencyKey });
    return data.data.clearProjectV2ItemFieldValue;
  }

  async updateDraft({ draftIssueId, title, body, idempotencyKey, expectedUpdatedAt }) {
    await this.assertUnchanged(draftIssueId, expectedUpdatedAt, 'Draft issue');
    const data = await this.client.graphql(`
      mutation($id: ID!, $title: String, $body: String, $clientMutationId: String) {
        updateProjectV2DraftIssue(input: {
          draftIssueId: $id, title: $title, body: $body, clientMutationId: $clientMutationId
        }) { draftIssue { id title body updatedAt } clientMutationId }
      }
    `, { id: draftIssueId, title, body, clientMutationId: idempotencyKey });
    return data.data.updateProjectV2DraftIssue;
  }

  async assertUnchanged(nodeId, expectedUpdatedAt, label) {
    if (!expectedUpdatedAt) return;
    const data = await this.client.graphql(`
      query($id: ID!) {
        node(id: $id) {
          ... on ProjectV2Item { updatedAt }
          ... on DraftIssue { updatedAt }
        }
      }
    `, { id: nodeId });
    const actual = data.data?.node?.updatedAt;
    if (!actual) throw new Error(`${label} is no longer available`);
    if (actual !== expectedUpdatedAt) {
      const error = new Error(`${label} changed on GitHub after it was loaded; refresh and review before writing`);
      error.statusCode = 409;
      throw error;
    }
  }
}
