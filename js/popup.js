// Configuration
const CONFIG = {
    GITHUB_CLIENT_ID: '',
    BACKEND_URL: '',
    REDIRECT_URI: chrome.identity.getRedirectURL()
};

// ============================================================================
// Utility Functions
// ============================================================================

function base64URLEncode(buffer) {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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
        tokenExpiry: Date.now() + (tokenData.expires_in || 3600) * 1000
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
        `&scope=repo gist read:user` +
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

async function fetchGitHubRepos(token) {
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (response.status === 401) {
        await clearStoredToken();
        throw new Error('Token expired or invalid');
    }

    if (!response.ok) {
        throw new Error('Failed to fetch repositories');
    }

    return await response.json();
}

async function fetchGists(token, repoName = null) {
    const response = await fetch('https://api.github.com/gists', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) {
        throw new Error('Failed to fetch gists');
    }

    const allGists = await response.json();

    return allGists;
}

async function createGist(token, repoName, title, content) {
    const filename = title;

    const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            description: title,
            public: false,
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

async function updateGist(token, gistId, title, content) {
    // Get the first filename from the gist
    const gist = allGists.find(g => g.id === gistId);
    if (!gist) {
        throw new Error('Gist not found');
    }

    const firstFilename = Object.keys(gist.files)[0];
    
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            description: title,
            files: {
                [firstFilename]: {
                    content: content
                }
            }
        })
    });

    if (!response.ok) {
        throw new Error('Failed to update gist');
    }

    return await response.json();
}

// ============================================================================
// UI Updates
// ============================================================================

function showView(viewName) {
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('mainView').classList.add('hidden');
    document.getElementById(`${viewName}View`).classList.remove('hidden');
}

function showStatus(message, type = 'info') {
    const statusEl = document.getElementById('statusMessage');
    statusEl.textContent = message;
    statusEl.className = `status-message status-${type}`;
    statusEl.classList.remove('hidden');

    setTimeout(() => {
        statusEl.classList.add('hidden');
    }, 5000);
}

async function updateUIForLoggedInUser(token) {
    try {
        showView('main');

        // Fetch and display user data
        const userData = await fetchGitHubUser(token);
        document.getElementById('username').textContent = userData.login;
        document.getElementById('userAvatar').src = userData.avatar_url;

        // Store user data
        await chrome.storage.local.set({ userData });

        // Load repositories
        //await loadRepositories(token);

        // Load previously selected repo if exists
        //const result = await chrome.storage.local.get('selectedRepo');
        //if (result.selectedRepo) {
        //  document.getElementById('repoSelect').value = result.selectedRepo;
        //  updateRepoStats(result.selectedRepo);
        //}
    } catch (error) {
        console.error('Error updating UI:', error);
        showStatus('Error loading user data', 'error');
    }
}

async function loadRepositories(token) {
    try {
        const repos = await fetchGitHubRepos(token);
        await chrome.storage.local.set({ repos });

        const repoSelect = document.getElementById('repoSelect');
        repoSelect.innerHTML = '<option value="">Select a repository...</option>';

        repos.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.full_name;
            option.textContent = repo.full_name;
            option.dataset.stars = repo.stargazers_count;
            option.dataset.forks = repo.forks_count;
            option.dataset.url = repo.html_url;
            repoSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading repositories:', error);
        showStatus('Error loading repositories', 'error');
    }
}

// ============================================================================
// Gist Modal
// ============================================================================

function showCreateGistModal(repoName, token) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    modal.innerHTML = `
	<div class="modal">
	  <div class="modal-header">
		<h3>Create Note</h3>
		<button class="modal-close" id="closeModal">&times;</button>
	  </div>
	  <div class="modal-body">
		<input type="text" id="gistTitle" class="input" placeholder="Note title..." />
		<textarea id="gistContent" class="textarea" placeholder="Write your note here..." rows="10"></textarea>
	  </div>
	  <div class="modal-footer">
		<button class="btn btn-secondary" id="cancelGist">Cancel</button>
		<button class="btn btn-primary" id="saveGist">Save Note</button>
	  </div>
	</div>
  `;

    document.body.appendChild(modal);

    // Focus title input
    document.getElementById('gistTitle').focus();

    // Event listeners
    const closeModal = () => modal.remove();

    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('cancelGist').addEventListener('click', closeModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    document.getElementById('saveGist').addEventListener('click', async () => {
        const title = document.getElementById('gistTitle').value.trim();
        const content = document.getElementById('gistContent').value.trim();

        if (!title) {
            showStatus('Please enter a title', 'error');
            return;
        }

        if (!content) {
            showStatus('Please enter some content', 'error');
            return;
        }

        const saveBtn = document.getElementById('saveGist');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            const gist = await createGist(token, repoName, title, content);
            showStatus('Note saved successfully!', 'success');
            closeModal();

            // Open the gist in a new tab
            setTimeout(() => {
                chrome.tabs.create({ url: gist.html_url });
            }, 500);
        } catch (error) {
            console.error('Error creating gist:', error);
            showStatus('Failed to create note: ' + error.message, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Note';
        }
    });
}

