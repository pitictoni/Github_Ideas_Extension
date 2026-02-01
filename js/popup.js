//console.log('Extension ID:', chrome.runtime.id);
//console.log('Redirect URI:', chrome.identity.getRedirectURL());


const CONFIG = {
  GITHUB_CLIENT_ID: '',
  BACKEND_URL: '',
  REDIRECT_URI: chrome.identity.getRedirectURL()
};

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64URLEncode(new Uint8Array(hash));
}

function base64URLEncode(buffer) {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}


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
  
  const encrypted = Uint8Array.from(atob(encryptedData.encrypted.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(encryptedData.iv.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted
  );
  
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}


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
  await chrome.storage.local.remove(['githubToken', 'tokenExpiry', 'codeVerifier', 'repos', 'selectedRepo']);
}

//Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  const tokenData = await getStoredToken();
  if (tokenData && tokenData.access_token) {
    updateUIForLoggedInUser(tokenData.access_token);
  }
});

//GitHub Login Handler
document.getElementById('github').addEventListener('click', async () => {
  try {
    const tokenData = await authenticateWithGitHub();
    if (tokenData && tokenData.access_token) {
      await storeToken(tokenData);
      updateUIForLoggedInUser(tokenData.access_token);
      showNotification('Successfully logged in to GitHub!', 'success');
    }
  } catch (error) {
    console.error('GitHub auth error:', error);
    showNotification('Failed to login to GitHub. Please try again.', 'error');
  }
});

//Logout handler
async function logout() {
  await clearStoredToken();
  location.reload();
}


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

//Exchange code for token via backend
async function exchangeCodeForToken(code) {
  try {
    console.log('Exchanging code for token...');
    //console.log('Backend URL:', CONFIG.BACKEND_URL);
    //console.log('Code:', code);
    //console.log('Redirect URI:', CONFIG.REDIRECT_URI);
    
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
    
    console.log('Response status:', response.status);
    
    const data = await response.json();
    console.log('Response data:', data);
    
    if (!response.ok) {
      throw new Error(data.message || data.error || 'Failed to exchange code for token');
    }
    
    return data;
  } catch (error) {
    console.error('Token exchange error:', error);
    throw error;
  }
}


