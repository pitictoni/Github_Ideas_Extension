const CONFIG = {
    GITHUB_CLIENT_ID: 'Ov23liqJaw3AaJpiq0A6',
    BACKEND_URL: 'https://github-oauth-worker.iopy.workers.dev',
    REDIRECT_URI: chrome.identity.getRedirectURL()
};

// ============================================================================
// State Management
// ============================================================================

let allGists = [];
let currentGist = null;
let currentFile = null;
let deleteCallback = null;

let allProjects = [];
let currentProject = null;
let projectFieldDefinitions = {};
let userRepositories = [];

// ============================================================================
// Utility Functions
// ============================================================================

function base64URLEncode(buffer) {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function showStatus(message, type = 'info') {
    const statusEl = document.getElementById('statusMessage');
    statusEl.textContent = message;
    statusEl.className = `status-message ${type}`;
    statusEl.classList.remove('hidden');

    setTimeout(() => {
        statusEl.classList.add('hidden');
    }, 3000);
}

// Map GitHub project colors to CSS hex colors
function githubColorToCSS(githubColor) {
    const colorMap = {
        'GRAY': '#6b7280',
        'RED': '#ef4444',
        'GREEN': '#22c55e',
        'BLUE': '#3b82f6',
        'YELLOW': '#eab308',
        'PURPLE': '#a855f7',
        'PINK': '#ec4899',
        'ORANGE': '#f97316'
    };
    return colorMap[githubColor] || '#6b7280';
}

// Extract field definitions from project
function extractFieldDefinitions(project) {
    const fieldDefs = {
        status: null,
        other: []
    };

    if (!project.fields || !project.fields.nodes) {
        return fieldDefs;
    }

    project.fields.nodes.forEach(field => {
        // Single select fields (Status, etc.)
        if (field.options) {
            const fieldInfo = {
                id: field.id,
                name: field.name,
                dataType: field.dataType,
                options: field.options.map(opt => ({
                    id: opt.id,
                    name: opt.name,
                    color: opt.color,
                    description: opt.description
                }))
            };

            // Categorize by field name
            if (field.name.toLowerCase() === 'status') {
                fieldDefs.status = fieldInfo;
            } else {
                fieldDefs.other.push(fieldInfo);
            }
        }
    });

    return fieldDefs;
}

// ============================================================================
// Token Encryption/Decryption
// ============================================================================

async function encryptToken(token) {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(chrome.runtime.id.padEnd(32, '0')),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode('github-oauth-salt'),
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
    );

    return {
        encrypted: base64URLEncode(new Uint8Array(encrypted)),
        iv: base64URLEncode(iv)
    };
}

async function decryptToken(encryptedData) {
    const encoder = new TextEncoder();

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(chrome.runtime.id.padEnd(32, '0')),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode('github-oauth-salt'),
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
    );

    const encrypted = Uint8Array.from(
        atob(encryptedData.encrypted.replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0)
    );
    const iv = Uint8Array.from(
        atob(encryptedData.iv.replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0)
    );

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

// ============================================================================
// Token Storage
// ============================================================================

async function storeToken(tokenData) {
    const encrypted = await encryptToken(JSON.stringify(tokenData));
    await chrome.storage.local.set({
        githubToken: encrypted,
        tokenExpiry: Date.now() + (tokenData.expires_in || 86400) * 1000
    });
}

async function getStoredToken() {
    try {
        const result = await chrome.storage.local.get(['githubToken', 'tokenExpiry']);

        if (!result.githubToken) {
            return null;
        }

        if (result.tokenExpiry && Date.now() >= result.tokenExpiry) {
            await clearStoredToken();
            return null;
        }

        const decrypted = await decryptToken(result.githubToken);
        return JSON.parse(decrypted);
    } catch (error) {
        console.error('Error retrieving token:', error);
        await clearStoredToken();
        return null;
    }
}

async function clearStoredToken() {
    await chrome.storage.local.remove([
        'githubToken',
        'tokenExpiry',
        'repos',
        'selectedRepo',
        'userData'
    ]);
}

// ============================================================================
// GitHub Authentication
// ============================================================================