function showGistsModal(repoName, gists) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    let gistsHTML = '';

    if (gists.length === 0) {
        gistsHTML = '<p class="empty-state">No notes found.</p>';
    } else {
        gistsHTML = '<div class="gist-list">';
        gists.forEach(gist => {
            const date = new Date(gist.updated_at);
            const title = gist.description || Object.keys(gist.files)[0] || 'Untitled Gist';

            gistsHTML += `
		<div class="gist-item">
		  <div class="gist-header">
			<strong>${title}</strong>
			<span class="gist-date">${date.toLocaleString()}</span>
		  </div>
		  <a href="${gist.html_url}" target="_blank" class="btn-link">
			View on GitHub →
		  </a>
		</div>
	  `;
        });
        gistsHTML += '</div>';
    }

    modal.innerHTML = `
	<div class="modal">
	  <div class="modal-header">
		<h3>Notes (${gists.length})</h3>
		<button class="modal-close" id="closeModal">&times;</button>
	  </div>
	  <div class="modal-body">
		${gistsHTML}
	  </div>
	  <div class="modal-footer">
		<button class="btn btn-secondary" id="closeGistsModal">Close</button>
	  </div>
	</div>
  `;

    document.body.appendChild(modal);

    const closeModal = () => modal.remove();

    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('closeGistsModal').addEventListener('click', closeModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
}

// ============================================================================
// Event Listeners
// ============================================================================

// State to store all gists
let allGists = [];
let filteredGists = [];

// Detect if we're in a popup or popout window
function detectPopoutMode() {
    // Check if we're in a chrome extension popup (small fixed size) or a window
    const isPopout = window.outerWidth > 400 || 
                     new URLSearchParams(window.location.search).get('popout') === 'true';
    
    if (isPopout) {
        document.body.classList.add('popout');
    }
    
    return isPopout;
}

