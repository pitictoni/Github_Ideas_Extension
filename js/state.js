// ============================================================================
// Shared mutable state
// All modules import this object and read/write its properties directly.
// ============================================================================

export const state = {
    // Gists
    allGists: [],
    currentGist: null,
    currentFile: null,
    deleteCallback: null,

    // Projects
    allProjects: [],
    currentProject: null,
    projectFieldDefinitions: {},
    userRepositories: [],
    projectItemsCache: {},

    // Repo issues
    currentRepoFullName: null,
    currentRepoIssueState: 'open',
    currentMode: 'project',

    // Issue actions
    currentIssueData: null,
    convertDraftItemId: null,
    moveItemId: null,
    moveItemType: null,
    currentStatusDropdown: null,

    // Quick capture
    INBOX_STORAGE_KEY: 'quickCaptureInboxProject'
};
