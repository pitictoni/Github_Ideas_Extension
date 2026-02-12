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

// Projects state
let allRepos = [];
let currentRepo = null;
let allProjects = [];
let currentProject = null;

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

async function fetchUserRepos(token) {
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

async function fetchRepoProjects(token, owner, repo) {
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json"
        },
        body: JSON.stringify({
            query: `
      query {
        repository(owner:"${owner}", name:"${repo}") {
          projectsV2(first: 100) {
            nodes {
              id
              title
              url
            }
          }
        }
      }
    `
        })
    })

    if (!response.ok) {
        throw new Error('Failed to fetch projects');
    }

    return await response.json();



}

async function fetchProjectColumns(token, projectId) {
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json"
        },
        body: JSON.stringify({
            query: `
      query {
        node(id: "${projectId}") {
        ... on ProjectV2 {
            id
            title
            url
            shortDescription
            public
            closed
            items(first: 100) {
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
                    ... on ProjectV2ItemFieldSingleSelectValue {
                    name
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
                    owner {
                        login
                    }
                    }
                    author {
                    login
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
                    }
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
                    owner {
                        login
                    }
                    }
                    author {
                    login
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

    `
        })
    })

    if (!response.ok) {
        throw new Error('Failed to fetch project columns');
    }

    return await response.json();
}

async function fetchColumnCards(token, columnId) {
    const response = await fetch(`https://api.github.com/projects/columns/${columnId}/cards`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json'
        }
    });

    if (!response.ok) {
        throw new Error('Failed to fetch column cards');
    }

    return await response.json();
}

async function fetchIssueDetails(token, issueUrl) {
    const response = await fetch(issueUrl, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) {
        return null;
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

async function loadRepos() {
    const tokenData = await getStoredToken();
    if (!tokenData || !tokenData.access_token) {
        return;
    }

    try {
        allRepos = await fetchUserRepos(tokenData.access_token);

        const repoSelect = document.getElementById('repoSelect');
        repoSelect.innerHTML = '<option value="" disabled selected>Select a repository</option>';

        allRepos.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.full_name;
            option.textContent = repo.full_name;
            option.dataset.url = repo.html_url;
            repoSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading repos:', error);
        showStatus('Failed to load repositories', 'error');
    }
}

async function loadProjects(owner, repo) {
    const tokenData = await getStoredToken();
    if (!tokenData || !tokenData.access_token) {
        return;
    }

    try {
        allProjects = await fetchRepoProjects(tokenData.access_token, owner, repo);

        const projectSelect = document.getElementById('projectSelect');
        projectSelect.innerHTML = '<option value="" disabled selected>Select a project</option>';

        if (allProjects.length === 0) {
            showStatus('No projects found in this repository', 'info');
            document.getElementById('projectSelectSection').style.display = 'none';
            return;
        }

        allProjects.data.repository.projectsV2.nodes.forEach(project => {
            const option = document.createElement('option');
            option.value = project.id;
            option.textContent = project.title;
            option.dataset.url = project.url;
            projectSelect.appendChild(option);
        });

        document.getElementById('projectSelectSection').style.display = 'block';
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
        const project = allProjects.data.repository.projectsV2.nodes.find(p => p.id === projectId);
        if (!project) return;
        console.log('allProjects:', allProjects);

        currentProject = project;
        document.getElementById('projectTitle').textContent = project.title;

        const viewBtn = document.getElementById('viewProjectBtn');
        viewBtn.onclick = () => window.open(project.url, '_blank');

        // Fetch all columns
        const columns = await fetchProjectColumns(tokenData.access_token, projectId);
        console.log('Project columns:', columns);

        const allCards = [];

        columns.data.node.items.nodes.forEach(item => {
            if (item.content) {
                // Find the "Status" field value
                let status = 'No Status';
                item.fieldValues.nodes.forEach(fieldValue => {
                    if (fieldValue.field?.name === 'Status' && fieldValue.name) {
                        status = fieldValue.name;
                    }
                });

                allCards.push({
                    title: item.content.title,
                    status: status,
                    url: item.content.url,
                    state: item.content.state || 'open',
                    type: item.type,
                    labels: item.content.labels?.nodes || [],
                    assignees: item.content.assignees?.nodes || []
                });
            }
        });

        console.log(`Loaded ${allCards.length} items in ONE GraphQL call!`);
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

            // Determine status class
            const statusLower = issue.status.toLowerCase();
            let statusClass = 'todo';
            if (statusLower.includes('done') || statusLower.includes('closed') || issue.state === 'closed') {
                statusClass = 'done';
            } else if (statusLower.includes('progress') || statusLower.includes('doing')) {
                statusClass = 'in-progress';
            } else if (statusLower.includes('todo') || statusLower.includes('backlog')) {
                statusClass = 'todo';
            } else if (issue.state === 'open') {
                statusClass = 'open';
            }

            row.innerHTML = `
                <td>
                    <a href="${issue.url}" target="_blank" class="issue-title" style="text-decoration: none; color: var(--text-primary);">
                        ${issue.title}
                    </a>
                </td>
                <td>
                    <span class="issue-status ${statusClass}">
                        <span class="status-dot ${statusClass}"></span>
                        ${issue.status}
                    </span>
                </td>
            `;

            tableBody.appendChild(row);
        });
    }

    issuesSection.style.display = 'block';
}

function hideProjectIssues() {
    document.getElementById('projectIssuesSection').style.display = 'none';
    currentProject = null;
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
            await loadRepos();
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

    // Projects tab - Repo select
    document.getElementById('repoSelect').addEventListener('change', async (e) => {
        const repoFullName = e.target.value;
        if (!repoFullName) return;

        const [owner, repo] = repoFullName.split('/');
        currentRepo = { owner, repo, fullName: repoFullName };

        hideProjectIssues();
        await loadProjects(owner, repo);
    });

    // Projects tab - Refresh repos
    document.getElementById('refreshReposBtn').addEventListener('click', async () => {
        const btn = document.getElementById('refreshReposBtn');
        btn.disabled = true;

        try {
            await loadRepos();
            showStatus('Repositories refreshed successfully', 'success');
        } catch (error) {
            console.error('Error refreshing repos:', error);
            showStatus('Failed to refresh repositories', 'error');
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
            if (currentRepo) {
                await loadProjects(currentRepo.owner, currentRepo.repo);
                showStatus('Projects refreshed successfully', 'success');
            }
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

    // View gist button (already handled in displayGistPreview)

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
            await loadRepos();

        } catch (error) {
            console.error('Error loading user data:', error);
            await clearStoredToken();
        }
    }
});