document.addEventListener('DOMContentLoaded', async () => {
    // Detect and apply popout mode
    const isPopout = detectPopoutMode();
    
    // Pop-out button functionality
    const popoutBtn = document.getElementById('popoutBtn');
    if (popoutBtn && !isPopout) {
        popoutBtn.addEventListener('click', () => {
            const popupUrl = chrome.runtime.getURL('popup.html?popout=true');
            chrome.windows.create({
                url: popupUrl,
                type: 'popup',
                width: 600,
                height: 800
            });
            
            // Close the original popup
            window.close();
        });
    }

    // Check if user is already logged in
    const tokenData = await getStoredToken();
    if (tokenData && tokenData.access_token) {
        updateUIForLoggedInUser(tokenData.access_token);
    } else {
        showView('login');
    }

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tabName = btn.dataset.tab;

            // Update tab buttons
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            const tabContent = document.getElementById(`${tabName}Tab`);
            if (tabContent) tabContent.classList.add('active');

            // If switching to Gists tab, load gists
            if (tabName === 'gists') {
                try {
                    const tokenData = await getStoredToken();
                    if (tokenData && tokenData.access_token) {
                        await loadAllGistsToDropdown(tokenData.access_token);
                    }
                } catch (err) {
                    console.error('Error loading gists on tab switch:', err);
                }
            }
        });
    });

    // Login button
    document.getElementById('loginBtn').addEventListener('click', async () => {
        const btn = document.getElementById('loginBtn');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = 'Logging in...';

        try {
            const tokenData = await authenticateWithGitHub();
            if (tokenData && tokenData.access_token) {
                await storeToken(tokenData);
                await updateUIForLoggedInUser(tokenData.access_token);
                showStatus('Successfully logged in!', 'success');
            }
        } catch (error) {
            console.error('GitHub auth error:', error);
            showStatus('Failed to login. Please try again.', 'error');
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    });

    // Logout button
    document.getElementById('logoutBtn').addEventListener('click', async () => {
        await clearStoredToken();
        showView('login');
        showStatus('Logged out successfully', 'success');
    });

    // Repository selection
    //document.getElementById('repoSelect').addEventListener('change', async (e) => {
    //  const selectedRepo = e.target.value;
    //  await chrome.storage.local.set({ selectedRepo });
    //  updateRepoStats(selectedRepo);
    //});

    // Refresh repositories
    /*document.getElementById('refreshRepos').addEventListener('click', async () => {
      const btn = document.getElementById('refreshRepos');
      btn.disabled = true;
      btn.textContent = 'Refreshing...';
  	
      try {
        const tokenData = await getStoredToken();
        if (tokenData && tokenData.access_token) {
          await loadRepositories(tokenData.access_token);
          showStatus('Repositories refreshed', 'success');
        }
      } catch (error) {
        console.error('Error refreshing repos:', error);
        showStatus('Failed to refresh repositories', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
          </svg>
          Refresh
        `;
      }
    });*/

    // Create/Update gist button
    document.getElementById('createGistBtn').addEventListener('click', async () => {
        const gistTitleInput = document.getElementById('gistTitleInput');
        const gistContentArea = document.getElementById('gistContentArea');
        const gistSelect = document.getElementById('gistSelect');
        const createBtn = document.getElementById('createGistBtn');

        // Check if we're in update mode (no title input visible) or create mode
        const isUpdateMode = gistTitleInput.style.display === 'none';
        const selectedGistId = gistSelect.value;

        if (isUpdateMode && !selectedGistId) {
            showStatus('Please select a gist to update', 'error');
            return;
        }

        if (!isUpdateMode) {
            // Create mode - title input is visible
            const filename = gistTitleInput.value.trim();
            const content = gistContentArea.value.trim();

            if (!filename) {
                showStatus('Please enter a filename', 'error');
                return;
            }

            if (!content) {
                showStatus('Please write some content', 'error');
                return;
            }

            createBtn.disabled = true;
            document.getElementById('createGistBtnText').textContent = 'Saving...';

            try {
                const tokenData = await getStoredToken();
                if (!tokenData || !tokenData.access_token) {
                    showStatus('Not authenticated', 'error');
                    return;
                }

                await createGist(tokenData.access_token, '', filename, content);
                showStatus('Note saved successfully!', 'success');

                // Refresh the dropdown
                await loadAllGistsToDropdown(tokenData.access_token);

                // Reset UI
                /*gistSelect.value = '';
                gistTitleInput.value = '';
                gistContentArea.value = '';
                gistTitleInput.style.display = 'none';
                document.getElementById('viewGistOnGithub').style.display = 'none';
                document.getElementById('deleteGistBtn').style.display = 'none';
                document.getElementById('viewGistsBtn').style.display = 'inline-flex';
                */

            } catch (error) {
                console.error('Error creating gist:', error);
                showStatus('Failed to create note: ' + error.message, 'error');
            } finally {
                createBtn.disabled = false;
                document.getElementById('createGistBtnText').textContent = 'Create Note';
            }
        } else {
            // Update mode
            const content = gistContentArea.value.trim();

            if (!content) {
                showStatus('Please write some content', 'error');
                return;
            }

            createBtn.disabled = true;
            document.getElementById('createGistBtnText').textContent = 'Updating...';

            try {
                const tokenData = await getStoredToken();
                if (!tokenData || !tokenData.access_token) {
                    showStatus('Not authenticated', 'error');
                    return;
                }

                const selectedOption = gistSelect.options[gistSelect.selectedIndex];
                const gistTitle = selectedOption.textContent;

                await updateGist(tokenData.access_token, selectedGistId, gistTitle, content);
                showStatus('Note updated successfully!', 'success');

                // Refresh the dropdown to get the updated content
                await loadAllGistsToDropdown(tokenData.access_token);

            } catch (error) {
                console.error('Error updating gist:', error);
                showStatus('Failed to update note: ' + error.message, 'error');
            } finally {
                createBtn.disabled = false;
                document.getElementById('createGistBtnText').textContent = 'Update Note';
            }
        }
    });

    // View gists button
    /*document.getElementById('viewGistsBtn').addEventListener('click', async () => {
      const selectedRepo = document.getElementById('repoSelect').value;
      if (!selectedRepo) {
        showStatus('Please select a repository first', 'error');
        return;
      }
  	
      const btn = document.getElementById('viewGistsBtn');
      btn.disabled = true;
      btn.textContent = 'Loading...';
  	
      try {
        const tokenData = await getStoredToken();
        if (tokenData && tokenData.access_token) {
          const gists = await fetchGists(tokenData.access_token, selectedRepo);
          showGistsModal(selectedRepo, gists);
        }
      } catch (error) {
        console.error('Error loading gists:', error);
        showStatus('Failed to load notes', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5v-3zM2.5 2a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm6.5.5A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5v-3zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM1 10.5A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-3zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm6.5.5A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5v-3zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3z"/>
          </svg>
          View Notes
        `;
      }
    });*/
});