async function authenticateWithGitHub() {
    const state = base64URLEncode(crypto.getRandomValues(new Uint8Array(32)));

    const authUrl = `https://github.com/login/oauth/authorize?` +
        `client_id=${CONFIG.GITHUB_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}` +
        `&scope=repo gist project read:user` +
        `&state=${state}`;

    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
            {
                url: authUrl,
                interactive: true
            },
            async (redirectUrl) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                    return;
                }

                try {
                    const url = new URL(redirectUrl);
                    const code = url.searchParams.get('code');
                    const returnedState = url.searchParams.get('state');

                    if (!code) {
                        reject(new Error('No authorization code received'));
                        return;
                    }

                    if (returnedState !== state) {
                        reject(new Error('State mismatch - possible CSRF attack'));
                        return;
                    }

                    const tokenData = await exchangeCodeForToken(code);

                    resolve(tokenData);
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

async function exchangeCodeForToken(code) {
    try {
        const response = await fetch(`${CONFIG.BACKEND_URL}/api/github/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                code,
                redirect_uri: CONFIG.REDIRECT_URI
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || data.error || 'Failed to exchange code for token');
        }

        return data;
    } catch (error) {
        console.error('Token exchange error:', error);
        throw error;
    }
}

// ============================================================================
// GitHub API Calls
// ============================================================================

async function fetchGitHubUser(token) {
    const response = await fetch('https://api.github.com/user', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    // Invalid Token
    if (response.status === 401) {
        await clearStoredToken();
        throw new Error('Token expired or invalid');
    }

    // Rate limited
    if (response.status === 403) {

        const resetTime = response.headers.get('X-RateLimit-Reset');
        throw new Error(`Rate limited. Resets at ${new Date(resetTime * 1000).toLocaleTimeString()}`);
    }

    if (!response.ok) {
        throw new Error('Failed to fetch user data');
    }

    return await response.json();
}

async function fetchGists(token) {
    const response = await fetch('https://api.github.com/gists', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) {
        throw new Error('Failed to fetch gists');
    }

    return await response.json();
}

async function createGist(token, description, filename, content, isPublic = false) {
    const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            description: description || '',
            public: isPublic,
            files: {
                [filename]: {
                    content: content
                }
            }
        })
    });

    if (!response.ok) {
        throw new Error('Failed to create gist');
    }

    return await response.json();
}

async function updateGist(token, gistId, files) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files })
    });

    if (!response.ok) {
        throw new Error('Failed to update gist');
    }

    return await response.json();
}

async function deleteGist(token, gistId) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (response.status !== 204) {
        throw new Error('Failed to delete gist');
    }
}

async function fetchGistById(token, gistId) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) {
        throw new Error('Failed to fetch gist');
    }

    return await response.json();
}

async function fetchProjects(token) {
    const query = `
                query GetAllAccessibleProjectsWithFullDetails {
                viewer {
                    login
                    name
                    # User's personal projects with full details
                    projectsV2(first: 50) {
                        nodes {
                            id
                            title
                            url
                            shortDescription
                            public
                            closed
                            createdAt
                            updatedAt
                            owner {
                                ... on User {
                                    login
                                    name
                                }
                                ... on Organization {
                                    login
                                    name
                                }
                            }
                            # ADD THIS: Field definitions with Status options and colors
                            fields(first: 20) {
                                nodes {
                                    ... on ProjectV2Field {
                                        id
                                        name
                                        dataType
                                    }
                                    ... on ProjectV2SingleSelectField {
                                        id
                                        name
                                        dataType
                                        options {
                                            id
                                            name
                                            color
                                            description
                                        }
                                    }
                                    ... on ProjectV2IterationField {
                                        id
                                        name
                                        dataType
                                        configuration {
                                            iterations {
                                                id
                                                title
                                                startDate
                                                duration
                                            }
                                        }
                                    }
                                }
                            }
                            items(first: 100) {
                                totalCount
                                nodes {
                                    id
                                    type
                                    fieldValues(first: 20) {
                                        nodes {
                                            ... on ProjectV2ItemFieldTextValue {
                                                text
                                                field {
                                                    ... on ProjectV2FieldCommon {
                                                        name
                                                    }
                                                }
                                            }
                                            ... on ProjectV2ItemFieldNumberValue {
                                                number
                                                field {
                                                    ... on ProjectV2FieldCommon {
                                                        name
                                                    }
                                                }
                                            }
                                            ... on ProjectV2ItemFieldDateValue {
                                                date
                                                field {
                                                    ... on ProjectV2FieldCommon {
                                                        name
                                                    }
                                                }
                                            }
                                            ... on ProjectV2ItemFieldSingleSelectValue {
                                                name
                                                color
                                                # ADD THIS: optionId to match with field definitions
                                                optionId
                                                field {
                                                    ... on ProjectV2FieldCommon {
                                                        name
                                                    }
                                                }
                                            }
                                            ... on ProjectV2ItemFieldIterationValue {
                                                title
                                                startDate
                                                duration
                                                field {
                                                    ... on ProjectV2FieldCommon {
                                                        name
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    content {
                                        ... on Issue {
                                            id
                                            title
                                            number
                                            state
                                            url
                                            body
                                            createdAt
                                            updatedAt
                                            closedAt
                                            repository {
                                                name
                                                nameWithOwner
                                                owner {
                                                    login
                                                }
                                            }
                                            author {
                                                login
                                                avatarUrl
                                            }
                                            labels(first: 10) {
                                                nodes {
                                                    name
                                                    color
                                                }
                                            }
                                            assignees(first: 10) {
                                                nodes {
                                                    login
                                                    name
                                                    avatarUrl
                                                }
                                            }
                                            milestone {
                                                title
                                                dueOn
                                            }
                                        }
                                        ... on PullRequest {
                                            id
                                            title
                                            number
                                            state
                                            url
                                            body
                                            createdAt
                                            updatedAt
                                            closedAt
                                            mergedAt
                                            repository {
                                                name
                                                nameWithOwner
                                                owner {
                                                    login
                                                }
                                            }
                                            author {
                                                login
                                                avatarUrl
                                            }
                                        }
                                        ... on DraftIssue {
                                            id
                                            title
                                            body
                                            createdAt
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json"
        },
        body: JSON.stringify({
            query: query
        })
    })

    if (!response.ok) {
        throw new Error('Failed to fetch project columns');
    }

    return await response.json();
}

// ============================================================================
// Modal Management
// ============================================================================

function openModal(modalId) {
    document.getElementById(modalId).style.display = 'flex';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.style.display = 'none';
    });
}

// ============================================================================
// Gist Management
// ============================================================================

async function loadGists() {
    const tokenData = await getStoredToken();
    if (!tokenData || !tokenData.access_token) {
        return;
    }

    allGists = await fetchGists(tokenData.access_token);

    const gistSelect = document.getElementById('gistSelect');
    gistSelect.innerHTML = '<option value="" disabled selected>Select a gist to view/edit</option>';

    allGists.forEach(gist => {
        const option = document.createElement('option');
        option.value = gist.id;

        const firstFilename = Object.keys(gist.files)[0];
        const displayName = gist.description || firstFilename || 'Untitled Gist';

        option.textContent = displayName;
        gistSelect.appendChild(option);
    });
}

function displayGistPreview(gist) {
    currentGist = gist;

    const preview = document.getElementById('gistPreview');
    const gistName = document.getElementById('previewGistName');
    const filesList = document.getElementById('gistFilesList');
    const viewBtn = document.getElementById('viewGistBtn');

    gistName.textContent = gist.description || Object.keys(gist.files)[0] || 'Untitled Gist';
    viewBtn.onclick = () => window.open(gist.html_url, '_blank');

    filesList.innerHTML = '';
    Object.entries(gist.files).forEach(([filename, fileData]) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'gist-file-item';
        fileItem.innerHTML = `
            <div class="gist-file-name">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H4zm0 1h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/>
                </svg>
                ${filename}
            </div>
            <div class="gist-file-preview">${fileData.content.split('\n').slice(0, 5).join('\n')}</div>
        `;
        filesList.appendChild(fileItem);
    });

    preview.style.display = 'block';
}

function hideGistPreview() {
    document.getElementById('gistPreview').style.display = 'none';
    currentGist = null;
}

// ============================================================================
// Create/Edit Gist Modal
// ============================================================================

function openCreateGistModal() {
    document.getElementById('gistEditorModalTitle').textContent = 'Create New Gist';
    document.getElementById('saveGistText').textContent = 'Create Gist';
    document.getElementById('gistDescription').value = '';
    document.getElementById('gistFilename').value = '';
    document.getElementById('gistContent').value = '';
    document.getElementById('gistPublic').checked = false;

    openModal('gistEditorModal');
}

function openEditGistModal() {
    if (!currentGist) return;

    const firstFilename = Object.keys(currentGist.files)[0];
    const firstFile = currentGist.files[firstFilename];

    document.getElementById('gistEditorModalTitle').textContent = 'Edit Gist';
    document.getElementById('saveGistText').textContent = 'Save Changes';
    document.getElementById('gistDescription').value = currentGist.description || '';
    document.getElementById('gistFilename').value = firstFilename;
    document.getElementById('gistContent').value = firstFile.content;
    document.getElementById('gistPublic').checked = currentGist.public;

    // Disable filename editing for existing gists
    document.getElementById('gistFilename').disabled = true;

    openModal('gistEditorModal');
}

async function saveGist() {
    const description = document.getElementById('gistDescription').value.trim();
    const filename = document.getElementById('gistFilename').value.trim();
    const content = document.getElementById('gistContent').value.trim();
    const isPublic = document.getElementById('gistPublic').checked;

    if (!filename) {
        showStatus('Please enter a filename', 'error');
        return;
    }

    if (!content) {
        showStatus('Please enter some content', 'error');
        return;
    }

    const saveBtn = document.getElementById('saveGist');
    saveBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        if (currentGist) {
            // Update existing gist
            const files = {};
            files[filename] = { content };
            await updateGist(tokenData.access_token, currentGist.id, files);
            showStatus('Gist updated successfully!', 'success');

            // Reload and display the updated gist
            await loadGists();
            currentGist = await fetchGistById(tokenData.access_token, currentGist.id);
            displayGistPreview(currentGist);
        } else {
            // Create new gist
            const newGist = await createGist(tokenData.access_token, description, filename, content, isPublic);
            showStatus('Gist created successfully!', 'success');

            // Reload gists list
            await loadGists();

            // Select the newly created gist in the dropdown
            const gistSelect = document.getElementById('gistSelect');
            gistSelect.value = newGist.id;

            // Set as current and display preview
            currentGist = newGist;
            displayGistPreview(newGist);
        }

        closeModal('gistEditorModal');

        // Re-enable filename field
        document.getElementById('gistFilename').disabled = false;

    } catch (error) {
        console.error('Error saving gist:', error);
        showStatus('Failed to save gist: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
}

// ============================================================================
// File Editor Modal
// ============================================================================

function openFileEditorModal() {
    if (!currentGist) return;

    const fileSelector = document.getElementById('fileSelector');
    const fileContent = document.getElementById('fileContent');

    // Populate file selector
    fileSelector.innerHTML = '';
    Object.keys(currentGist.files).forEach(filename => {
        const option = document.createElement('option');
        option.value = filename;
        option.textContent = filename;
        fileSelector.appendChild(option);
    });

    // Load first file
    const firstFilename = Object.keys(currentGist.files)[0];
    currentFile = firstFilename;
    document.getElementById('currentFileName').textContent = firstFilename;
    fileContent.value = currentGist.files[firstFilename].content;

    // Show/hide delete button based on file count
    document.getElementById('deleteFileBtn').style.display =
        Object.keys(currentGist.files).length > 1 ? 'inline-flex' : 'none';

    openModal('fileEditorModal');
}

async function saveFileChanges() {
    if (!currentGist || !currentFile) return;

    const content = document.getElementById('fileContent').value.trim();

    if (!content) {
        showStatus('Content cannot be empty', 'error');
        return;
    }

    const saveBtn = document.getElementById('saveFileChanges');
    saveBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const files = {};
        files[currentFile] = { content };
        await updateGist(tokenData.access_token, currentGist.id, files);

        showStatus('File updated successfully!', 'success');

        // Reload the gist
        currentGist = await fetchGistById(tokenData.access_token, currentGist.id);
        await loadGists();
        displayGistPreview(currentGist);

        closeModal('fileEditorModal');

    } catch (error) {
        console.error('Error saving file:', error);
        showStatus('Failed to save file: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
}

function openAddFileModal() {
    if (!currentGist) return;

    // Clear form fields
    document.getElementById('newFileName').value = '';
    document.getElementById('newFileContent').value = '';
    openModal('addFileModal');
}

async function saveNewFile() {
    if (!currentGist) return;

    const filename = document.getElementById('newFileName').value.trim();
    const content = document.getElementById('newFileContent').value.trim();

    if (!filename) {
        showStatus('Please enter a filename', 'error');
        return;
    }

    if (!content) {
        showStatus('Content cannot be empty', 'error');
        return;
    }

    // Check if file already exists
    if (currentGist.files[filename]) {
        showStatus('A file with this name already exists', 'error');
        return;
    }

    const saveBtn = document.getElementById('saveNewFile');
    saveBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // Add the new file to the gist
        const files = {};
        files[filename] = { content };
        await updateGist(tokenData.access_token, currentGist.id, files);

        showStatus('File added successfully!', 'success');

        // Clear form fields
        document.getElementById('newFileName').value = '';
        document.getElementById('newFileContent').value = '';

        // Reload the gist
        currentGist = await fetchGistById(tokenData.access_token, currentGist.id);
        await loadGists();
        displayGistPreview(currentGist);

        closeModal('addFileModal');

    } catch (error) {
        console.error('Error adding file:', error);
        showStatus('Failed to add file: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
}

function loadSelectedFile() {
    const fileSelector = document.getElementById('fileSelector');
    const selectedFilename = fileSelector.value;

    if (!currentGist || !selectedFilename) return;

    currentFile = selectedFilename;
    document.getElementById('currentFileName').textContent = selectedFilename;
    document.getElementById('fileContent').value = currentGist.files[selectedFilename].content;

    // Show/hide delete button
    document.getElementById('deleteFileBtn').style.display =
        Object.keys(currentGist.files).length > 1 ? 'inline-flex' : 'none';
}

// ============================================================================
// Delete Confirmation Modal
// ============================================================================

function openDeleteConfirmModal(message, callback) {
    document.getElementById('deleteConfirmMessage').textContent = message;
    deleteCallback = callback;
    openModal('deleteConfirmModal');
}

async function confirmDeleteAction() {
    if (deleteCallback) {
        await deleteCallback();
        deleteCallback = null;
    }
    closeModal('deleteConfirmModal');
}

async function deleteCurrentGist() {
    if (!currentGist) return;

    const gistName = currentGist.description || Object.keys(currentGist.files)[0] || 'this gist';

    openDeleteConfirmModal(
        `Are you sure you want to delete "${gistName}"? This action cannot be undone.`,
        async () => {
            try {
                const tokenData = await getStoredToken();
                if (!tokenData || !tokenData.access_token) {
                    showStatus('Not authenticated', 'error');
                    return;
                }

                await deleteGist(tokenData.access_token, currentGist.id);
                showStatus('Gist deleted successfully!', 'success');

                await loadGists();
                hideGistPreview();

            } catch (error) {
                console.error('Error deleting gist:', error);
                showStatus('Failed to delete gist: ' + error.message, 'error');
            }
        }
    );
}

// ============================================================================
// Rename Gist
// ============================================================================

function openRenameGistModal() {
    if (!currentGist) return;

    document.getElementById('newGistDescription').value = currentGist.description || '';
    openModal('renameGistModal');
}

async function renameGist() {
    if (!currentGist) return;

    const newDescription = document.getElementById('newGistDescription').value.trim();

    const renameBtn = document.getElementById('confirmRenameGist');
    renameBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // Update gist with new description
        const response = await fetch(`https://api.github.com/gists/${currentGist.id}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                description: newDescription
            })
        });

        if (!response.ok) {
            throw new Error('Failed to rename gist');
        }

        showStatus('Gist renamed successfully!', 'success');

        // Reload the gist
        currentGist = await fetchGistById(tokenData.access_token, currentGist.id);
        await loadGists();
        displayGistPreview(currentGist);

        // Update select to show new name
        const gistSelect = document.getElementById('gistSelect');
        gistSelect.value = currentGist.id;

        closeModal('renameGistModal');

    } catch (error) {
        console.error('Error renaming gist:', error);
        showStatus('Failed to rename gist: ' + error.message, 'error');
    } finally {
        renameBtn.disabled = false;
    }
}

async function deleteCurrentFile() {
    if (!currentGist || !currentFile) return;

    if (Object.keys(currentGist.files).length <= 1) {
        showStatus('Cannot delete the only file in a gist', 'error');
        return;
    }

    openDeleteConfirmModal(
        `Are you sure you want to delete "${currentFile}"? This action cannot be undone.`,
        async () => {
            try {
                const tokenData = await getStoredToken();
                if (!tokenData || !tokenData.access_token) {
                    showStatus('Not authenticated', 'error');
                    return;
                }

                const files = {};
                files[currentFile] = null; // Setting to null deletes the file
                await updateGist(tokenData.access_token, currentGist.id, files);

                showStatus('File deleted successfully!', 'success');

                // Reload the gist
                currentGist = await fetchGistById(tokenData.access_token, currentGist.id);
                await loadGists();
                displayGistPreview(currentGist);

                closeModal('fileEditorModal');

            } catch (error) {
                console.error('Error deleting file:', error);
                showStatus('Failed to delete file: ' + error.message, 'error');
            }
        }
    );
}

// ============================================================================
// Rename File
// ============================================================================

function openRenameFileModal() {
    if (!currentGist || !currentFile) return;

    document.getElementById('oldFilename').value = currentFile;
    document.getElementById('newFilename').value = currentFile;
    openModal('renameFileModal');
}

async function renameFile() {
    if (!currentGist || !currentFile) return;

    const newFilename = document.getElementById('newFilename').value.trim();

    if (!newFilename) {
        showStatus('Please enter a filename', 'error');
        return;
    }

    if (newFilename === currentFile) {
        showStatus('New filename is the same as the current filename', 'error');
        return;
    }

    if (currentGist.files[newFilename]) {
        showStatus('A file with this name already exists', 'error');
        return;
    }

    const renameBtn = document.getElementById('confirmRenameFile');
    renameBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // To rename a file in GitHub Gists:
        // 1. Create a new file with the new name and same content
        // 2. Delete the old file (set to null)
        const files = {};
        files[newFilename] = {
            content: currentGist.files[currentFile].content
        };
        files[currentFile] = null; // Delete old file

        await updateGist(tokenData.access_token, currentGist.id, files);

        showStatus('File renamed successfully!', 'success');

        // Update current file reference
        currentFile = newFilename;

        // Reload the gist
        currentGist = await fetchGistById(tokenData.access_token, currentGist.id);
        await loadGists();
        displayGistPreview(currentGist);

        closeModal('renameFileModal');

        // Update the file editor modal with new filename
        document.getElementById('currentFileName').textContent = newFilename;

        // Reload file selector
        const fileSelector = document.getElementById('fileSelector');
        fileSelector.innerHTML = '';
        Object.keys(currentGist.files).forEach(filename => {
            const option = document.createElement('option');
            option.value = filename;
            option.textContent = filename;
            if (filename === newFilename) {
                option.selected = true;
            }
            fileSelector.appendChild(option);
        });

    } catch (error) {
        console.error('Error renaming file:', error);
        showStatus('Failed to rename file: ' + error.message, 'error');
    } finally {
        renameBtn.disabled = false;
    }
}

// ============================================================================
// Projects Management
// ============================================================================

async function loadProjects() {
    const tokenData = await getStoredToken();
    if (!tokenData || !tokenData.access_token) {
        return;
    }

    try {
        allProjects = await fetchProjects(tokenData.access_token);

        const projectSelect = document.getElementById('projectSelect');
        projectSelect.innerHTML = '<option value="" disabled selected>Select a project</option>';

        if (allProjects.length === 0) {
            showStatus('No projects found', 'info');
            return;
        }

        allProjects.data.viewer.projectsV2.nodes.forEach(project => {
            // Extract and store field definitions for each project
            projectFieldDefinitions[project.id] = extractFieldDefinitions(project);

            const option = document.createElement('option');
            option.value = project.id;
            option.textContent = project.title;
            option.dataset.url = project.url;
            projectSelect.appendChild(option);
        });

    } catch (error) {
        console.error('Error loading projects:', error);
        showStatus('Failed to load projects', 'error');
    }
}

async function loadProjectIssues(projectId) {
    const tokenData = await getStoredToken();
    if (!tokenData || !tokenData.access_token) {
        return;
    }

    try {
        const project = allProjects.data.viewer.projectsV2.nodes.find(p => p.id === projectId);
        if (!project) return;

        currentProject = project;
        document.getElementById('projectTitle').textContent = project.title;

        const viewBtn = document.getElementById('viewProjectBtn');
        viewBtn.onclick = () => window.open(project.url, '_blank');

        const columns = project.items;
        const allCards = [];

        columns.nodes.forEach(item => {
            if (item.content) {
                // Find the "Status" field value with color
                let statusName = 'No Status';
                let statusColor = null;

                item.fieldValues.nodes.forEach(fieldValue => {
                    if (fieldValue.field?.name === 'Status' && fieldValue.name) {
                        statusName = fieldValue.name;
                        statusColor = fieldValue.color;
                    }
                });

                allCards.push({
                    itemId: item.id,
                    title: item.content.title,
                    body: item.content.body || '',
                    status: statusName,
                    statusColor: statusColor,
                    url: item.content.url,
                    state: item.content.state || 'open',
                    type: item.type,
                    labels: item.content.labels?.nodes || [],
                    assignees: item.content.assignees?.nodes || [],
                    repository: item.content.repository?.nameWithOwner || 'Unknown'
                });
            }
        });

        displayProjectIssues(allCards);

    } catch (error) {
        console.error('Error loading project issues:', error);
        showStatus('Failed to load project issues', 'error');
    }
}

function displayProjectIssues(issues) {
    const tableBody = document.getElementById('issuesTableBody');
    const emptyState = document.getElementById('emptyIssuesState');
    const issuesSection = document.getElementById('projectIssuesSection');

    tableBody.innerHTML = '';

    if (issues.length === 0) {
        emptyState.style.display = 'block';
        tableBody.parentElement.style.display = 'none';
    } else {
        emptyState.style.display = 'none';
        tableBody.parentElement.style.display = 'table';

        issues.forEach(issue => {
            const row = document.createElement('tr');

            // Convert GitHub color enum to CSS hex color
            const cssColor = issue.statusColor
                ? githubColorToCSS(issue.statusColor)
                : '#6b7280'; // Default gray

            const statusBadge = `
                <span class="issue-status clickable-status" style="
                    background-color: ${cssColor}15;
                    color: ${cssColor};
                    border: 1px solid ${cssColor}30;
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 500;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                    position: relative;
                " data-item-id="${issue.itemId}" data-current-status="${issue.status}" title="Click to change status">
                    <span style="
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background-color: ${cssColor};
                        display: inline-block;
                    "></span>
                    ${issue.status}
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
                    </svg>
                </span>
            `;

            if (issue.type === 'DRAFT_ISSUE') {
                row.innerHTML = `
                <td>
                    <a class="issue-title" style="text-decoration: none; color: var(--text-primary);">
                        ${issue.title}
                    </a>
                </td>
                <td>
                    ${statusBadge}
                </td>
                <td class="issue-actions-cell">
                    <button class="issue-actions-btn" data-issue-id="${issue.itemId}" data-issue-url="${issue.url || ''}" data-issue-title="${issue.title}" data-issue-body="${encodeURIComponent(issue.body || '')}" data-issue-type="DRAFT">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                        </svg>
                    </button>
                </td>
            `;
            } else {
                row.innerHTML = `
                <td>
                    <a href="${issue.url}" target="_blank" class="issue-title" style="text-decoration: none; color: var(--text-primary);">
                        ${issue.title}
                    </a>
                    ${issue.repository ? `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${issue.repository}</div>` : ''}
                </td>
                <td>
                    ${statusBadge}
                </td>
                <td class="issue-actions-cell">
                    <button class="issue-actions-btn" data-issue-id="${issue.itemId}" data-issue-url="${issue.url}" data-issue-title="${issue.title}" data-issue-type="ISSUE">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                        </svg>
                    </button>
                </td>
            `;
            }

            tableBody.appendChild(row);
        });

        document.querySelectorAll('.clickable-status').forEach(badge => {
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                const itemId = e.currentTarget.getAttribute('data-item-id');
                const currentStatus = e.currentTarget.getAttribute('data-current-status');
                showStatusDropdown(e.currentTarget, itemId, currentStatus);
            });

            badge.addEventListener('mouseenter', (e) => {
                e.currentTarget.style.transform = 'scale(1.05)';
            });
            badge.addEventListener('mouseleave', (e) => {
                e.currentTarget.style.transform = 'scale(1)';
            });
        });

        // Add event listeners for issue action buttons
        document.querySelectorAll('.issue-actions-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showIssueActionsMenu(e.currentTarget);
            });
        });
    }

    issuesSection.style.display = 'block';
}

function hideProjectIssues() {
    document.getElementById('projectIssuesSection').style.display = 'none';
    currentProject = null;
}

// ============================================================================
// Convert Draft to Issue
// ============================================================================

let convertDraftItemId = null;

async function openConvertDraftModal(itemId, title, body) {
    if (!currentProject) return;

    convertDraftItemId = itemId;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        if (userRepositories.length === 0) {
            showStatus('Loading repositories...', 'info');
            userRepositories = await fetchUserRepositories(tokenData.access_token);
        }

        const repoSelect = document.getElementById('convertDraftRepository');
        repoSelect.innerHTML = '<option value="" disabled selected>Select a repository</option>';

        userRepositories.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.full_name;
            option.textContent = repo.full_name;
            option.dataset.owner = repo.owner.login;
            option.dataset.name = repo.name;
            repoSelect.appendChild(option);
        });

        document.getElementById('convertDraftTitle').value = title || '';
        document.getElementById('convertDraftBody').value = body || '';

        openModal('convertDraftModal');

    } catch (error) {
        console.error('Error opening convert draft modal:', error);
        showStatus('Failed to load repositories: ' + error.message, 'error');
    }
}

async function convertDraftToIssue() {
    const repoSelect = document.getElementById('convertDraftRepository');
    const selectedOption = repoSelect.options[repoSelect.selectedIndex];
    const title = document.getElementById('convertDraftTitle').value.trim();
    const body = document.getElementById('convertDraftBody').value.trim();

    if (!repoSelect.value) {
        showStatus('Please select a repository', 'error');
        return;
    }
    if (!title) {
        showStatus('Please enter an issue title', 'error');
        return;
    }

    const owner = selectedOption.dataset.owner;
    const repoName = selectedOption.dataset.name;

    const confirmBtn = document.getElementById('confirmConvertDraft');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // Step 1: Create the GitHub issue via REST API
        const issueResponse = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, body: body || '' })
        });

        if (!issueResponse.ok) {
            const err = await issueResponse.json();
            throw new Error(err.message || 'Failed to create issue');
        }

        const newIssue = await issueResponse.json();

        // Step 2: Add the new issue to the project
        const addMutation = `
            mutation AddIssueToProject($projectId: ID!, $contentId: ID!) {
                addProjectV2ItemById(input: {
                    projectId: $projectId
                    contentId: $contentId
                }) {
                    item {
                        id
                    }
                }
            }
        `;

        const addResponse = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: addMutation,
                variables: {
                    projectId: currentProject.id,
                    contentId: newIssue.node_id
                }
            })
        });

        const addResult = await addResponse.json();
        if (addResult.errors) {
            throw new Error(addResult.errors[0].message);
        }

        // Step 3: Remove the original draft from the project
        const removeMutation = `
            mutation DeleteProjectV2Item($projectId: ID!, $itemId: ID!) {
                deleteProjectV2Item(input: {
                    projectId: $projectId
                    itemId: $itemId
                }) {
                    deletedItemId
                }
            }
        `;

        await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: removeMutation,
                variables: {
                    projectId: currentProject.id,
                    itemId: convertDraftItemId
                }
            })
        });

        showStatus('Draft converted to issue successfully!', 'success');
        closeModal('convertDraftModal');

        // Reload project
        const projectId = currentProject.id;
        await new Promise(resolve => setTimeout(resolve, 1000));
        await loadProjects();
        await loadProjectIssues(projectId);

    } catch (error) {
        console.error('Error converting draft to issue:', error);
        showStatus('Failed to convert draft: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

// ============================================================================


let currentIssueData = null;

function showIssueActionsMenu(button) {
    // Close any existing menus
    document.querySelectorAll('.issue-actions-menu').forEach(menu => menu.remove());

    const issueId = button.getAttribute('data-issue-id');
    const issueUrl = button.getAttribute('data-issue-url');
    const issueTitle = button.getAttribute('data-issue-title');
    const issueType = button.getAttribute('data-issue-type');
    const issueRepo = button.getAttribute('data-issue-repo');
    const issueBody = decodeURIComponent(button.getAttribute('data-issue-body') || '');

    // Store current issue data
    currentIssueData = { issueId, issueUrl, issueTitle, issueType, issueRepo, issueBody };

    // Create menu
    const menu = document.createElement('div');
    menu.className = 'issue-actions-menu show';

    // Open on GitHub
    if (issueUrl) {
        const openItem = document.createElement('a');
        openItem.href = issueUrl;
        openItem.target = '_blank';
        openItem.className = 'issue-actions-menu-item';
        openItem.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            Open on GitHub
        `;
        menu.appendChild(openItem);
    }

    // Remove from project
    const removeItem = document.createElement('div');
    removeItem.className = 'issue-actions-menu-item';
    removeItem.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 5.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zM0 11.5A1.5 1.5 0 0 0 1.5 13h13a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H1.5A1.5 1.5 0 0 0 0 1.5v10z"/>
        </svg>
        Remove from Project
    `;
    removeItem.addEventListener('click', () => {
        removeIssueFromProject(issueId);
    });
    menu.appendChild(removeItem);

    // Convert to Issue (only for drafts)
    if (issueType === 'DRAFT') {
        const convertItem = document.createElement('div');
        convertItem.className = 'issue-actions-menu-item';
        convertItem.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/>
                <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/>
            </svg>
            Convert to Issue
        `;
        convertItem.addEventListener('click', () => {
            closeIssueActionsMenu();
            openConvertDraftModal(issueId, issueTitle, issueBody);
        });
        menu.appendChild(convertItem);
    }

    // Delete issue (only for actual issues, not drafts, and if we have repository info)
    if (issueType === 'ISSUE' && issueUrl) {
        const deleteItem = document.createElement('div');
        deleteItem.className = 'issue-actions-menu-item danger';
        deleteItem.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6Z"/>
                <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1ZM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118ZM2.5 3h11V2h-11v1Z"/>
            </svg>
            Delete Issue
        `;
        deleteItem.addEventListener('click', () => {
            deleteIssueCompletely(issueUrl, issueTitle);
        });
        menu.appendChild(deleteItem);
    }

    // Append to body instead of cell to prevent cutoff
    document.body.appendChild(menu);

    // Position the menu properly using fixed positioning
    const buttonRect = button.getBoundingClientRect();
    const container = document.querySelector('.container');
    const containerRect = container.getBoundingClientRect();

    menu.style.position = 'fixed';
    menu.style.zIndex = '10000';

    // Wait for menu to render to get its dimensions
    setTimeout(() => {
        const menuRect = menu.getBoundingClientRect();

        let top = buttonRect.bottom + 4;
        let left = buttonRect.right - menuRect.width;

        // Check if menu would go off the right edge
        if (left + menuRect.width > containerRect.right) {
            left = containerRect.right - menuRect.width - 8;
        }

        // Make sure it doesn't go off the left edge
        if (left < containerRect.left) {
            left = containerRect.left + 8;
        }

        // Check if menu would go off the bottom
        if (top + menuRect.height > containerRect.bottom) {
            // Show above the button instead
            top = buttonRect.top - menuRect.height - 4;
        }

        // Make sure it doesn't go off the top
        if (top < containerRect.top) {
            top = containerRect.top + 8;
            menu.style.maxHeight = `${containerRect.height - 16}px`;
            menu.style.overflowY = 'auto';
        }

        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
    }, 0);

    // Close menu when clicking outside
    setTimeout(() => {
        document.addEventListener('click', closeIssueActionsMenu);
    }, 0);
}

function closeIssueActionsMenu() {
    document.querySelectorAll('.issue-actions-menu').forEach(menu => menu.remove());
    document.removeEventListener('click', closeIssueActionsMenu);
}

async function removeIssueFromProject(itemId) {
    if (!currentProject) return;

    if (!confirm('Remove this issue from the project? The issue will still exist on GitHub.')) {
        return;
    }

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const query = `
            mutation DeleteProjectV2Item($projectId: ID!, $itemId: ID!) {
                deleteProjectV2Item(
                    input: {
                        projectId: $projectId
                        itemId: $itemId
                    }
                ) {
                    deletedItemId
                }
            }
        `;

        const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: query,
                variables: {
                    projectId: currentProject.id,
                    itemId: itemId
                }
            })
        });

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        showStatus('Issue removed from project', 'success');

        // Reload the project issues
        await loadProjects();
        await loadProjectIssues(currentProject.id);

    } catch (error) {
        console.error('Error removing issue from project:', error);
        showStatus('Failed to remove issue: ' + error.message, 'error');
    }
}

async function deleteIssueCompletely(issueUrl, issueTitle) {
    if (!issueUrl) return;

    // Parse the issue URL to get owner, repo, and issue number
    // URL format: https://github.com/{owner}/{repo}/issues/{number}
    const urlMatch = issueUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);

    if (!urlMatch) {
        showStatus('Could not parse issue URL', 'error');
        return;
    }

    const [, owner, repo, issueNumber] = urlMatch;

    if (!confirm(`⚠️ DELETE ISSUE PERMANENTLY?\n\nThis will delete "${issueTitle}" from GitHub completely.\n\nThis action CANNOT be undone!\n\nAre you absolutely sure?`)) {
        return;
    }

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // First, get the issue's node_id using REST API
        const getIssueResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!getIssueResponse.ok) {
            throw new Error('Failed to fetch issue details');
        }

        const issueData = await getIssueResponse.json();
        const issueNodeId = issueData.node_id;

        // Now delete the issue using GraphQL
        const deleteMutation = `
            mutation DeleteIssue($issueId: ID!) {
                deleteIssue(input: {
                    issueId: $issueId
                }) {
                    repository {
                        id
                    }
                }
            }
        `;

        const deleteResponse = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: deleteMutation,
                variables: {
                    issueId: issueNodeId
                }
            })
        });

        const result = await deleteResponse.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        showStatus('Issue deleted permanently', 'success');

        // Reload the project issues
        await loadProjects();
        if (currentProject) {
            await loadProjectIssues(currentProject.id);
        }

    } catch (error) {
        console.error('Error deleting issue:', error);
        showStatus('Failed to delete issue: ' + error.message, 'error');
    }
}

// Note: GitHub's API doesn't provide a direct way to edit issue title/description through Projects API
// Issues must be edited through the Issues API using the repository owner/name and issue number
// This functionality can be added in the future by:
// 1. Extracting repository and issue number from the issue URL
// 2. Using the PATCH /repos/{owner}/{repo}/issues/{issue_number} endpoint
// For now, users can click "Open on GitHub" to edit issues directly

function openEditIssueModal() {
    // Placeholder for future implementation
    showStatus('To edit this issue, click "Open on GitHub"', 'info');
}

async function saveIssueEdits() {
    // Placeholder for future implementation
    closeModal('editIssueModal');
}

// ============================================================================

let currentStatusDropdown = null;

function showStatusDropdown(badgeElement, itemId, currentStatus) {
    hideStatusDropdown();

    if (!currentProject || !projectFieldDefinitions[currentProject.id]) {
        showStatus('Project field definitions not loaded', 'error');
        return;
    }

    const fieldDefs = projectFieldDefinitions[currentProject.id];

    if (!fieldDefs.status || !fieldDefs.status.options) {
        showStatus('No status field found in this project', 'error');
        return;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'status-dropdown';
    dropdown.id = 'statusDropdown';

    fieldDefs.status.options.forEach(option => {
        const cssColor = githubColorToCSS(option.color);
        const isSelected = option.name === currentStatus;

        const optionDiv = document.createElement('div');
        optionDiv.className = 'status-dropdown-option';
        if (isSelected) {
            optionDiv.classList.add('selected');
        }

        optionDiv.innerHTML = `
            <span style="
                width: 10px;
                height: 10px;
                border-radius: 50%;
                background-color: ${cssColor};
                display: inline-block;
            "></span>
            <span style="flex: 1;">${option.name}</span>
            ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10.97 4.97a.75.75 0 0 1 1.07 1.05l-3.99 4.99a.75.75 0 0 1-1.08.02L4.324 8.384a.75.75 0 1 1 1.06-1.06l2.094 2.093 3.473-4.425a.267.267 0 0 1 .02-.022z"/></svg>' : ''}
        `;

        optionDiv.style.color = cssColor;

        if (!isSelected) {
            optionDiv.addEventListener('click', async () => {
                await updateItemStatusDirect(itemId, option.id, option.name, option.color);
                hideStatusDropdown();
            });
        }

        dropdown.appendChild(optionDiv);
    });

    document.body.appendChild(dropdown);

    const badgeRect = badgeElement.getBoundingClientRect();
    const container = document.querySelector('.container');
    const containerRect = container.getBoundingClientRect();

    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '10000';

    let top = badgeRect.bottom + 4;
    let left = badgeRect.left;

    // Wait for dropdown to render to get its dimensions
    setTimeout(() => {
        const dropdownRect = dropdown.getBoundingClientRect();

        // Check if dropdown would go off the right edge
        if (left + dropdownRect.width > containerRect.right) {
            left = containerRect.right - dropdownRect.width - 8;
        }

        // Make sure it doesn't go off the left edge
        if (left < containerRect.left) {
            left = containerRect.left + 8;
        }

        // Check if dropdown would go off the bottom
        if (top + dropdownRect.height > containerRect.bottom) {
            // Show above the badge instead
            top = badgeRect.top - dropdownRect.height - 4;
        }

        // Make sure it doesn't go off the top
        if (top < containerRect.top) {
            // If it doesn't fit above or below, position it at the top with max height
            top = containerRect.top + 8;
            dropdown.style.maxHeight = `${containerRect.height - 16}px`;
            dropdown.style.overflowY = 'auto';
        }

        dropdown.style.top = `${top}px`;
        dropdown.style.left = `${left}px`;
    }, 0);

    currentStatusDropdown = dropdown;

    setTimeout(() => {
        document.addEventListener('click', handleClickOutside);
    }, 0);
}

function hideStatusDropdown() {
    if (currentStatusDropdown) {
        currentStatusDropdown.remove();
        currentStatusDropdown = null;
        document.removeEventListener('click', handleClickOutside);
    }
}

function handleClickOutside(e) {
    if (currentStatusDropdown && !currentStatusDropdown.contains(e.target)) {
        hideStatusDropdown();
    }
}

async function updateItemStatusDirect(itemId, optionId, optionName, optionColor) {
    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const fieldDefs = projectFieldDefinitions[currentProject.id];
        const statusFieldId = fieldDefs.status.id;

        const query = `
            mutation UpdateItemStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
                updateProjectV2ItemFieldValue(
                    input: {
                        projectId: $projectId
                        itemId: $itemId
                        fieldId: $fieldId
                        value: { 
                            singleSelectOptionId: $optionId
                        }
                    }
                ) {
                    projectV2Item {
                        id
                    }
                }
            }
        `;

        const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: query,
                variables: {
                    projectId: currentProject.id,
                    itemId: itemId,
                    fieldId: statusFieldId,
                    optionId: optionId
                }
            })
        });

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        const badge = document.querySelector(`[data-item-id="${itemId}"]`);
        if (badge) {
            const cssColor = githubColorToCSS(optionColor);

            badge.style.backgroundColor = `${cssColor}15`;
            badge.style.color = cssColor;
            badge.style.borderColor = `${cssColor}30`;
            badge.setAttribute('data-current-status', optionName);

            badge.innerHTML = `
                <span style="
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background-color: ${cssColor};
                    display: inline-block;
                "></span>
                ${optionName}
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
                </svg>
            `;

            // Re-attach event listener
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                const itemId = e.currentTarget.getAttribute('data-item-id');
                const currentStatus = e.currentTarget.getAttribute('data-current-status');
                showStatusDropdown(e.currentTarget, itemId, currentStatus);
            });

            badge.addEventListener('mouseenter', (e) => {
                e.currentTarget.style.transform = 'scale(1.05)';
            });
            badge.addEventListener('mouseleave', (e) => {
                e.currentTarget.style.transform = 'scale(1)';
            });
        }

        showStatus(`Status changed to "${optionName}"`, 'success');

    } catch (error) {
        console.error('Error updating status:', error);
        showStatus('Failed to update status: ' + error.message, 'error');
    }
}

// ============================================================================
// Project Rename and Delete
// ============================================================================

async function fetchUserRepositories(token) {
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) {
        throw new Error('Failed to fetch repositories');
    }

    return await response.json();
}

async function openAddIssueModal() {
    if (!currentProject) return;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        if (userRepositories.length === 0) {
            showStatus('Loading repositories...', 'info');
            userRepositories = await fetchUserRepositories(tokenData.access_token);
        }

        const repoSelect = document.getElementById('issueRepository');
        repoSelect.innerHTML = '<option value="" disabled selected>Select a repository</option>';

        userRepositories.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.full_name;
            option.textContent = repo.full_name;
            option.dataset.owner = repo.owner.login;
            option.dataset.name = repo.name;
            repoSelect.appendChild(option);
        });

        document.getElementById('issueTitle').value = '';
        document.getElementById('issueBody').value = '';

        openModal('addIssueModal');

    } catch (error) {
        console.error('Error opening add issue modal:', error);
        showStatus('Failed to load repositories: ' + error.message, 'error');
    }
}

// ============================================================================
// Choose Add Type Modal
// ============================================================================

function openChooseAddTypeModal() {
    if (!currentProject) return;
    openModal('chooseAddTypeModal');
}

// ============================================================================
// Add Draft Issue
// ============================================================================

function openAddDraftModal() {
    if (!currentProject) return;

    // Clear form fields
    document.getElementById('draftTitle').value = '';
    document.getElementById('draftBody').value = '';

    openModal('addDraftModal');
}

async function addDraftToProject() {
    const title = document.getElementById('draftTitle').value.trim();
    const body = document.getElementById('draftBody').value.trim();

    if (!title) {
        showStatus('Please enter a draft title', 'error');
        return;
    }

    const confirmBtn = document.getElementById('confirmAddDraft');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // Create draft issue using GraphQL
        const query = `
            mutation AddProjectV2DraftIssue($projectId: ID!, $title: String!, $body: String) {
                addProjectV2DraftIssue(input: {
                    projectId: $projectId
                    title: $title
                    body: $body
                }) {
                    projectItem {
                        id
                    }
                }
            }
        `;

        const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: query,
                variables: {
                    projectId: currentProject.id,
                    title: title,
                    body: body || null
                }
            })
        });

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        showStatus('Draft issue added to project!', 'success');

        // Clear form fields
        document.getElementById('draftTitle').value = '';
        document.getElementById('draftBody').value = '';

        closeModal('addDraftModal');

        // Reload project issues
        const projectId = currentProject.id;
        await new Promise(resolve => setTimeout(resolve, 1000));
        await loadProjects();
        await loadProjectIssues(projectId);

    } catch (error) {
        console.error('Error adding draft to project:', error);
        showStatus('Failed to add draft: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

// ============================================================================
// Add Issue to Project
// ============================================================================

async function addIssueToProject() {
    const repoSelect = document.getElementById('issueRepository');
    const selectedOption = repoSelect.options[repoSelect.selectedIndex];
    const title = document.getElementById('issueTitle').value.trim();
    const body = document.getElementById('issueBody').value.trim();

    if (!selectedOption || !selectedOption.value) {
        showStatus('Please select a repository', 'error');
        return;
    }

    if (!title) {
        showStatus('Please enter an issue title', 'error');
        return;
    }

    const confirmBtn = document.getElementById('confirmAddIssue');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const owner = selectedOption.dataset.owner;
        const repoName = selectedOption.dataset.name;

        const createIssueResponse = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: title,
                body: body || undefined
            })
        });

        if (!createIssueResponse.ok) {
            const errorData = await createIssueResponse.json();
            throw new Error(errorData.message || 'Failed to create issue');
        }

        const createdIssue = await createIssueResponse.json();

        const query = `
            mutation AddProjectV2Item($projectId: ID!, $contentId: ID!) {
                addProjectV2ItemById(input: {
                    projectId: $projectId
                    contentId: $contentId
                }) {
                    item {
                        id
                    }
                }
            }
        `;

        const graphqlResponse = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: query,
                variables: {
                    projectId: currentProject.id,
                    contentId: createdIssue.node_id
                }
            })
        });

        const result = await graphqlResponse.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        showStatus('Issue added to project successfully!', 'success');

        document.getElementById('issueTitle').value = '';
        document.getElementById('issueBody').value = '';
        document.getElementById('issueRepository').selectedIndex = 0;

        closeModal('addIssueModal');

        const projectId = currentProject.id;
        await new Promise(resolve => setTimeout(resolve, 1000));
        await loadProjects();
        await loadProjectIssues(projectId);

    } catch (error) {
        console.error('Error adding issue to project:', error);
        showStatus('Failed to add issue: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

function openRenameProjectModal() {
    if (!currentProject) return;

    document.getElementById('newProjectTitle').value = currentProject.title;
    openModal('renameProjectModal');
}

async function renameProject() {
    if (!currentProject) return;

    const newTitle = document.getElementById('newProjectTitle').value.trim();

    if (!newTitle) {
        showStatus('Please enter a project title', 'error');
        return;
    }

    const renameBtn = document.getElementById('confirmRenameProject');
    renameBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const query = `
            mutation UpdateProject($projectId: ID!, $title: String!) {
                updateProjectV2(
                    input: {
                        projectId: $projectId
                        title: $title
                    }
                ) {
                    projectV2 {
                        id
                        title
                    }
                }
            }
        `;

        const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: query,
                variables: {
                    projectId: currentProject.id,
                    title: newTitle
                }
            })
        });

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        showStatus('Project renamed successfully', 'success');

        currentProject.title = newTitle;
        document.getElementById('projectTitle').textContent = newTitle;

        const projectSelect = document.getElementById('projectSelect');
        const selectedOption = projectSelect.querySelector(`option[value="${currentProject.id}"]`);
        if (selectedOption) {
            selectedOption.textContent = newTitle;
        }

        const projectIndex = allProjects.data.viewer.projectsV2.nodes.findIndex(p => p.id === currentProject.id);
        if (projectIndex !== -1) {
            allProjects.data.viewer.projectsV2.nodes[projectIndex].title = newTitle;
        }

        closeModal('renameProjectModal');

    } catch (error) {
        console.error('Error renaming project:', error);
        showStatus('Failed to rename project: ' + error.message, 'error');
    } finally {
        renameBtn.disabled = false;
    }
}

function openCreateProjectModal() {
    // Clear form fields
    document.getElementById('newProjectTitleInput').value = '';
    document.getElementById('newProjectDescription').value = '';
    document.getElementById('projectPublic').checked = false;
    openModal('createProjectModal');
}

async function createNewProject() {
    const title = document.getElementById('newProjectTitleInput').value.trim();
    const description = document.getElementById('newProjectDescription').value.trim();
    const isPublic = document.getElementById('projectPublic').checked;

    if (!title) {
        showStatus('Please enter a project title', 'error');
        return;
    }

    const confirmBtn = document.getElementById('confirmCreateProject');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // Get the current user's ID
        const userQuery = `
            query {
                viewer {
                    id
                }
            }
        `;

        const userResponse = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({ query: userQuery })
        });

        const userData = await userResponse.json();

        if (userData.errors) {
            throw new Error(userData.errors[0].message);
        }

        const ownerId = userData.data.viewer.id;

        // Create the project
        const createQuery = `
            mutation CreateProject($ownerId: ID!, $title: String!) {
                createProjectV2(
                    input: {
                        ownerId: $ownerId
                        title: $title
                    }
                ) {
                    projectV2 {
                        id
                        title
                        url
                        public
                    }
                }
            }
        `;

        const createResponse = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: createQuery,
                variables: {
                    ownerId: ownerId,
                    title: title
                }
            })
        });

        const result = await createResponse.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        const newProjectId = result.data.createProjectV2.projectV2.id;

        // Update the project visibility if needed
        if (isPublic !== result.data.createProjectV2.projectV2.public) {
            const updateQuery = `
                mutation UpdateProjectVisibility($projectId: ID!, $public: Boolean!) {
                    updateProjectV2(
                        input: {
                            projectId: $projectId
                            public: $public
                        }
                    ) {
                        projectV2 {
                            id
                            public
                        }
                    }
                }
            `;

            const updateResponse = await fetch("https://api.github.com/graphql", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${tokenData.access_token}`,
                },
                body: JSON.stringify({
                    query: updateQuery,
                    variables: {
                        projectId: newProjectId,
                        public: isPublic
                    }
                })
            });

            const updateResult = await updateResponse.json();

            if (updateResult.errors) {
                console.error('Error updating project visibility:', updateResult.errors);
                // Don't throw here, project was created successfully
            }
        }

        showStatus('Project created successfully!', 'success');

        // Clear form fields
        document.getElementById('newProjectTitleInput').value = '';
        document.getElementById('newProjectDescription').value = '';
        document.getElementById('projectPublic').checked = false;

        closeModal('createProjectModal');

        // Reload projects to show the new one
        await loadProjects();

        // Select the newly created project
        const projectSelect = document.getElementById('projectSelect');
        projectSelect.value = newProjectId;

        // Trigger change event to load the project
        await loadProjectIssues(newProjectId);

    } catch (error) {
        console.error('Error creating project:', error);
        showStatus('Failed to create project: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

function openEditProjectModal() {
    if (!currentProject) return;

    // Populate the form with current project data (description and visibility only)
    document.getElementById('editProjectDescription').value = currentProject.shortDescription || '';

    // Set the visibility radio button
    if (currentProject.public) {
        document.getElementById('editProjectPublic').checked = true;
    } else {
        document.getElementById('editProjectPrivate').checked = true;
    }

    openModal('editProjectModal');
}

async function saveProjectEdits() {
    if (!currentProject) return;

    const newDescription = document.getElementById('editProjectDescription').value.trim();
    const isPublic = document.getElementById('editProjectPublic').checked;

    const confirmBtn = document.getElementById('confirmEditProject');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // Update project description and visibility (title stays the same)
        const query = `
            mutation UpdateProject($projectId: ID!, $shortDescription: String, $public: Boolean!) {
                updateProjectV2(
                    input: {
                        projectId: $projectId
                        shortDescription: $shortDescription
                        public: $public
                    }
                ) {
                    projectV2 {
                        id
                        title
                        shortDescription
                        public
                    }
                }
            }
        `;

        const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenData.access_token}`,
            },
            body: JSON.stringify({
                query: query,
                variables: {
                    projectId: currentProject.id,
                    shortDescription: newDescription || null,
                    public: isPublic
                }
            })
        });

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL Error:', result.errors);
            throw new Error(result.errors[0].message);
        }

        showStatus('Project settings updated successfully', 'success');

        // Update the local project data
        currentProject.shortDescription = newDescription;
        currentProject.public = isPublic;

        // Update in allProjects array
        const projectIndex = allProjects.data.viewer.projectsV2.nodes.findIndex(p => p.id === currentProject.id);
        if (projectIndex !== -1) {
            allProjects.data.viewer.projectsV2.nodes[projectIndex].shortDescription = newDescription;
            allProjects.data.viewer.projectsV2.nodes[projectIndex].public = isPublic;
        }

        closeModal('editProjectModal');

    } catch (error) {
        console.error('Error updating project:', error);
        showStatus('Failed to update project: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

async function deleteCurrentProject() {
    if (!currentProject) return;

    deleteCallback = async () => {
        try {
            const tokenData = await getStoredToken();
            if (!tokenData || !tokenData.access_token) {
                showStatus('Not authenticated', 'error');
                return;
            }

            const query = `
                mutation DeleteProject($projectId: ID!) {
                    deleteProjectV2(
                        input: {
                            projectId: $projectId
                        }
                    ) {
                        projectV2 {
                            id
                        }
                    }
                }
            `;

            const response = await fetch("https://api.github.com/graphql", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${tokenData.access_token}`,
                },
                body: JSON.stringify({
                    query: query,
                    variables: {
                        projectId: currentProject.id
                    }
                })
            });

            const result = await response.json();

            if (result.errors) {
                console.error('GraphQL Error:', result.errors);
                throw new Error(result.errors[0].message);
            }

            showStatus('Project deleted successfully', 'success');

            const projectIndex = allProjects.data.viewer.projectsV2.nodes.findIndex(p => p.id === currentProject.id);
            if (projectIndex !== -1) {
                allProjects.data.viewer.projectsV2.nodes.splice(projectIndex, 1);
            }

            const projectSelect = document.getElementById('projectSelect');
            const selectedOption = projectSelect.querySelector(`option[value="${currentProject.id}"]`);
            if (selectedOption) {
                selectedOption.remove();
            }

            projectSelect.value = '';
            hideProjectIssues();

        } catch (error) {
            console.error('Error deleting project:', error);
            showStatus('Failed to delete project: ' + error.message, 'error');
        }
    };

    document.getElementById('deleteConfirmMessage').textContent =
        `Are you sure you want to delete the project "${currentProject.title}"? This action cannot be undone.`;
    openModal('deleteConfirmModal');
}

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    // Check if we're in a popout window
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('popout') === 'true') {
        document.body.classList.add('popout');
    }

    // Popout button
    document.getElementById('popoutBtn').addEventListener('click', () => {
        const width = 800;
        const height = 700;
        const left = (screen.width - width) / 2;
        const top = (screen.height - height) / 2;

        chrome.windows.create({
            url: chrome.runtime.getURL('popup.html?popout=true'),
            type: 'popup',
            width: width,
            height: height,
            left: Math.round(left),
            top: Math.round(top)
        });

        window.close();
    });

    // Login button
    document.getElementById('loginBtn').addEventListener('click', async () => {
        const loginBtn = document.getElementById('loginBtn');
        loginBtn.disabled = true;
        loginBtn.textContent = 'Logging in...';

        try {
            const tokenData = await authenticateWithGitHub();
            await storeToken(tokenData);

            const userData = await fetchGitHubUser(tokenData.access_token);

            document.getElementById('loginView').classList.add('hidden');
            document.getElementById('mainView').classList.remove('hidden');

            const avatarWrapper = document.getElementById('avatarWrapper');
            const userAvatar = document.getElementById('userAvatar');

            userAvatar.src = userData.avatar_url;
            avatarWrapper.style.display = 'block';

            await loadGists();
            await loadProjects();
            showStatus('Logged in successfully!', 'success');

        } catch (error) {
            console.error('Login error:', error);
            showStatus('Login failed: ' + error.message, 'error');
            loginBtn.disabled = false;
            loginBtn.textContent = 'Login with GitHub';
        }
    });

    // Logout
    document.getElementById('avatarWrapper').addEventListener('click', async () => {
        if (confirm('Are you sure you want to log out?')) {
            await clearStoredToken();
            document.getElementById('loginView').classList.remove('hidden');
            document.getElementById('mainView').classList.add('hidden');
            document.getElementById('avatarWrapper').style.display = 'none';
            hideGistPreview();
            showStatus('Logged out successfully', 'info');
        }
    });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab') + 'Tab';
            document.getElementById(tabId).classList.add('active');
        });
    });

    // Gist select
    document.getElementById('gistSelect').addEventListener('change', async (e) => {
        const gistId = e.target.value;
        if (!gistId) {
            hideGistPreview();
            return;
        }

        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const gist = await fetchGistById(tokenData.access_token, gistId);
        displayGistPreview(gist);
    });

    // Refresh gists
    document.getElementById('refreshGistsBtn').addEventListener('click', async () => {
        const btn = document.getElementById('refreshGistsBtn');
        btn.disabled = true;

        try {
            await loadGists();
            showStatus('Gists refreshed successfully', 'success');
        } catch (error) {
            console.error('Error refreshing gists:', error);
            showStatus('Failed to refresh gists', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    // Projects tab - Project select
    document.getElementById('projectSelect').addEventListener('change', async (e) => {
        const projectId = e.target.value;
        if (!projectId) {
            hideProjectIssues();
            return;
        }

        await loadProjectIssues(projectId);
    });

    // Projects tab - Refresh projects
    document.getElementById('refreshProjectsBtn').addEventListener('click', async () => {
        const btn = document.getElementById('refreshProjectsBtn');
        btn.disabled = true;

        try {
            await loadProjects();
            showStatus('Projects refreshed successfully', 'success');

        } catch (error) {
            console.error('Error refreshing projects:', error);
            showStatus('Failed to refresh projects', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    // Create new gist button
    document.getElementById('createNewGistBtn').addEventListener('click', () => {
        currentGist = null;
        openCreateGistModal();
    });

    // Create new project button
    document.getElementById('createNewProjectBtn').addEventListener('click', () => {
        openCreateProjectModal();
    });

    // Edit gist button
    document.getElementById('editGistBtn').addEventListener('click', openFileEditorModal);

    // Add file button
    document.getElementById('addFileBtn').addEventListener('click', openAddFileModal);

    // Rename gist button
    document.getElementById('renameGistBtn').addEventListener('click', openRenameGistModal);

    // Delete gist button
    document.getElementById('deleteGistBtn').addEventListener('click', deleteCurrentGist);

    // Gist editor modal
    document.getElementById('closeGistEditorModal').addEventListener('click', () => {
        closeModal('gistEditorModal');
        document.getElementById('gistFilename').disabled = false;
    });
    document.getElementById('cancelGistEditor').addEventListener('click', () => {
        closeModal('gistEditorModal');
        document.getElementById('gistFilename').disabled = false;
    });
    document.getElementById('saveGist').addEventListener('click', saveGist);

    // Add file modal
    document.getElementById('closeAddFileModal').addEventListener('click', () => closeModal('addFileModal'));
    document.getElementById('cancelAddFile').addEventListener('click', () => closeModal('addFileModal'));
    document.getElementById('saveNewFile').addEventListener('click', saveNewFile);

    // File editor modal
    document.getElementById('closeFileEditorModal').addEventListener('click', () => closeModal('fileEditorModal'));
    document.getElementById('cancelFileEditor').addEventListener('click', () => closeModal('fileEditorModal'));
    document.getElementById('saveFileChanges').addEventListener('click', saveFileChanges);
    document.getElementById('fileSelector').addEventListener('change', loadSelectedFile);
    document.getElementById('renameFileBtn').addEventListener('click', openRenameFileModal);
    document.getElementById('deleteFileBtn').addEventListener('click', deleteCurrentFile);

    // Delete confirm modal
    document.getElementById('closeDeleteConfirmModal').addEventListener('click', () => closeModal('deleteConfirmModal'));
    document.getElementById('cancelDelete').addEventListener('click', () => closeModal('deleteConfirmModal'));
    document.getElementById('confirmDelete').addEventListener('click', confirmDeleteAction);

    // Rename gist modal
    document.getElementById('closeRenameGistModal').addEventListener('click', () => closeModal('renameGistModal'));
    document.getElementById('cancelRenameGist').addEventListener('click', () => closeModal('renameGistModal'));
    document.getElementById('confirmRenameGist').addEventListener('click', renameGist);

    // Rename file modal
    document.getElementById('closeRenameFileModal').addEventListener('click', () => closeModal('renameFileModal'));
    document.getElementById('cancelRenameFile').addEventListener('click', () => closeModal('renameFileModal'));
    document.getElementById('confirmRenameFile').addEventListener('click', renameFile);

    // Rename project modal
    document.getElementById('closeRenameProjectModal').addEventListener('click', () => closeModal('renameProjectModal'));
    document.getElementById('cancelRenameProject').addEventListener('click', () => closeModal('renameProjectModal'));
    document.getElementById('confirmRenameProject').addEventListener('click', renameProject);

    // Add issue modal
    document.getElementById('closeAddIssueModal').addEventListener('click', () => closeModal('addIssueModal'));
    document.getElementById('cancelAddIssue').addEventListener('click', () => closeModal('addIssueModal'));
    document.getElementById('confirmAddIssue').addEventListener('click', addIssueToProject);

    // Edit issue modal
    document.getElementById('closeEditIssueModal').addEventListener('click', () => closeModal('editIssueModal'));
    document.getElementById('cancelEditIssue').addEventListener('click', () => closeModal('editIssueModal'));
    document.getElementById('confirmEditIssue').addEventListener('click', saveIssueEdits);

    // Create project modal
    document.getElementById('closeCreateProjectModal').addEventListener('click', () => closeModal('createProjectModal'));
    document.getElementById('cancelCreateProject').addEventListener('click', () => closeModal('createProjectModal'));
    document.getElementById('confirmCreateProject').addEventListener('click', createNewProject);

    // Edit project modal
    document.getElementById('closeEditProjectModal').addEventListener('click', () => closeModal('editProjectModal'));
    document.getElementById('cancelEditProject').addEventListener('click', () => closeModal('editProjectModal'));
    document.getElementById('confirmEditProject').addEventListener('click', saveProjectEdits);

    // Project actions
    document.getElementById('addIssueBtn').addEventListener('click', openChooseAddTypeModal);
    document.getElementById('editProjectBtn').addEventListener('click', openEditProjectModal);
    document.getElementById('renameProjectBtn').addEventListener('click', openRenameProjectModal);
    document.getElementById('deleteProjectBtn').addEventListener('click', deleteCurrentProject);

    // Choose add type modal
    document.getElementById('closeChooseAddTypeModal').addEventListener('click', () => closeModal('chooseAddTypeModal'));
    document.getElementById('chooseAddIssue').addEventListener('click', () => {
        closeModal('chooseAddTypeModal');
        openAddIssueModal();
    });
    document.getElementById('chooseAddDraft').addEventListener('click', () => {
        closeModal('chooseAddTypeModal');
        openAddDraftModal();
    });

    // Add draft modal
    document.getElementById('closeAddDraftModal').addEventListener('click', () => closeModal('addDraftModal'));
    document.getElementById('cancelAddDraft').addEventListener('click', () => closeModal('addDraftModal'));
    document.getElementById('confirmAddDraft').addEventListener('click', addDraftToProject);

    // Convert draft to issue modal
    document.getElementById('closeConvertDraftModal').addEventListener('click', () => closeModal('convertDraftModal'));
    document.getElementById('cancelConvertDraft').addEventListener('click', () => closeModal('convertDraftModal'));
    document.getElementById('confirmConvertDraft').addEventListener('click', convertDraftToIssue);

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.style.display = 'none';
                document.getElementById('gistFilename').disabled = false;
            }
        });
    });

    // Check for existing authentication
    const tokenData = await getStoredToken();
    if (tokenData && tokenData.access_token) {
        try {
            const userData = await fetchGitHubUser(tokenData.access_token);

            document.getElementById('loginView').classList.add('hidden');
            document.getElementById('mainView').classList.remove('hidden');

            const avatarWrapper = document.getElementById('avatarWrapper');
            const userAvatar = document.getElementById('userAvatar');

            userAvatar.src = userData.avatar_url;
            avatarWrapper.style.display = 'block';

            await loadGists();
            await loadProjects();

        } catch (error) {
            console.error('Error loading user data:', error);
            await clearStoredToken();
        }
    }
});