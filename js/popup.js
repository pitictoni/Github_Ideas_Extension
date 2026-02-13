const CONFIG = {
    GITHUB_CLIENT_ID: '',
    BACKEND_URL: '',
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
        priority: null,
        other: []
    };

    if (!project.fields || !project.fields.nodes) {
        return fieldDefs;
    }

    project.fields.nodes.forEach(field => {
        // Single select fields (Status, Priority, etc.)
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
            } else if (field.name.toLowerCase() === 'priority') {
                fieldDefs.priority = fieldInfo;
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
        } else {
            // Create new gist
            await createGist(tokenData.access_token, description, filename, content, isPublic);
            showStatus('Gist created successfully!', 'success');
        }

        await loadGists();
        closeModal('gistEditorModal');
        hideGistPreview();

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
    }

    issuesSection.style.display = 'block';
}

function hideProjectIssues() {
    document.getElementById('projectIssuesSection').style.display = 'none';
    currentProject = null;
}

// ============================================================================
// Status Change Dropdown
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

    // Edit gist button
    document.getElementById('editGistBtn').addEventListener('click', openFileEditorModal);

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