// Refresh gists button
document.getElementById('refreshGistsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshGistsBtn');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>Loading...</span>';

    try {
        const tokenData = await getStoredToken();
        if (tokenData && tokenData.access_token) {
            await loadAllGistsToDropdown(tokenData.access_token);
            showStatus('Gists loaded successfully', 'success');
        }
    } catch (error) {
        console.error('Error loading gists:', error);
        showStatus('Failed to load gists', 'error');
    } finally {
        document.getElementById('gistTitleInput').style.display = 'none';
        document.getElementById('gistContentArea').value = '';
        document.getElementById('viewGistOnGithub').style.display = 'inline-flex';
        document.getElementById('deleteGistBtn').style.display = 'inline-flex';
        btn.disabled = false;
        btn.innerHTML = originalHTML;
    }
});

// Gist selection
document.getElementById('gistSelect').addEventListener('change', async (e) => {
    const selectedGistId = e.target.value;
    const selectedOption = e.target.options[e.target.selectedIndex];
    const selectedText = selectedOption.textContent;
    const createBtn = document.getElementById('createGistBtn');

    if (!selectedGistId) {
        // Check if "New file" was selected
        if (selectedText === 'New file') {
            document.getElementById('gistTitleInput').style.display = 'block';
            document.getElementById('viewGistOnGithub').style.display = 'none';
            document.getElementById('deleteGistBtn').style.display = 'none';
            document.getElementById('createGistBtnText').textContent = 'Create Note';
        } else {
            document.getElementById('gistTitleInput').style.display = 'none';
            document.getElementById('viewGistOnGithub').style.display = 'inline-flex';
            document.getElementById('deleteGistBtn').style.display = 'inline-flex';
            document.getElementById('createGistBtnText').textContent = 'Create Note';
        }
        document.getElementById('gistContentArea').value = '';

        return;
    }

    document.getElementById('gistTitleInput').style.display = 'none';
    document.getElementById('createGistBtnText').textContent = 'Update Note';
    await loadGistContent(selectedGistId);
});

// Delete gist button
document.getElementById('deleteGistBtn').addEventListener('click', async () => {
    const gistSelect = document.getElementById('gistSelect');
    const selectedGistId = gistSelect.value;

    if (!selectedGistId) return;

    const selectedOption = gistSelect.options[gistSelect.selectedIndex];
    const gistName = selectedOption.textContent;

    if (confirm(`Are you sure you want to delete "${gistName}"?`)) {
        await deleteGistById(selectedGistId);
    }
});

// ============================================================================
// Gist Management Functions
// ============================================================================

async function loadAllGistsToDropdown(token) {
    const gists = await fetchGists(token);
    allGists = gists;

    const gistSelect = document.getElementById('gistSelect');
    gistSelect.innerHTML = '<option value="">Select a gist...</option><option value="">New file</option>';

    gists.forEach(gist => {
        const option = document.createElement('option');
        option.value = gist.id;

        // Get first filename or use description
        const firstFilename = Object.keys(gist.files)[0];
        const displayName = gist.description || firstFilename || 'Untitled Gist';

        option.textContent = displayName;
        option.dataset.url = gist.html_url;
        option.dataset.files = JSON.stringify(gist.files);

        gistSelect.appendChild(option);
    });
}

async function loadGistContent(gistId) {
    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const response = await fetch(`https://api.github.com/gists/${gistId}`, {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch gist content');
        }

        const gist = await response.json();
        const files = Object.values(gist.files);

        // Display content of all files
        let content = '';
        if (files.length === 1) {
            content = files[0].content;
        } else {
            // Multiple files - show each with a header
            files.forEach((file, index) => {
                content += `${'='.repeat(50)}\n`;
                content += `File: ${file.filename}\n`;
                content += `${'='.repeat(50)}\n\n`;
                content += file.content;
                if (index < files.length - 1) {
                    content += '\n\n\n';
                }
            });
        }

        document.getElementById('gistContentArea').value = content;
        document.getElementById('viewGistOnGithub').href = gist.html_url;
        document.getElementById('viewGistOnGithub').style.display = 'inline-flex';
        document.getElementById('deleteGistBtn').style.display = 'inline-flex';

    } catch (error) {
        console.error('Error loading gist content:', error);
        showStatus('Failed to load gist content', 'error');
    }
}

async function deleteGistById(gistId) {
    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const response = await fetch(`https://api.github.com/gists/${gistId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (response.status === 204) {
            showStatus('Gist deleted successfully', 'success');

            // Clear the UI
            document.getElementById('gistContentArea').value = '';
            document.getElementById('viewGistOnGithub').style.display = 'none';
            document.getElementById('deleteGistBtn').style.display = 'none';

            // Reload the dropdown
            await loadAllGistsToDropdown(tokenData.access_token);
        } else {
            throw new Error('Failed to delete gist');
        }
    } catch (error) {
        console.error('Error deleting gist:', error);
        showStatus('Failed to delete gist', 'error');
    }
}