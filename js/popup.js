
console.log('Extension ID:', chrome.runtime.id);
console.log('Redirect URI:', chrome.identity.getRedirectURL());


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
    `&scope=repo user gist` +
    `&state=${state}`;
  
  console.log('Auth URL:', authUrl);
  console.log('Client ID:', CONFIG.GITHUB_CLIENT_ID);
  console.log('Redirect URI:', CONFIG.REDIRECT_URI);
  
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      {
        url: authUrl,
        interactive: true
      },
      async (redirectUrl) => {
        console.log('Redirect URL received:', redirectUrl);
        console.log('Chrome runtime error:', chrome.runtime.lastError);
        
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
    console.log('Backend URL:', CONFIG.BACKEND_URL);
    console.log('Code:', code);
    console.log('Redirect URI:', CONFIG.REDIRECT_URI);
    
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
    
    githubButton.innerHTML = `
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
      chrome.storage.local.get(['githubToken', 'selectedRepo', 'repos'], (result) => {
        resolve(result);
      });
    });
  };

  const extensionData = await getExtensionData();
  
  if (!extensionData.githubToken) {
    alert('Please log in to GitHub first!');
    return;
  }

  const popup = document.createElement("div");
  popup.id = "myExtensionPopup";
  popup.innerHTML = `
    <div style="
      position: fixed;
      top: 20%;
      left: 50%;
      transform: translateX(-50%);
      background: white;
      border: 1px solid #ccc;
      border-radius: 12px;
      padding: 1.5%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      z-index: 999999;
      width: 400px;
      min-height: 300px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    ">
      <div id="popupHeader" style="padding: 10px; cursor: move; border-bottom: 1px solid #eee; position: relative;">
        <h6 style="color: black; margin: 0;">GitHub Notes</h6>
        <div style="font-size: 12px; color: #666; margin-top: 5px;">
          Repo: <span id="currentRepo" style="font-weight: bold;">${extensionData.selectedRepo || 'None selected'}</span>
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
        color: #666;
      ">x</button>

      </div>
      <textarea id="notesTextarea" placeholder="Write your notes here..." style="
        width: calc(100% - 20px); 
        height: 200px; 
        border: 1px solid #ddd; 
        outline: none; 
        resize: vertical; 
        background-color: white; 
        color: black;
        padding: 10px;
        border-radius: 4px;
        font-size: 14px;
      "></textarea>
      <div style="display: flex; padding: 10px; justify-content: space-between; align-items: center;">
        <button id="historyBtn" style="
          color: white;
          background: #6c757d;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
        " type="button">History</button>
        <div style="display: flex; gap: 10px;">
          <button id="commitBtn" style="
            color: white;
            background: #28a745;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
          " type="button">Commit Gist</button>
        </div>
      </div>
      <div id="statusMessage" style="
        padding: 10px;
        margin: 0 10px;
        border-radius: 4px;
        font-size: 12px;
        display: none;
      "></div>
    </div>
  `;
  document.body.appendChild(popup);

  const el = popup.querySelector("div");
  const header = popup.querySelector("#popupHeader");
  const commitBtn = popup.querySelector("#commitBtn");
  const historyBtn = popup.querySelector("#historyBtn");
  const textarea = popup.querySelector("#notesTextarea");
  const statusMessage = popup.querySelector("#statusMessage");

  dragElement(el, header);

  //Commit button
  commitBtn.addEventListener('click', async () => {
    const notes = textarea.value.trim();
    
    if (!notes) {
      showStatus('Please write some notes first!', 'error');
      return;
    }

    if (!extensionData.selectedRepo) {
      showStatus('Please select a repository in the extension popup!', 'error');
      return;
    }

    commitBtn.disabled = true;
    commitBtn.textContent = 'Committing...';

    try {


      const tokenData = await decryptTokenInContent(extensionData.githubToken);
      const token = JSON.parse(tokenData).access_token;


      const filename = `${extensionData.selectedRepo.replace('/', '-')}-notes.md`;
      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          description: `Notes for ${extensionData.selectedRepo}`,
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
      showStatus(`Gist created successfully! <a href="${gist.html_url}" target="_blank" style="color: white; text-decoration: underline;">View Gist</a>`, 'success');
      textarea.value = '';
    } catch (error) {
      console.error('Commit error:', error);
      showStatus('Failed to create gist: ' + error.message, 'error');
    } finally {
      commitBtn.disabled = false;
      commitBtn.textContent = '📝 Commit to Gist';
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