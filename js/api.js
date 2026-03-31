import { clearStoredToken } from './auth.js';
import { state } from './state.js';

// ============================================================================
// GitHub API
// ============================================================================

// ── User ─────────────────────────────────────────────────────────────────────

export async function fetchGitHubUser(token) {
    const response = await fetch('https://api.github.com/user', {
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json' 
        }
    });
    if (response.status === 401) { 
        await clearStoredToken(); 
        throw new Error('Token expired or invalid'); 
    }
    if (response.status === 403) {
        const resetTime = response.headers.get('X-RateLimit-Reset');
        throw new Error(`Rate limited. Resets at ${new Date(resetTime * 1000).toLocaleTimeString()}`);
    }
    if (!response.ok) {
        throw new Error('Failed to fetch user data');
    }
    return response.json();
}

export async function fetchUserRepositories(token) {
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json' 
        }
    });
    if (!response.ok) {
        throw new Error('Failed to fetch repositories');
    }
    return response.json();
}


// ── Gists ────────────────────────────────────────────────────────────────────

export async function fetchGists(token) {
    const response = await fetch('https://api.github.com/gists', {
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json' 
        }
    });
    if (!response.ok) {
        throw new Error('Failed to fetch gists');
    }
    return response.json();
}

export async function fetchGistById(token, gistId) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json' 
        }
    });
    if (!response.ok) {
        throw new Error('Failed to fetch gist');
    }
    return response.json();
}

export async function createGist(token, description, filename, content, isPublic = false) {
    const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json', 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ description: description || '', public: isPublic, files: { [filename]: { content } } })
    });
    if (!response.ok) {
        throw new Error('Failed to create gist');
    }
    return response.json();
}

export async function updateGist(token, gistId, files) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json', 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ files })
    });
    if (!response.ok) {
        throw new Error('Failed to update gist');
    }
    return response.json();
}

export async function deleteGist(token, gistId) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'DELETE',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json' 
        }
    });
    if (response.status !== 204) {
        throw new Error('Failed to delete gist');
    }
}

export async function renameGistDescription(token, gistId, description) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ description })
    });
    if (!response.ok) {
        throw new Error('Failed to rename gist');
    }
    return response.json();
}

export async function createProject(token, ownerId, title) {
    const data = await gql(token, `
        mutation CreateProject($ownerId: ID!, $title: String!) {
            createProjectV2(input: { ownerId: $ownerId, title: $title }) {
                projectV2 { id title }
            }
        }`, { ownerId, title });
    return data.createProjectV2.projectV2;
}

export async function addDraftIssue(token, projectId, title) {
    const data = await gql(token, `
        mutation AddDraft($projectId: ID!, $title: String!) {
            addProjectV2DraftIssue(input: { projectId: $projectId, title: $title }) {
                projectItem { id }
            }
        }`, { projectId, title });
    return data.addProjectV2DraftIssue.projectItem;
}

export async function fetchViewerId(token) {
    const data = await gql(token, `query { viewer { id } }`);
    return data.viewer.id;
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function fetchProjects(token) {
    const query = `
        query GetProjectList {
            viewer {
                login name
                projectsV2(first: 50) {
                    nodes {
                        id title url shortDescription public closed createdAt updatedAt
                        owner { ... on User { login name } ... on Organization { login name } }
                        repositories(first: 5) { nodes { name nameWithOwner owner { login } } }
                        fields(first: 20) {
                            nodes {
                                ... on ProjectV2Field { id name dataType }
                                ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
                                ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate duration } } }
                            }
                        }
                    }
                }
            }
        }
    `;
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
    });
    if (!response.ok) {
        throw new Error('Failed to fetch projects');
    }
    return response.json();
}

export async function fetchProjectItems(token, projectId) {
    if (state.projectItemsCache[projectId]) {
        return state.projectItemsCache[projectId];
    }

    let allItems = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
        const query = `
            query GetProjectItems($projectId: ID!, $cursor: String) {
                node(id: $projectId) {
                    ... on ProjectV2 {
                        items(first: 100, after: $cursor) {
                            totalCount
                            pageInfo { hasNextPage endCursor }
                            nodes {
                                id type
                                fieldValues(first: 20) {
                                    nodes {
                                        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
                                        ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                                        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
                                        ... on ProjectV2ItemFieldSingleSelectValue { name color optionId field { ... on ProjectV2FieldCommon { name } } }
                                        ... on ProjectV2ItemFieldIterationValue { title startDate duration field { ... on ProjectV2FieldCommon { name } } }
                                    }
                                }
                                content {
                                    ... on Issue { id title number state url createdAt updatedAt closedAt repository { name nameWithOwner owner { login } } author { login } labels(first: 10) { nodes { name color } } assignees(first: 10) { nodes { login name } } milestone { title dueOn } }
                                    ... on PullRequest { id title number state url createdAt updatedAt closedAt mergedAt repository { name nameWithOwner owner { login } } author { login } }
                                    ... on DraftIssue { id title createdAt }
                                }
                            }
                        }
                    }
                }
            }
        `;
        const response = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`, 
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query, variables: { projectId, cursor } })
        });
        if (!response.ok) {
            throw new Error('Failed to fetch project items');
        }
        const result = await response.json();
        const itemsData = result.data?.node?.items;
        if (!itemsData) break;

        allItems = allItems.concat(itemsData.nodes);
        hasNextPage = itemsData.pageInfo.hasNextPage;
        cursor = itemsData.pageInfo.endCursor;
    }

    state.projectItemsCache[projectId] = allItems;
    return allItems;
}

export function invalidateProjectCache(projectId) {
    delete state.projectItemsCache[projectId];
}

// ── GraphQL helper ────────────────────────────────────────────────────────────

export async function gql(token, query, variables = {}) {
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables })
    });
    const result = await response.json();
    if (result.errors) {
        throw new Error(result.errors[0].message);
    }
    return result.data;
}