async function fetchGitHubUser(token, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      //Invalid Token
      if (response.status === 401) {
        await clearStoredToken();
        throw new Error('Token expired or invalid');
      }
      

      //Rate limited
      if (response.status === 403) {

        const resetTime = response.headers.get('X-RateLimit-Reset');
        throw new Error(`Rate limited. Resets at ${new Date(resetTime * 1000).toLocaleTimeString()}`);
      }
      
      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

//Fetch repos
async function fetchGitHubRepos(token) {
  try {
    const repos = [];
    let page = 1;
    const perPage = 100;
    
    while (true) {
      const response = await fetch(
        `https://api.github.com/user/repos?sort=updated&per_page=${perPage}&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch repositories');
      }
      
      const pageRepos = await response.json();
      if (pageRepos.length === 0) break;
      
      repos.push(...pageRepos);
      
      if (pageRepos.length < perPage) break;
      page++;
    }
    
    return repos;
  } catch (error) {
    console.error('Error fetching repos:', error);
    throw error;
  }
}

//Update UI for logged-in user
async function updateUIForLoggedInUser(token) {
  try {
    const user = await fetchGitHubUser(token);
    const githubButton = document.getElementById('github');
    
    const originalContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor"
          class="bi bi-github me-2" viewBox="0 0 16 16">
          <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 
          0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
          -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 
          2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 
          0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 
          .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 
          1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 
          1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 
          1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 
          8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      ${user.login}
    `;
    
    const hoverContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor"
          class="bi bi-github me-2" viewBox="0 0 16 16">
          <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 
          0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
          -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 
          2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 
          0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 
          .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 
          1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 
          1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 
          1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 
          8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      Logout from GitHub
    `;
    
    githubButton.innerHTML = originalContent;
    
    githubButton.addEventListener('mouseenter', () => {
      githubButton.innerHTML = hoverContent;
    });
    
    githubButton.addEventListener('mouseleave', () => {
      githubButton.innerHTML = originalContent;
    });
    
    //Logout
    githubButton.addEventListener('click', logout);
    
    const repos = await fetchGitHubRepos(token);
    populateRepoDropdown(repos);
  } catch (error) {
    console.error('Error updating UI:', error);
    if (error.message.includes('Token expired')) {
      showNotification('Session expired. Please log in again.', 'error');
      await clearStoredToken();
      location.reload();
    }
  }
}

function populateRepoDropdown(repos) {
  const select = document.querySelector('.form-select');
  select.innerHTML = '<option value="">Select a repository...</option>' + 
    repos.map(repo => 
      `<option value="${repo.full_name}">${repo.name}</option>`
    ).join('');
  
  chrome.storage.local.set({ repos: repos });

  chrome.storage.local.get("selectedRepo", (result) => {
    if (result.selectedRepo) {
      select.value = result.selectedRepo;
    }
  });
  
  select.addEventListener('change', (e) => {
    const selectedRepo = e.target.value;
    if (selectedRepo) {
      chrome.storage.local.set({ selectedRepo: selectedRepo });
    }
  });
}

function showNotification(message, type = 'info') {
  alert(message);
}

document.getElementById('showPopup')?.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showInjectedPopup
    });
  });
});

async function showInjectedPopup() {
  if (document.getElementById("myExtensionPopup")) {
    return;
  }


  const getExtensionData = () => {
    return new Promise((resolve) => {
      chrome.storage.local.get(['githubToken', 'selectedRepo', 'repos', 'theme'], (result) => {
        resolve(result);
      });
    });
  };

  const extensionData = await getExtensionData();
  
  if (!extensionData.githubToken) {
    alert('Please log in to GitHub first!');
    return;
  }

  if (!extensionData.selectedRepo) {
    alert('Please select a repository first!');
    return;
  }

  // Get theme preference from storage or system
  let currentTheme = extensionData.theme;
  if (!currentTheme) {
    currentTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  const style = document.createElement('style');
  style.id = 'extensionPopupStyle';
  style.textContent = `
    #myExtensionPopup {
      --bg: ${currentTheme === 'dark' ? '#1a1a1a' : '#ffffff'};
      --bg-soft: ${currentTheme === 'dark' ? '#2d2d2d' : '#f8f9fa'};
      --bg-popup: ${currentTheme === 'dark' ? '#1a1a1a' : '#ffffff'};
      --border: ${currentTheme === 'dark' ? '#495057' : '#e0e0e0'};
      --text: ${currentTheme === 'dark' ? '#e9ecef' : '#1f2937'};
      --text-muted: ${currentTheme === 'dark' ? '#adb5bd' : '#6b7280'};
      --accent: #22c55e;
      --accent-soft: ${currentTheme === 'dark' ? '#052e16' : '#dcfce7'};
      --danger: ${currentTheme === 'dark' ? '#f87171' : '#ef4444'};
      --danger-soft: ${currentTheme === 'dark' ? '#450a0a' : '#fee2e2'};
      --info-soft: ${currentTheme === 'dark' ? '#083344' : '#d1ecf1'};
      --input-bg: ${currentTheme === 'dark' ? '#2d2d2d' : '#fafafa'};
      --input-border: ${currentTheme === 'dark' ? '#495057' : '#ddd'};
      --modal-bg: ${currentTheme === 'dark' ? '#1a1a1a' : '#ffffff'};
      --history-item-bg: ${currentTheme === 'dark' ? '#2d2d2d' : '#f8f9fa'};
    }
  `;
  document.head.appendChild(style);


  const popup = document.createElement("div");
  popup.id = "myExtensionPopup";
  popup.innerHTML = `
    <div style="
      position: fixed;
      top: 20%;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-popup);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      z-index: 999999;
      width: 450px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    ">
      <div id="popupHeader" style="
        padding: 10px;
        cursor: move;
        background-color: green;
        color: white;
        border-radius: 12px 12px 0 0;
      ">
        <h6 style="margin: 0; font-size: 16px; font-weight: 600; color: white;">GitHub Notes</h6>
        <div style="font-size: 13px; opacity: 0.9; margin-top: 4px; color: white;">
          ${extensionData.selectedRepo}
        </div>
        <button id="closePopup" style="
        position: absolute;
        top: 10px;
        right: 12px;
        background: transparent;
        border: none;
        font-size: 18px;
        font-weight: bold;
        cursor: pointer;
        color: white;
      ">×</button>

      </div>
      
      <div>
        <div id="loadingIndicator" style="
          text-align: center;
          padding: 20px;
          color: var(--text-muted);
        ">
          Loading existing notes...
        </div>
        
        <div id="mainContent" style="display: none; padding: 12px 12px 0 12px; box-sizing: border-box;">

          <!-- Gist Title Input -->
          <div style="margin-bottom: 10px;">
            <div style="display: flex; justify-content: space-between;">
              <h1 style="
                display: block;
                font-size: 12px;
                font-weight: 600;
                color: var(--text);
                margin-bottom: 4px;
              ">
                Filename
              </h1>
              <a href="https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax"
                target="_blank"
                title="GitHub Basic writing and Formatting Syntax"
                rel="noopener noreferrer">

                <svg xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    fill="currentColor"
                    style="cursor: pointer; color: var(--text);"
                    class="bi bi-github me-2"
                    viewBox="0 0 17 17">

                  <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 
                  0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                  -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 
                  2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 
                  0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 
                  .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 
                  1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 
                  1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 
                  1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 
                  8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                </svg>

              </a>

            </div>
            <div style="position: relative;">
              <select id="gistSelect" style="
                width: 100%;
                padding: 8px 10px;
                border: 1px solid var(--input-border);
                border-radius: 6px;
                font-size: 13px;
                outline: none;
                box-sizing: border-box;
                background-color: var(--input-bg);
                color: var(--text);
                cursor: pointer;
              ">
                <option value="">New file</option>
              </select>
              <input id="gistTitleInput" type="text" placeholder="my-notes.md" style="
                position: relative;
                top: 0;
                left: 0;
                width: 100%;
                padding: 8px 10px;
                border: 1px solid var(--input-border);
                border-radius: 6px;
                font-size: 13px;
                outline: none;
                box-sizing: border-box;
                background-color: var(--input-bg);
                color: var(--text);
                display: none;
              "/>
            </div>
          </div>

          <textarea id="notesTextarea" placeholder="Write your notes here..." style="
            width: 100%; 
            height: 150px; 
            border: 1px solid var(--input-border); 
            outline: none; 
            resize: vertical; 
            background-color: var(--input-bg); 
            color: var(--text);
            padding: 12px;
            font-size: 14px;
            font-family: 'Consolas', 'Monaco', monospace;
            box-sizing: border-box;
            border-radius: 6px;
          "></textarea>
          
          <div id="gistInfo" style="
            font-size: 12px;
            color: var(--text-muted);
            margin-top: 8px;
            background: var(--bg-soft);
            border-radius: 4px;
            padding: 8px;
            display: none;
          ">
            <span id="lastUpdated"></span>
            <a id="viewGistLink" href="#" target="_blank" style="
              color: #667eea;
              text-decoration: none;
              margin-left: 12px;
            ">View on GitHub →</a>
          </div>
        </div>
      </div>
      
      <div style="
        display: flex;
        padding: 12px 16px;
        justify-content: space-between;
        align-items: center;
        border-top: 1px solid var(--border);
        background: var(--bg-soft);
        border-radius: 0 0 12px 12px;
      ">
        <button id="historyBtn" style="
          color: #667eea;
          background: var(--bg-popup);
          border: 1px solid #667eea;
          padding: 10px 18px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.2s;
        " type="button">History</button>
        
        <button id="commitBtn" style="
          color: white;
          background-color: green;
          border: none;
          padding: 10px 24px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
          font-size: 14px;
          box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
          transition: all 0.2s;
        " type="button">Save Changes</button>
      </div>
      
      <div id="statusMessage" style="
        padding: 12px 16px;
        margin: 0;
        font-size: 13px;
        display: none;
        border-radius: 0 0 12px 12px;
      "></div>
    </div>
  `;
  document.body.appendChild(popup);

  // Listen for theme changes
  const updateTheme = (newTheme) => {
    const styleEl = document.getElementById('extensionPopupStyle');
    if (styleEl) {
      styleEl.textContent = `
        #myExtensionPopup {
          --bg: ${newTheme === 'dark' ? '#1a1a1a' : '#ffffff'};
          --bg-soft: ${newTheme === 'dark' ? '#2d2d2d' : '#f8f9fa'};
          --bg-popup: ${newTheme === 'dark' ? '#1a1a1a' : '#ffffff'};
          --border: ${newTheme === 'dark' ? '#495057' : '#e0e0e0'};
          --text: ${newTheme === 'dark' ? '#e9ecef' : '#1f2937'};
          --text-muted: ${newTheme === 'dark' ? '#adb5bd' : '#6b7280'};
          --accent: #22c55e;
          --accent-soft: ${newTheme === 'dark' ? '#052e16' : '#dcfce7'};
          --danger: ${newTheme === 'dark' ? '#f87171' : '#ef4444'};
          --danger-soft: ${newTheme === 'dark' ? '#450a0a' : '#fee2e2'};
          --info-soft: ${newTheme === 'dark' ? '#083344' : '#d1ecf1'};
          --input-bg: ${newTheme === 'dark' ? '#2d2d2d' : '#fafafa'};
          --input-border: ${newTheme === 'dark' ? '#495057' : '#ddd'};
          --modal-bg: ${newTheme === 'dark' ? '#1a1a1a' : '#ffffff'};
          --history-item-bg: ${newTheme === 'dark' ? '#2d2d2d' : '#f8f9fa'};
        }
      `;
    }
  };

  // Listen for storage changes (when theme toggle is clicked)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) {
      updateTheme(changes.theme.newValue);
    }
  });

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    chrome.storage.local.get('theme', (result) => {
      if (!result.theme) {
        updateTheme(e.matches ? 'dark' : 'light');
      }
    });
  });


  const el = popup.querySelector("div");
  const header = popup.querySelector("#popupHeader");
  const commitBtn = popup.querySelector("#commitBtn");
  const historyBtn = popup.querySelector("#historyBtn");
  const textarea = popup.querySelector("#notesTextarea");
  const gistTitleInput = popup.querySelector("#gistTitleInput");
  const gistSelect = popup.querySelector("#gistSelect");
  const statusMessage = popup.querySelector("#statusMessage");
  const gistInfo = popup.querySelector("#gistInfo");
  const lastUpdated = popup.querySelector("#lastUpdated");
  const viewGistLink = popup.querySelector("#viewGistLink");
  const loadingIndicator = popup.querySelector("#loadingIndicator");
  const mainContent = popup.querySelector("#mainContent");

  let existingGist = null;
  let allRepoGists = [];

  dragElement(el, header);

  //Load existing gist on startup
  await loadExistingGist();

  // Handle gist selection from dropdown
  gistSelect.addEventListener('change', async (e) => {
    gistTitleInput.style.display = 'none'
    const selectedGistId = e.target.value;
    
    if (!selectedGistId) {

      //gistSelect.style.display = 'none';
      gistTitleInput.style.display = 'block';
      gistTitleInput.value = '';
      gistTitleInput.focus();
      
      // Clear the form
      textarea.value = '';
      existingGist = null;
      gistInfo.style.display = 'none';
      return;
    }

    try {
      const tokenData = await decryptTokenInContent(extensionData.githubToken);
      const token = JSON.parse(tokenData).access_token;

      // Fetch the selected gist
      const response = await fetch(`https://api.github.com/gists/${selectedGistId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!response.ok) throw new Error('Failed to fetch gist');

      existingGist = await response.json();

      // Load the content
      const fileKey = Object.keys(existingGist.files)[0];
      const file = existingGist.files[fileKey];

      if (!file?.content) {
        throw new Error('Gist content missing');
      }

      textarea.value = file.content;

      // Update metadata
      const updatedDate = new Date(existingGist.updated_at);
      lastUpdated.textContent = `Last updated ${getTimeAgo(updatedDate)}`;
      viewGistLink.href = existingGist.html_url;
      gistInfo.style.display = 'block';

    } catch (error) {
      console.error('Error loading selected gist:', error);
      showStatus('Failed to load note: ' + error.message, 'error');
    }
  });

  async function loadExistingGist() {
    try {
      const tokenData = await decryptTokenInContent(extensionData.githubToken);
      const token = JSON.parse(tokenData).access_token;

      //1. List gists (metadata only)
      const response = await fetch('https://api.github.com/gists', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!response.ok) throw new Error('Failed to list gists');

      const gists = await response.json();

      // Store all gists for this repo
      allRepoGists = gists.filter(g =>
        g.description?.startsWith(`Notes for ${extensionData.selectedRepo}`)
      );

      // Populate dropdown with all gists
      gistSelect.innerHTML = '<option value="">New file</option>';
      allRepoGists.forEach(gist => {
        const fileKey = Object.keys(gist.files)[0];
        const updatedDate = new Date(gist.updated_at);
        const option = document.createElement('option');
        option.value = gist.id;
        option.textContent = `${fileKey} (${getTimeAgo(updatedDate)})`;
        gistSelect.appendChild(option);
      });

      // Find the most recent one to load by default
      const found = allRepoGists.length > 0 ? allRepoGists[0] : null;

      if (!found) {
        // No existing gists, show input for new file
        gistSelect.style.display = 'none';
        gistTitleInput.style.display = 'block';
        return;
      }

      //2. Fetch FULL gist (this contains file.content)
      const fullResponse = await fetch(`https://api.github.com/gists/${found.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!fullResponse.ok) throw new Error('Failed to fetch full gist');

      existingGist = await fullResponse.json();

      //3. Safely read real file
      const fileKey = Object.keys(existingGist.files)[0];
      const file = existingGist.files[fileKey];

      if (!file?.content) {
        throw new Error('Gist content missing after full fetch');
      }

      textarea.value = file.content;

      //4. Show metadata
      const updatedDate = new Date(existingGist.updated_at);
      lastUpdated.textContent = `Last updated ${getTimeAgo(updatedDate)}`;
      viewGistLink.href = existingGist.html_url;
      gistInfo.style.display = 'block';

      //5. Set dropdown to current gist and show dropdown
      gistSelect.value = existingGist.id;
      gistSelect.style.display = 'block';
      gistTitleInput.style.display = 'none';

    } catch (error) {
      console.error('Error loading existing gist:', error);
    } finally {
      loadingIndicator.style.display = 'none';
      mainContent.style.display = 'block';
    }
  }


  function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
    return date.toLocaleDateString();
  }

  async function refreshGistDropdown(token) {
    try {
      const response = await fetch('https://api.github.com/gists', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!response.ok) return;

      const gists = await response.json();
      allRepoGists = gists.filter(g =>
        g.description?.startsWith(`Notes for ${extensionData.selectedRepo}`)
      );

      // Repopulate dropdown
      gistSelect.innerHTML = '<option value="">New file</option>';
      allRepoGists.forEach(gist => {
        const fileKey = Object.keys(gist.files)[0];
        const updatedDate = new Date(gist.updated_at);
        const option = document.createElement('option');
        option.value = gist.id;
        option.textContent = `${fileKey} (${getTimeAgo(updatedDate)})`;
        gistSelect.appendChild(option);
      });

      // Show dropdown if we have gists
      if (allRepoGists.length > 0) {
        gistSelect.style.display = 'block';
        gistTitleInput.style.display = 'none';
      }
    } catch (error) {
      console.error('Error refreshing dropdown:', error);
    }
  }


  commitBtn.addEventListener('click', async () => {
    const notes = textarea.value.trim();
    
    // Get filename from text input if visible, otherwise we're updating existing gist
    let customTitle = '';
    if (gistTitleInput.style.display !== 'none') {
      customTitle = gistTitleInput.value.trim();
    } else if (existingGist) {
      customTitle = Object.keys(existingGist.files)[0];
    }
    
    if (!notes) {
      showStatus('Please write some notes first!', 'error');
      return;
    }

    if (!customTitle) {
      showStatus('Please provide a file name for your note!', 'error');
      return;
    }

    commitBtn.disabled = true;
    commitBtn.innerHTML = 'Saving...';

    try {
      const tokenData = await decryptTokenInContent(extensionData.githubToken);
      const token = JSON.parse(tokenData).access_token;
      
      let filename = customTitle;
      const createNew = !existingGist;
      
      // If creating new, check for conflicts and add timestamp if needed
      if (createNew) {
        const filenameExists = allRepoGists.some(gist =>
          Object.keys(gist.files).includes(filename)
        );

        if (filenameExists) {
          const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

          const lastDotIndex = filename.lastIndexOf('.');
          if (lastDotIndex > 0) {
            const nameWithoutExt = filename.substring(0, lastDotIndex);
            const extension = filename.substring(lastDotIndex);
            filename = `${nameWithoutExt}-${timestamp}${extension}`;
          } else {
            filename = `${filename}-${timestamp}`;
          }

          showStatus('Filename already exists, adding timestamp...', 'info');
        }
      }
      
      // Extract a clean description from filename (without extension)
      const descriptionName = filename.replace(/\.[^/.]+$/, '');

      if (existingGist) {

        const fileKey = Object.keys(existingGist.files)[0];
        const response = await fetch(`https://api.github.com/gists/${existingGist.id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            description: `Notes for ${extensionData.selectedRepo} - ${descriptionName}`,
            files: {
              [fileKey]: {
                filename: filename,
                content: notes
              }
            }
          })

        });

        if (!response.ok) throw new Error('Failed to update gist');

        const gist = await response.json();
        existingGist = gist;
        
        const updatedDate = new Date(gist.updated_at);
        lastUpdated.textContent = `Last updated ${getTimeAgo(updatedDate)}`;
        viewGistLink.href = gist.html_url;
        gistInfo.style.display = 'block';
        
        // Refresh the dropdown to show updated filename/timestamp
        await refreshGistDropdown(token);
        gistSelect.value = gist.id;
        
        showStatus('Notes updated successfully!', 'success');
      } else {

        const response = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            description: `Notes for ${extensionData.selectedRepo} - ${descriptionName}`,
            public: false,
            files: {
              [filename]: {
                content: notes
              }
            }
          })
        });

      if (!response.ok) {
        throw new Error('Failed to create gist');
      }

        const gist = await response.json();
        
          existingGist = gist;
          const updatedDate = new Date(gist.updated_at);
          lastUpdated.textContent = `Last updated ${getTimeAgo(updatedDate)}`;
          viewGistLink.href = gist.html_url;
          gistInfo.style.display = 'block';
          
          // Refresh the dropdown
          await refreshGistDropdown(token);
        
        showStatus(`New note created! <a href="${gist.html_url}" target="_blank" style="color: white; text-decoration: underline;">View Gist →</a>`, 'success');
        
      }
    } catch (error) {
      console.error('Commit error:', error);
      showStatus('Failed to save: ' + error.message, 'error');
    } finally {
      commitBtn.disabled = false;
      commitBtn.innerHTML = 'Save Changes';
    }
  });


  historyBtn.addEventListener('click', async () => {
    historyBtn.disabled = true;
    historyBtn.textContent = 'Loading...';
    
    try {
      const tokenData = await decryptTokenInContent(extensionData.githubToken);
      const token = JSON.parse(tokenData).access_token;

      const response = await fetch('https://api.github.com/gists', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!response.ok) throw new Error('Failed to fetch gists');

      const allGists = await response.json();
      const repoGists = allGists.filter(g =>
        g.description?.startsWith(`Notes for ${extensionData.selectedRepo}`)
      );



      if (repoGists.length === 0) {
        showStatus('No notes found for this repository', 'info');
      } else {
        // Get current theme for modal
        const modalTheme = await new Promise((resolve) => {
          chrome.storage.local.get('theme', (result) => {
            const theme = result.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
            resolve(theme);
          });
        });

        const modalBg = modalTheme === 'dark' ? '#1a1a1a' : '#ffffff';
        const modalText = modalTheme === 'dark' ? '#e9ecef' : '#333';
        const modalTextMuted = modalTheme === 'dark' ? '#adb5bd' : '#666';
        const modalItemBg = modalTheme === 'dark' ? '#2d2d2d' : '#f8f9fa';

        let historyHTML = `<div style="max-height: 300px; overflow-y: auto; padding: 10px;">`;
        historyHTML += `<h4 style="margin: 0 0 12px 0; color: ${modalText};">Notes History (${repoGists.length})</h4>`;
        
        repoGists.forEach(gist => {
          const date = new Date(gist.updated_at);
          historyHTML += `
            <div style="
              padding: 10px;
              margin-bottom: 8px;
              background: ${modalItemBg};
              border-radius: 6px;
              border-left: 3px solid #667eea;
            ">
              <div style="font-size: 12px; color: ${modalTextMuted}; margin-bottom: 4px;">
                ${date.toLocaleString()}
              </div>
              <a href="${gist.html_url}" target="_blank" style="
                color: #667eea;
                text-decoration: none;
                font-size: 13px;
              ">View on GitHub →</a>
            </div>
          `;
        });
        
        historyHTML += `</div>`;
        
        //History modal
        const modal = document.createElement('div');
        modal.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.5);
          z-index: 9999999;
          display: flex;
          align-items: center;
          justify-content: center;
        `;
        
        modal.innerHTML = `
          <div style="
            background: ${modalBg};
            border-radius: 12px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow: hidden;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
          ">
            <div style="
              padding: 16px;
              background-color: green;
              color: white;
              display: flex;
              justify-content: space-between;
              align-items: center;
            ">
              <h3 style="margin: 0; color: white;">Notes History</h3>
              <button id="closeModal" style="
                background: transparent;
                border: none;
                color: white;
                font-size: 24px;
                cursor: pointer;
                padding: 0;
                width: 30px;
                height: 30px;
              ">×</button>
            </div>
            ${historyHTML}
          </div>
        `;
        
        document.body.appendChild(modal);
        
        modal.querySelector('#closeModal').addEventListener('click', () => {
          modal.remove();
        });
        
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            modal.remove();
          }
        });
      }
    } catch (error) {
      console.error('History error:', error);
      showStatus('Failed to load history: ' + error.message, 'error');
    } finally {
      historyBtn.disabled = false;
      historyBtn.textContent = 'History';
    }
  });

  function showStatus(message, type) {
    statusMessage.innerHTML = message;
    statusMessage.style.display = 'block';
    
    if (type === 'success') {
      statusMessage.style.background = '#d4edda';
      statusMessage.style.color = '#155724';
      statusMessage.style.border = '1px solid #c3e6cb';
    } else if (type === 'error') {
      statusMessage.style.background = '#f8d7da';
      statusMessage.style.color = '#721c24';
      statusMessage.style.border = '1px solid #f5c6cb';
    } else {
      statusMessage.style.background = '#d1ecf1';
      statusMessage.style.color = '#0c5460';
      statusMessage.style.border = '1px solid #bee5eb';
    }

    setTimeout(() => {
      statusMessage.style.display = 'none';
    }, 5000);
  }


  async function decryptTokenInContent(encryptedData) {
    const encoder = new TextEncoder();
    const extensionId = chrome.runtime.id;
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(extensionId.padEnd(32, '0')),
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
    
    const encrypted = Uint8Array.from(atob(encryptedData.encrypted.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(encryptedData.iv.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  }

  function dragElement(elmnt, dragHandle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    dragHandle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
      elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  document.getElementById("closePopup").addEventListener("click", () => {
    document.getElementById("myExtensionPopup")?.remove();
  });

}