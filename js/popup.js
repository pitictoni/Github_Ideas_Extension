const CONFIG = {
    GITHUB_CLIENT_ID: 'Ov23liqJaw3AaJpiq0A6',
    BACKEND_URL: 'https://github-oauth-worker.iopy.workers.dev',
    REDIRECT_URI: chrome.identity.getRedirectURL()
};

// ============================================================================
// Anonymous Participant ID
// ============================================================================

async function getParticipantId() {
    const result = await chrome.storage.local.get(['participantId']);
    if (result.participantId) return result.participantId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ participantId: id });
    return id;
}

// ============================================================================
// Auto-start benchmark for a task (no manual arming needed)
// ============================================================================

// ============================================================================
// showPopover — unified positioning engine for tooltips, menus & dropdowns
// ============================================================================
(function () {
    const CONTAINER_SEL = '.container';
    const GAP = 4;       // px between anchor and popover
    const EDGE = 8;      // min distance from container edges

    // ── shared: compute and apply top/left on a fixed-positioned element ─────
    function applyPosition(el, anchorRect, { alignRight = false } = {}) {
        const containerRect = document.querySelector(CONTAINER_SEL).getBoundingClientRect();
        const elRect        = el.getBoundingClientRect();

        // Vertical — prefer below, flip above, last-resort scroll
        let top = anchorRect.bottom + GAP;
        if (top + elRect.height > containerRect.bottom) {
            top = anchorRect.top - elRect.height - GAP;
        }
        if (top < containerRect.top) {
            top = containerRect.top + EDGE;
            el.style.maxHeight = `${containerRect.height - EDGE * 2}px`;
            el.style.overflowY = 'auto';
        }

        // Horizontal — right- or left-align to anchor, then clamp
        let left = alignRight
            ? anchorRect.right  - elRect.width   // right-align  (action menus)
            : anchorRect.left;                   // left-align   (status dropdown, tooltips)

        left = Math.min(left, containerRect.right  - elRect.width - EDGE);
        left = Math.max(left, containerRect.left   + EDGE);

        el.style.top  = `${top}px`;
        el.style.left = `${left}px`;
    }

    // ── 1. TOOLTIP ────────────────────────────────────────────────────────────
    const portal = document.createElement('div');
    portal.id = 'popover-portal';
    portal.classList.add('tooltip');
    document.body.appendChild(portal);

    let hideTimer   = null;
    const HARDCODED = { avatarWrapper: 'Logout' };

    function getTooltipLabel(el) {
        return el.dataset.tooltip || el.dataset._title || HARDCODED[el.id] || null;
    }

    document.addEventListener('mouseover', e => {
        const anchor = e.target.closest('[data-tooltip], [title], #avatarWrapper');
        if (!anchor) return;

        // Suppress native browser bubble
        if (anchor.title) {
            anchor.dataset._title = anchor.title;
            anchor.removeAttribute('title');
        }

        const label = getTooltipLabel(anchor);
        if (!label) return;

        clearTimeout(hideTimer);
        portal.textContent = label;
        portal.style.position = 'fixed';
        portal.style.maxHeight = '';
        portal.style.overflowY = '';
        

        // Measure after paint so we get real dimensions
        requestAnimationFrame(() => {
            applyPosition(portal, anchor.getBoundingClientRect(), { alignRight: false });
            portal.classList.add('visible');
        });
    });

    document.addEventListener('mouseout', e => {
        const anchor = e.target.closest('[data-tooltip], [data-_title], #avatarWrapper');
        if (!anchor) return;

        if (anchor.dataset._title) {
            anchor.title = anchor.dataset._title;
            delete anchor.dataset._title;
        }

        hideTimer = setTimeout(() => portal.classList.remove('visible'), 80);
    });

    // ── 2. PANEL (menus & dropdowns) ─────────────────────────────────────────
    // Exposed globally so callers can use it
    window.showPopover = function ({ anchor, element, alignRight = false, onClose } = {}) {
        element.style.position = 'fixed';
        element.style.zIndex   = '10000';
        element.style.maxHeight = '';
        element.style.overflowY = '';

        document.body.appendChild(element);

        // Wait one frame for the browser to render & size the element
        requestAnimationFrame(() => {
            applyPosition(element, anchor.getBoundingClientRect(), { alignRight });
        });

        // Dismiss on outside click
        if (onClose) {
            setTimeout(() => {
                function handler(e) {
                    if (!element.contains(e.target)) {
                        onClose();
                        document.removeEventListener('click', handler);
                    }
                }
                document.addEventListener('click', handler);
            }, 0);
        }
    };
})();



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

// Source mode
let currentRepoFullName = null;
let currentRepoIssueState = 'open';


// ============================================================================
// Benchmark Tracking
// ============================================================================

const BENCHMARK_STORAGE_KEY = 'benchmarkLogs';
const BENCHMARK_MAX_LOGS = 200;

const benchmarkTracker = {
    armedTask: null,
    activeRun: null,

    createId(task)
    {
        return `${task}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    },

    async getLogs()
    {
        const result = await chrome.storage.local.get([BENCHMARK_STORAGE_KEY]);
        return Array.isArray(result[BENCHMARK_STORAGE_KEY]) ? result[BENCHMARK_STORAGE_KEY] : [];
    },

    async saveLogs(logs)
    {
        await chrome.storage.local.set({ [BENCHMARK_STORAGE_KEY]: logs.slice(-BENCHMARK_MAX_LOGS) });
    },

    async appendLog(log)
    {
        const participantId = await getParticipantId();
        const enrichedLog = { ...log, participantId };

        // Save locally
        const logs = await this.getLogs();
        logs.push(enrichedLog);
        await this.saveLogs(logs);

        // Send to Cloudflare D1 — strip metadata, fire and forget
        const { metadata, ...safeLog } = enrichedLog;
        fetch(`${CONFIG.BACKEND_URL}/api/benchmark`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(safeLog)
        }).catch(err => console.warn('[Benchmark] Remote sync failed:', err.message));
    },

    arm(task)
    {
        this.armedTask = { task, armedAt: Date.now() };
        this.activeRun = null;
        updateBenchmarkStateUI();
    },

    async cancel(reason)
    {
        if (this.activeRun)
        {
            this.activeRun.completedAt = Date.now();
            this.activeRun.durationMs = this.activeRun.completedAt - this.activeRun.startedAt;
            this.activeRun.cancelled = true;
            this.activeRun.cancelReason = reason;
            await this.appendLog(this.activeRun);
            this.activeRun = null;
        }
        this.armedTask = null;
        updateBenchmarkStateUI();
        await refreshBenchmarkLogsIfVisible();
    },

    async clear()
    {
        this.activeRun = null;
        this.armedTask = null;
        await chrome.storage.local.remove([BENCHMARK_STORAGE_KEY]);
        updateBenchmarkStateUI();
        await refreshBenchmarkLogsIfVisible();
    },

    ensureTask(task)
    {
        return this.activeRun?.task === task || this.armedTask?.task === task;
    },

    startFromInteraction(interaction)
    {
        if (!this.armedTask || this.activeRun)
        {
            return;
        }

        this.activeRun = {
            id: this.createId(this.armedTask.task),
            task: this.armedTask.task,
            platform: 'extension',
            armedAt: this.armedTask.armedAt,
            startedAt: interaction?.ts || Date.now(),
            completedAt: null,
            durationMs: null,
            success: false,
            cancelled: false,
            cancelReason: null,
            clickCount: 0,
            rawClickCount: 0,
            inputFields: [],
            steps: [],
            metadata: {}
        };

        this.armedTask = null;

        if (interaction)
        {
            this.recordInteraction(interaction);
        }

        updateBenchmarkStateUI();
    },

    recordInteraction(interaction)
    {
        if (!this.activeRun)
        {
            return;
        }

        const entry = {
            ts: interaction?.ts || Date.now(),
            type: interaction?.type || 'interaction',
            target: interaction?.target || null,
            synthetic: !!interaction?.synthetic
        };

        this.activeRun.steps.push(entry);

        if (entry.type === 'click')
        {
            this.activeRun.rawClickCount++;
            this.activeRun.clickCount++;
        }
        else if (entry.type === 'select_change')
        {
            this.activeRun.clickCount++;
        }
    },

    noteInput(field)
    {
        if (!this.activeRun)
        {
            return;
        }

        if (!this.activeRun.inputFields.includes(field))
        {
            this.activeRun.inputFields.push(field);
            this.activeRun.steps.push({ ts: Date.now(), type: 'input_started', field });
        }
    },

    async complete()
    {
        if (!this.activeRun)
        {
            return;
        }

        this.activeRun.completedAt = Date.now();
        this.activeRun.durationMs = this.activeRun.completedAt - this.activeRun.startedAt;
        this.activeRun.success = true;
        await this.appendLog(this.activeRun);
        this.activeRun = null;
        updateBenchmarkStateUI();
        await refreshBenchmarkLogsIfVisible();
    }
};

// ============================================================================
// Auto-start benchmark (no manual arming needed)
// ============================================================================

function autoStartBenchmark(task) {
    // Don't overwrite a run already in progress
    if (benchmarkTracker.activeRun) return;

    // Start the run and count the opening button click immediately
    benchmarkTracker.activeRun = {
        id: benchmarkTracker.createId(task),
        task,
        platform: 'extension',
        armedAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
        success: false,
        cancelled: false,
        cancelReason: null,
        clickCount: 1,      // count the button click that triggered this
        rawClickCount: 1,
        inputFields: [],
        steps: [{
            ts: Date.now(),
            type: 'click',
            target: `auto_start:${task}`,
            synthetic: false
        }]
    };

    benchmarkTracker.armedTask = null;
}

function getBenchmarkTaskLabel(task)
{
    const labels = {
        create_project_issue: 'Create project issue',
        create_project_draft: 'Create project draft',
        create_repo_issue: 'Create repository issue',
        convert_draft_to_issue: 'Convert draft to issue',
        move_item_to_project: 'Move item to project',
        remove_issue_from_project: 'Remove issue from project',
        delete_repo_issue: 'Delete repository issue',
        create_project: 'Create project',
        rename_project: 'Rename project',
        edit_project_settings: 'Edit project settings',
        create_gist: 'Create gist',
        edit_gist: 'Edit gist',
        add_gist_file: 'Add gist file',
        rename_gist: 'Rename gist',
        delete_gist: 'Delete gist',
        rename_gist_file: 'Rename gist file',
        delete_gist_file: 'Delete gist file'
    };

    return labels[task] || task;
}

function getCurrentBenchmarkTask()
{
    return benchmarkTracker.activeRun?.task || benchmarkTracker.armedTask?.task || null;
}

async function completeBenchmarkTask(task)
{
    if (benchmarkTracker.ensureTask(task))
    {
        await benchmarkTracker.complete();
    }
}

async function cancelBenchmarkTask(task, reason)
{
    if (benchmarkTracker.ensureTask(task))
    {
        await benchmarkTracker.cancel(reason);
    }
}

function updateBenchmarkStateUI()
{
    // No-op — benchmark UI is hidden from users; tracking is automatic
}

function formatDurationMs(durationMs)
{
    if (typeof durationMs !== 'number')
    {
        return '—';
    }

    return `${(durationMs / 1000).toFixed(2)} s`;
}

async function renderBenchmarkLogs()
{
    const summary = document.getElementById('benchmarkLogsSummary');
    const list = document.getElementById('benchmarkLogsList');

    if (!summary || !list)
    {
        return;
    }

    const logs = await benchmarkTracker.getLogs();
    const completed = logs.filter(log => log.success);
    const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

    summary.innerHTML = `
        <div class="benchmark-summary-card">
            <div class="benchmark-summary-label">Runs</div>
            <div class="benchmark-summary-value">${logs.length}</div>
        </div>
        <div class="benchmark-summary-card">
            <div class="benchmark-summary-label">Completed</div>
            <div class="benchmark-summary-value">${completed.length}</div>
        </div>
        <div class="benchmark-summary-card">
            <div class="benchmark-summary-label">Avg measured clicks</div>
            <div class="benchmark-summary-value">${avg(completed.map(log => log.clickCount)).toFixed(1)}</div>
        </div>
        <div class="benchmark-summary-card">
            <div class="benchmark-summary-label">Avg time</div>
            <div class="benchmark-summary-value">${formatDurationMs(avg(completed.map(log => log.durationMs)))}</div>
        </div>
    `;

    if (!logs.length)
    {
        list.innerHTML = '<div class="benchmark-log-empty">No benchmark runs recorded yet.</div>';
        return;
    }

    list.innerHTML = logs.slice().reverse().map(log => `
        <div class="benchmark-log-item">
            <div class="benchmark-log-top">
                <strong>${getBenchmarkTaskLabel(log.task)}</strong>
                <span class="benchmark-log-status ${log.success ? 'success' : 'cancelled'}">${log.success ? 'Completed' : 'Cancelled'}</span>
            </div>
            <div class="benchmark-log-meta">Measured clicks: ${log.clickCount} · Raw clicks: ${log.rawClickCount ?? log.clickCount} · Time: ${formatDurationMs(log.durationMs)}</div>
            <div class="benchmark-log-meta">Inputs: ${(log.inputFields && log.inputFields.length) ? log.inputFields.join(', ') : 'none'}</div>
            ${log.cancelReason ? `<div class="benchmark-log-meta">Cancel reason: ${log.cancelReason}</div>` : ''}
        </div>
    `).join('');
}

async function refreshBenchmarkLogsIfVisible()
{
    const modal = document.getElementById('benchmarkLogsModal');

    if (modal && modal.style.display === 'flex')
    {
        await renderBenchmarkLogs();
    }
}

window.debugBenchmarkLogs = async function ()
{
    const logs = await benchmarkTracker.getLogs();
    console.log(logs);
    return logs;
};



function isBenchmarkControlElement(element)
{
    if (!element)
    {
        return false;
    }

    return !!element.closest(
        '#openBenchmarkModalBtn, #openBenchmarkLogsBtn, #benchmarkStateBadge, #startBenchmarkModal, #benchmarkLogsModal'
    );
}

function describeBenchmarkTarget(element)
{
    if (!element)
    {
        return { target: 'unknown', label: null };
    }

    const id = element.id ? `#${element.id}` : null;
    const cls = element.className && typeof element.className === 'string'
        ? '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.')
        : null;
    const label = (element.getAttribute('aria-label') || element.getAttribute('data-tooltip') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || null;

    return {
        target: id || cls || element.tagName.toLowerCase(),
        label
    };
}

function attachBenchmarkUIHandlers()
{
    // Benchmark tracking is fully automatic — no UI interaction needed from users

    document.addEventListener('click', event =>
    {
        // Skip if no active run
        if (!benchmarkTracker.activeRun) return;

        // Skip benchmark control elements
        if (isBenchmarkControlElement(event.target)) return;

        // Skip clicks on the document/body itself (unfocused clicks)
        if (event.target === document || event.target === document.body) return;

        const info = describeBenchmarkTarget(event.target);
        const interaction = {
            ts: Date.now(),
            type: 'click',
            target: info.target,
            synthetic: false
        };

        benchmarkTracker.recordInteraction(interaction);
    }, true);

    document.addEventListener('click', event =>
    {
        const select = event.target.closest('select');

        if (!select || isBenchmarkControlElement(select))
        {
            return;
        }

        const info = describeBenchmarkTarget(select);
        const interaction = {
            ts: Date.now(),
            type: 'click',
            target: info.target,
            synthetic: true
        };

        benchmarkTracker.recordInteraction(interaction);
    }, true);

    document.addEventListener('change', event =>
    {
        const select = event.target.closest('select');

        if (!select || isBenchmarkControlElement(select))
        {
            return;
        }

        const interaction = {
            ts: Date.now(),
            type: 'select_change',
            target: select.id ? `#${select.id}` : 'select',
            synthetic: true
        };

        benchmarkTracker.recordInteraction(interaction);
    }, true);

    document.addEventListener('input', event =>
    {
        const field = event.target.closest('input, textarea');

        if (!field || isBenchmarkControlElement(field))
        {
            return;
        }

        const fieldName = field.id || field.name || field.placeholder || field.tagName.toLowerCase();
        benchmarkTracker.noteInput(fieldName);
    }, true);
}

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
        'userData',
        'quickCaptureEnabled',
        'quickCaptureInboxProject',
        'theme',
        'tokenExpiry'
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

// Step 1: Lightweight query — only fetches project list + fields (no items)
async function fetchProjects(token) {
    const query = `
        query GetProjectList {
            viewer {
                login
                name
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
                            ... on User { login name }
                            ... on Organization { login name }
                        }
                        repositories(first: 5) {
                            nodes {
                                name
                                nameWithOwner
                                owner { login }
                            }
                        }
                        fields(first: 20) {
                            nodes {
                                ... on ProjectV2Field {
                                    id name dataType
                                }
                                ... on ProjectV2SingleSelectField {
                                    id name dataType
                                    options { id name color description }
                                }
                                ... on ProjectV2IterationField {
                                    id name dataType
                                    configuration {
                                        iterations { id title startDate duration }
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
        body: JSON.stringify({ query })
    });

    if (!response.ok) {
        throw new Error('Failed to fetch projects');
    }

    return await response.json();
}

// Step 2: On-demand query — fetches items only for the selected project
// Cache to avoid re-fetching when switching between projects
const projectItemsCache = {};

async function fetchProjectItems(token, projectId) {
    // Return cached items if available
    if (projectItemsCache[projectId]) {
        return projectItemsCache[projectId];
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
                                id
                                type
                                fieldValues(first: 20) {
                                    nodes {
                                        ... on ProjectV2ItemFieldTextValue {
                                            text
                                            field { ... on ProjectV2FieldCommon { name } }
                                        }
                                        ... on ProjectV2ItemFieldNumberValue {
                                            number
                                            field { ... on ProjectV2FieldCommon { name } }
                                        }
                                        ... on ProjectV2ItemFieldDateValue {
                                            date
                                            field { ... on ProjectV2FieldCommon { name } }
                                        }
                                        ... on ProjectV2ItemFieldSingleSelectValue {
                                            name color optionId
                                            field { ... on ProjectV2FieldCommon { name } }
                                        }
                                        ... on ProjectV2ItemFieldIterationValue {
                                            title startDate duration
                                            field { ... on ProjectV2FieldCommon { name } }
                                        }
                                    }
                                }
                                content {
                                    ... on Issue {
                                        id title number state url
                                        createdAt updatedAt closedAt
                                        repository { name nameWithOwner owner { login } }
                                        author { login }
                                        labels(first: 10) { nodes { name color } }
                                        assignees(first: 10) { nodes { login name } }
                                        milestone { title dueOn }
                                    }
                                    ... on PullRequest {
                                        id title number state url
                                        createdAt updatedAt closedAt mergedAt
                                        repository { name nameWithOwner owner { login } }
                                        author { login }
                                    }
                                    ... on DraftIssue {
                                        id title createdAt
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

    // Cache the result
    projectItemsCache[projectId] = allItems;
    return allItems;
}

// Call this after any mutation that changes project items (add/remove/convert)
function invalidateProjectCache(projectId) {
    delete projectItemsCache[projectId];
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
        const visibilityLabel = gist.public ? '[Public]' : '[Secret]';

        option.textContent = `${visibilityLabel} ${displayName}`;
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
    const benchmarkTask = currentGist ? 'edit_gist' : 'create_gist';
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

        await completeBenchmarkTask(benchmarkTask);

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

        await completeBenchmarkTask('add_gist_file');

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

                await completeBenchmarkTask('delete_gist');

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

        await completeBenchmarkTask('rename_gist');

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

                await completeBenchmarkTask('delete_gist_file');

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

        await completeBenchmarkTask('rename_gist_file');

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

        if (allProjects.length === 0) {
            showStatus('No projects found', 'info');
            return;
        }

        const unifiedSelect = document.getElementById('unifiedSelect');
        const existingRepoGroup = unifiedSelect.querySelector('optgroup[data-type="repo"]');
        unifiedSelect.innerHTML = '<option value="" disabled selected>Select a project or repository...</option>';

        const projectGroup = document.createElement('optgroup');
        projectGroup.label = 'Projects';
        projectGroup.dataset.type = 'project';

        allProjects.data.viewer.projectsV2.nodes.forEach(project => {
            projectFieldDefinitions[project.id] = extractFieldDefinitions(project);
            const option = document.createElement('option');
            option.value = 'project:' + project.id;
            option.textContent = project.title;
            option.dataset.url = project.url;
            projectGroup.appendChild(option);
        });
        unifiedSelect.appendChild(projectGroup);

        if (existingRepoGroup) unifiedSelect.appendChild(existingRepoGroup);
        else await populateRepoOptgroup(unifiedSelect);

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
        document.getElementById('repoIssuesSection').style.display = 'none';
        document.getElementById('projectTitle').textContent = project.title;

        // Show linked repo badge if available
        const repoSubtitle = document.getElementById('projectRepoSubtitle');
        const linkedRepos = project.repositories?.nodes?.filter(r => r.nameWithOwner) || [];
        if (linkedRepos.length > 0) {
            repoSubtitle.textContent = linkedRepos.map(r => r.nameWithOwner).join(', ');
            repoSubtitle.style.display = 'inline-flex';
        } else {
            repoSubtitle.textContent = '';
            repoSubtitle.style.display = 'none';
        }

        const viewBtn = document.getElementById('viewProjectBtn');
        viewBtn.onclick = () => window.open(project.url, '_blank');

        // Fetch items on-demand (cached after first load)
        const items = await fetchProjectItems(tokenData.access_token, projectId);
        const allCards = [];

        items.forEach(item => {
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
    const tableBody = document.getElementById('projectIssuesTableBody');
    const emptyState = document.getElementById('emptyProjectIssuesState');
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
                " data-item-id="${issue.itemId}" data-current-status="${issue.status}">
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
                    ${issue.repository ? `<div style="font-size: 10px; color: var(--text-secondary); margin-top: 4px;">${issue.repository}</div>` : ''}
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

        tableBody.querySelectorAll('.issue-actions-btn').forEach(btn => {
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
    document.getElementById('repoIssuesSection').style.display = 'none';
    currentProject = null;
}

async function loadRepoIssues(repoFullName, state) {
    if (!repoFullName) return;
    currentRepoFullName = repoFullName;
    if (state) currentRepoIssueState = state;

    const tokenData = await getStoredToken();
    if (!tokenData?.access_token) return;

    document.getElementById('projectIssuesSection').style.display = 'none';
    document.getElementById('projectRepoSubtitle').style.display = 'none';
    const issuesSection = document.getElementById('repoIssuesSection');
    const tableBody = document.getElementById('repoIssuesTableBody');
    const emptyState = document.getElementById('emptyRepoIssuesState');

    document.getElementById('repoTitle').textContent = repoFullName;
    document.getElementById('viewRepoBtn').onclick = () => window.open(`https://github.com/${repoFullName}`, '_blank');

    // Sync active tab
    document.querySelectorAll('.repo-state-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.state === currentRepoIssueState);
    });

    issuesSection.style.display = 'block';
    tableBody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text-secondary);font-size:13px;">Loading...</td></tr>';
    tableBody.parentElement.style.display = 'table';
    emptyState.style.display = 'none';

    try {
        const [owner, repo] = repoFullName.split('/');
        const response = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/issues?state=${currentRepoIssueState}&per_page=100&sort=updated`,
            { headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github.v3+json' } }
        );
        if (!response.ok) throw new Error('Failed to fetch issues');
        const allIssues = (await response.json()).filter(i => !i.pull_request);

        tableBody.innerHTML = '';

        if (allIssues.length === 0) {
            tableBody.parentElement.style.display = 'none';
            emptyState.style.display = 'block';
            emptyState.querySelector('p').textContent = `No ${currentRepoIssueState === 'all' ? '' : currentRepoIssueState + ' '}issues in this repository`;
            return;
        }

        allIssues.forEach(issue => {
            const isOpen = issue.state === 'open';
            const dotColor = isOpen ? '#22c55e' : '#a855f7';
            const stateBadge = `<span class="repo-state-badge" style="background:${dotColor}15;color:${dotColor};border:1px solid ${dotColor}30;"><span class="state-dot" style="background:${dotColor};"></span>${issue.state}</span>`;

            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <a href="${issue.html_url}" target="_blank" class="issue-title" style="text-decoration:none;color:var(--text-primary);">
                        ${issue.title} #${issue.number}
                    </a>
                    ${issue.assignees?.length ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:3px;">${issue.assignees.map(a => '@' + a.login).join(', ')}</div>` : ''}
                </td>
                <td>${stateBadge}</td>
                <td class="issue-actions-cell">
                    <button class="issue-actions-btn repo-issue-actions-btn"
                        data-issue-url="${issue.html_url}"
                        data-issue-title="${issue.title.replace(/"/g, '&quot;')}"
                        data-issue-number="${issue.number}"
                        data-issue-state="${issue.state}"
                        data-issue-owner="${owner}"
                        data-issue-repo="${repo}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                        </svg>
                    </button>
                </td>`;
            tableBody.appendChild(row);
        });

        tableBody.querySelectorAll('.repo-issue-actions-btn').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); showRepoIssueActionsMenu(e.currentTarget); });
        });

    } catch (err) {
        console.error('Error loading repo issues:', err);
        showStatus('Failed to load issues: ' + err.message, 'error');
        tableBody.innerHTML = '';
        tableBody.parentElement.style.display = 'none';
        emptyState.style.display = 'block';
    }
}

function showRepoIssueActionsMenu(button) {
    document.querySelectorAll('.issue-actions-menu').forEach(m => m.remove());

    const url = button.getAttribute('data-issue-url');
    const number = button.getAttribute('data-issue-number');
    const state = button.getAttribute('data-issue-state');
    const owner = button.getAttribute('data-issue-owner');
    const repo = button.getAttribute('data-issue-repo');
    const newState = state === 'open' ? 'closed' : 'open';

    const menu = document.createElement('div');
    menu.className = 'issue-actions-menu show';

    const openItem = document.createElement('a');
    openItem.href = url;
    openItem.target = '_blank';
    openItem.className = 'issue-actions-menu-item';
    openItem.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg> Open on GitHub`;
    menu.appendChild(openItem);

    const toggleItem = document.createElement('div');
    toggleItem.className = 'issue-actions-menu-item' + (state === 'open' ? ' danger' : '');
    toggleItem.innerHTML = state === 'open'
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/></svg> Close issue`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/></svg> Reopen issue`;
    toggleItem.addEventListener('click', async () => {
        closeIssueActionsMenu();
        try {
            const tokenData = await getStoredToken();
            const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: newState })
            });
            if (!res.ok) throw new Error('Failed');
            showStatus(`Issue #${number} ${newState === 'closed' ? 'closed' : 'reopened'}`, 'success');
            await loadRepoIssues(currentRepoFullName);
        } catch (err) { showStatus('Failed: ' + err.message, 'error'); }
    });
    menu.appendChild(toggleItem);

    showPopover({
        anchor: button,
        element: menu,
        alignRight: true,
        onClose: closeIssueActionsMenu
    });
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

        // Auto-select the linked repo if the project has one
        const convertLinkedRepos = currentProject.repositories?.nodes?.filter(r => r.nameWithOwner) || [];
        const convertRepoRow = document.getElementById('convertDraftRepositoryRow');
        if (convertLinkedRepos.length === 1) {
            repoSelect.value = convertLinkedRepos[0].nameWithOwner;
            if (convertRepoRow) convertRepoRow.style.display = 'none';
        } else {
            if (convertRepoRow) convertRepoRow.style.display = '';
        }

        // Populate target project dropdown — all projects including current
        const targetSel = document.getElementById('convertDraftTargetProject');
        targetSel.innerHTML = '<option value="">Keep in current project</option>';
        if (allProjects && allProjects.data) {
            allProjects.data.viewer.projectsV2.nodes.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.title + (p.id === currentProject.id ? ' (current)' : '');
                targetSel.appendChild(opt);
            });
        }

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

        // Determine target project — use selected or fall back to current
        const targetProjectSel = document.getElementById('convertDraftTargetProject');
        const targetProjectId = targetProjectSel.value || currentProject.id;

        // Step 2: Add the new issue to the target project
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
                    projectId: targetProjectId,
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

        const targetName = targetProjectSel.value
            ? targetProjectSel.options[targetProjectSel.selectedIndex].textContent.replace(' (current)', '')
            : currentProject.title;
        showStatus(`Draft converted to issue in "${targetName}"!`, 'success');
        closeModal('convertDraftModal');

        // Reload project
        const projectId = currentProject.id;
        await new Promise(resolve => setTimeout(resolve, 1000));
        invalidateProjectCache(projectId);
        await loadProjectIssues(projectId);

        await completeBenchmarkTask('convert_draft_to_issue');

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
            autoStartBenchmark('convert_draft_to_issue');
            openConvertDraftModal(issueId, issueTitle, issueBody);
        });
        menu.appendChild(convertItem);
    }

    // Move to Project (for both drafts and real issues)
    const moveItem = document.createElement('div');
    moveItem.className = 'issue-actions-menu-item';
    moveItem.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M1 8a.5.5 0 0 1 .5-.5h11.793l-3.147-3.146a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L13.293 8.5H1.5A.5.5 0 0 1 1 8z"/>
        </svg>
        Move to Project
    `;
    moveItem.addEventListener('click', () => {
        closeIssueActionsMenu();
        autoStartBenchmark('move_item_to_project');
        openMoveToProjectModal(issueId, issueTitle, issueType);
    });
    menu.appendChild(moveItem);

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

    showPopover({
        anchor: button,
        element: menu,
        alignRight: true,
        onClose: closeIssueActionsMenu
    });
}

function closeIssueActionsMenu() {
    document.querySelectorAll('.issue-actions-menu').forEach(menu => menu.remove());
    document.removeEventListener('click', closeIssueActionsMenu);
}

// ============================================================================
// Move to Project
// ============================================================================

let moveItemId = null;
let moveItemType = null;

function openMoveToProjectModal(itemId, itemTitle, itemType) {
    moveItemId = itemId;
    moveItemType = itemType;

    // Populate project list — exclude current project
    const sel = document.getElementById('moveToProjectSelect');
    sel.innerHTML = '<option value="" disabled selected>Choose a project...</option>';

    if (allProjects && allProjects.data) {
        allProjects.data.viewer.projectsV2.nodes
            .filter(p => p.id !== currentProject.id)
            .forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.title;
                sel.appendChild(opt);
            });
    }

    const typeLabel = itemType === 'DRAFT' ? 'draft issue' : 'issue';
    document.getElementById('moveToProjectDesc').textContent =
        `Move "${itemTitle}" from "${currentProject.title}" to another project.`;

    openModal('moveToProjectModal');
}

async function moveToProject() {
    const sel = document.getElementById('moveToProjectSelect');
    const targetProjectId = sel.value;

    if (!targetProjectId) {
        showStatus('Please select a target project', 'error');
        return;
    }

    const confirmBtn = document.getElementById('confirmMoveToProject');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        // Step 1: Copy item to target project
        const copyMutation = `
            mutation CopyItem($projectId: ID!, $itemId: ID!) {
                copyProjectV2Item(input: {
                    projectId: $projectId
                    itemId: $itemId
                    targetProjectId: $projectId
                }) {
                    item { id }
                }
            }
        `;

        // GitHub doesn't have copyProjectV2Item yet for cross-project —
        // use addProjectV2Item for real issues, or addProjectV2DraftIssue for drafts

        if (moveItemType === 'DRAFT') {
            // For drafts: read the title from the table row, create a new draft in target project
            const titleEl = document.querySelector(`[data-issue-id="${moveItemId}"]`)
                ?.closest('tr')?.querySelector('.issue-title');
            const title = titleEl?.textContent?.trim() || 'Untitled';

            const draftMutation = `
                mutation AddDraft($projectId: ID!, $title: String!) {
                    addProjectV2DraftIssue(input: { projectId: $projectId, title: $title }) {
                        projectItem { id }
                    }
                }
            `;
            const draftRes = await fetch('https://api.github.com/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
                body: JSON.stringify({ query: draftMutation, variables: { projectId: targetProjectId, title } })
            });
            const draftResult = await draftRes.json();
            if (draftResult.errors) throw new Error(draftResult.errors[0].message);

        } else {
            // For real issues: get the content node ID from the current project items cache
            const cached = projectItemsCache[currentProject.id];
            const item = cached?.find(i => i.id === moveItemId);
            if (!item || !item.content?.id) throw new Error('Could not find issue node ID');

            const addMutation = `
                mutation AddIssue($projectId: ID!, $contentId: ID!) {
                    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
                        item { id }
                    }
                }
            `;
            const addRes = await fetch('https://api.github.com/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
                body: JSON.stringify({ query: addMutation, variables: { projectId: targetProjectId, contentId: item.content.id } })
            });
            const addResult = await addRes.json();
            if (addResult.errors) throw new Error(addResult.errors[0].message);
        }

        // Step 2: Remove from current project
        const removeMutation = `
            mutation RemoveItem($projectId: ID!, $itemId: ID!) {
                deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
                    deletedItemId
                }
            }
        `;
        await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
            body: JSON.stringify({ query: removeMutation, variables: { projectId: currentProject.id, itemId: moveItemId } })
        });

        const targetName = sel.options[sel.selectedIndex].textContent;
        showStatus(`Moved to "${targetName}" successfully`, 'success');
        closeModal('moveToProjectModal');

        // Reload current project
        const projectId = currentProject.id;
        await new Promise(resolve => setTimeout(resolve, 800));
        invalidateProjectCache(projectId);
        await loadProjectIssues(projectId);

        await completeBenchmarkTask('move_item_to_project');

    } catch (err) {
        console.error('Move error:', err);
        showStatus('Failed to move: ' + err.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

async function removeIssueFromProject(itemId) {
    if (!currentProject) return;

    autoStartBenchmark('remove_issue_from_project');
    if (!confirm('Remove this issue from the project? The issue will still exist on GitHub.')) {
        await cancelBenchmarkTask('remove_issue_from_project', 'user_declined_confirm');
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
        invalidateProjectCache(currentProject.id);
        await loadProjectIssues(currentProject.id);

        await completeBenchmarkTask('remove_issue_from_project');

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

        if (currentMode === 'repo' && currentRepoFullName) {
            await loadRepoIssues(currentRepoFullName);
        } else if (currentProject) {
            invalidateProjectCache(currentProject.id);
            await loadProjectIssues(currentProject.id);
        }

        await completeBenchmarkTask('delete_repo_issue');

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

    showPopover({
        anchor: badgeElement,
        element: dropdown,
        alignRight: false,
        onClose: hideStatusDropdown
    });

    currentStatusDropdown = dropdown;
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

        // Auto-select the linked repo if the project has one
        const projectLinkedRepos = currentProject.repositories?.nodes?.filter(r => r.nameWithOwner) || [];
        const repoRow = document.getElementById('issueRepositoryRow');
        if (projectLinkedRepos.length === 1) {
            repoSelect.value = projectLinkedRepos[0].nameWithOwner;
            if (repoRow) repoRow.style.display = 'none';
        } else {
            if (repoRow) repoRow.style.display = '';
        }

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
        invalidateProjectCache(projectId);
        await loadProjectIssues(projectId);

        await completeBenchmarkTask('create_project_draft');

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
        invalidateProjectCache(projectId);
        await loadProjectIssues(projectId);

        await completeBenchmarkTask('create_project_issue');

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

        const projectSelect = document.getElementById('unifiedSelect');
        const selectedOption = projectSelect.querySelector(`option[value="project:${currentProject.id}"]`);
        if (selectedOption) {
            selectedOption.textContent = newTitle;
        }

        const projectIndex = allProjects.data.viewer.projectsV2.nodes.findIndex(p => p.id === currentProject.id);
        if (projectIndex !== -1) {
            allProjects.data.viewer.projectsV2.nodes[projectIndex].title = newTitle;
        }

        closeModal('renameProjectModal');

        await completeBenchmarkTask('rename_project');

    } catch (error) {
        console.error('Error renaming project:', error);
        showStatus('Failed to rename project: ' + error.message, 'error');
    } finally {
        renameBtn.disabled = false;
    }
}

async function openCreateProjectModal() {
    // Clear form fields
    document.getElementById('newProjectTitleInput').value = '';
    document.getElementById('newProjectDescription').value = '';
    document.getElementById('projectPublic').checked = false;

    // Populate repo dropdown
    const repoSelect = document.getElementById('newProjectRepository');
    repoSelect.innerHTML = '<option value="">No repository</option>';

    try {
        const tokenData = await getStoredToken();
        if (tokenData && tokenData.access_token) {
            if (userRepositories.length === 0) {
                userRepositories = await fetchUserRepositories(tokenData.access_token);
            }
            userRepositories.forEach(repo => {
                const option = document.createElement('option');
                option.value = repo.node_id;
                option.textContent = repo.full_name;
                option.dataset.owner = repo.owner.login;
                option.dataset.name = repo.name;
                repoSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading repositories for project modal:', error);
    }

    openModal('createProjectModal');
}

async function createNewProject() {
    const title = document.getElementById('newProjectTitleInput').value.trim();
    const description = document.getElementById('newProjectDescription').value.trim();
    const isPublic = document.getElementById('projectPublic').checked;
    const repoSelect = document.getElementById('newProjectRepository');
    const selectedRepoNodeId = repoSelect.value || null;

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

        // Link repository to project if one was selected
        if (selectedRepoNodeId) {
            const linkQuery = `
                mutation LinkProjectToRepo($projectId: ID!, $repositoryId: ID!) {
                    linkProjectV2ToRepository(input: {
                        projectId: $projectId
                        repositoryId: $repositoryId
                    }) {
                        repository {
                            name
                        }
                    }
                }
            `;

            const linkResponse = await fetch('https://api.github.com/graphql', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${tokenData.access_token}`,
                },
                body: JSON.stringify({
                    query: linkQuery,
                    variables: {
                        projectId: newProjectId,
                        repositoryId: selectedRepoNodeId
                    }
                })
            });

            const linkResult = await linkResponse.json();

            if (linkResult.errors) {
                console.error('Error linking repository to project:', linkResult.errors);
                // Don't throw — project was still created successfully
            }
        }

        showStatus('Project created successfully!', 'success');

        // Clear form fields
        document.getElementById('newProjectTitleInput').value = '';
        document.getElementById('newProjectDescription').value = '';
        document.getElementById('projectPublic').checked = false;
        document.getElementById('newProjectRepository').value = '';

        closeModal('createProjectModal');

        // Reload projects to show the new one
        await loadProjects();

        // Select the newly created project
        const projectSelect = document.getElementById('unifiedSelect');
        projectSelect.value = 'project:' + newProjectId;

        // Trigger change event to load the project
        await loadProjectIssues(newProjectId);

        await completeBenchmarkTask('create_project');

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

        await completeBenchmarkTask('edit_project_settings');

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

            const projectSelect = document.getElementById('unifiedSelect');
            const selectedOption = projectSelect.querySelector(`option[value="project:${currentProject.id}"]`);
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


// ============================================================================
// Quick Capture — Inbox Project
// ============================================================================

const INBOX_STORAGE_KEY = 'quickCaptureInboxProject'; // { id, title }

async function getInboxProject() {
    const result = await chrome.storage.local.get([INBOX_STORAGE_KEY]);
    return result[INBOX_STORAGE_KEY] || null;
}

async function setInboxProject(id, title) {
    await chrome.storage.local.set({ [INBOX_STORAGE_KEY]: { id, title } });
}

async function initQuickCapture() {
    const inbox = await getInboxProject();
    const label = document.getElementById('qcInboxLabel');

    if (inbox) {
        // Verify the stored title is still accurate — project may have been renamed
        if (allProjects && allProjects.data) {
            const live = allProjects.data.viewer.projectsV2.nodes.find(p => p.id === inbox.id);
            if (live && live.title !== inbox.title) {
                // Silently update the stored title to match GitHub
                await setInboxProject(inbox.id, live.title);
                inbox.title = live.title;
            }
        }
        label.textContent = inbox.title;
    } else {
        label.textContent = 'Set inbox →';
        // Only prompt if quick capture is actually enabled
        const result2 = await chrome.storage.local.get(['quickCaptureEnabled']);
        const enabled = result2.quickCaptureEnabled !== false;
        if (enabled) setTimeout(() => openInboxSetupModal(), 600);
    }

    // Restore enabled/disabled preference
    const result = await chrome.storage.local.get(['quickCaptureEnabled']);
    const enabled = result.quickCaptureEnabled !== false; // default true
    const toggle = document.getElementById('qcToggle');
    const bar = document.getElementById('quickCaptureBar');

    toggle.checked = enabled;
    bar.classList.toggle('qc-collapsed', !enabled);

    toggle.addEventListener('change', async () => {
        const on = toggle.checked;
        bar.classList.toggle('qc-collapsed', !on);
        await chrome.storage.local.set({ quickCaptureEnabled: on });
    });
}

function openInboxSetupModal() {
    // Populate the project select with current allProjects
    const sel = document.getElementById('inboxProjectSelect');
    sel.innerHTML = '<option value="" disabled selected>Choose a project...</option>';

    if (allProjects && allProjects.data) {
        allProjects.data.viewer.projectsV2.nodes.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.title;
            sel.appendChild(opt);
        });
    }

    // Clear new project input
    document.getElementById('inboxNewProjectName').value = '';

    openModal('inboxSetupModal');
}

async function saveInboxSetup() {
    const sel = document.getElementById('inboxProjectSelect');
    const newName = document.getElementById('inboxNewProjectName').value.trim();
    const confirmBtn = document.getElementById('confirmInboxSetup');

    if (!sel.value && !newName) {
        showStatus('Pick a project or enter a name for a new one', 'error');
        return;
    }

    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        let inboxId, inboxTitle;

        if (newName) {
            // Create a new project via GraphQL
            const login = (await fetchGitHubUser(tokenData.access_token)).login;
            const mutation = `
                mutation CreateProject($ownerId: ID!, $title: String!) {
                    createProjectV2(input: { ownerId: $ownerId, title: $title }) {
                        projectV2 { id title }
                    }
                }
            `;
            // Get owner node ID first
            const userQuery = `query { viewer { id } }`;
            const userRes = await fetch('https://api.github.com/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
                body: JSON.stringify({ query: userQuery })
            });
            const userData = await userRes.json();
            const ownerId = userData.data.viewer.id;

            const res = await fetch('https://api.github.com/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
                body: JSON.stringify({ query: mutation, variables: { ownerId, title: newName } })
            });
            const result = await res.json();
            if (result.errors) throw new Error(result.errors[0].message);

            inboxId = result.data.createProjectV2.projectV2.id;
            inboxTitle = result.data.createProjectV2.projectV2.title;

            // Reload projects list so it shows up
            await loadProjects();
        } else {
            inboxId = sel.value;
            inboxTitle = sel.options[sel.selectedIndex].textContent;
        }

        await setInboxProject(inboxId, inboxTitle);
        document.getElementById('qcInboxLabel').textContent = inboxTitle;
        closeModal('inboxSetupModal');
        showStatus(`Inbox set to "${inboxTitle}"`, 'success');

    } catch (err) {
        console.error('Error setting inbox:', err);
        showStatus('Failed: ' + err.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

async function quickCaptureSave() {
    const textarea = document.getElementById('qcTextarea');
    const text = textarea.value.trim();

    if (!text) {
        textarea.focus();
        return;
    }

    const inbox = await getInboxProject();
    if (!inbox) {
        openInboxSetupModal();
        return;
    }

    const saveBtn = document.getElementById('qcSaveBtn');
    saveBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData || !tokenData.access_token) {
            showStatus('Not authenticated', 'error');
            return;
        }

        const mutation = `
            mutation AddDraft($projectId: ID!, $title: String!) {
                addProjectV2DraftIssue(input: { projectId: $projectId, title: $title }) {
                    projectItem { id }
                }
            }
        `;

        const res = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
            body: JSON.stringify({ query: mutation, variables: { projectId: inbox.id, title: text } })
        });

        const result = await res.json();
        if (result.errors) throw new Error(result.errors[0].message);

        // Clear and give success feedback
        textarea.value = '';
        textarea.style.height = 'auto';

        saveBtn.style.background = '#22c55e';
        saveBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                <path d="M10.97 4.97a.75.75 0 0 1 1.07 1.05l-3.99 4.99a.75.75 0 0 1-1.08.02L4.324 8.384a.75.75 0 1 1 1.06-1.06l2.094 2.093 3.473-4.425a.267.267 0 0 1 .02-.022z"/>
            </svg>
            Saved!
        `;
        setTimeout(() => {
            saveBtn.style.background = '';
            saveBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M10.97 4.97a.75.75 0 0 1 1.07 1.05l-3.99 4.99a.75.75 0 0 1-1.08.02L4.324 8.384a.75.75 0 1 1 1.06-1.06l2.094 2.093 3.473-4.425a.267.267 0 0 1 .02-.022z"/>
                </svg>
                Save
            `;
            saveBtn.disabled = false;
        }, 1500);

        // Invalidate cache if inbox is currently viewed project
        if (currentProject && currentProject.id === inbox.id) {
            invalidateProjectCache(inbox.id);
            await loadProjectIssues(inbox.id);
        }

    } catch (err) {
        console.error('Quick capture error:', err);

        // Detect if the inbox project no longer exists on GitHub
        const isGone = err.message && (
            err.message.toLowerCase().includes('could not resolve to a node') ||
            err.message.toLowerCase().includes('not found') ||
            err.message.toLowerCase().includes('does not exist')
        );

        if (isGone) {
            // Clear the stale inbox reference and prompt the user to pick a new one
            await chrome.storage.local.remove([INBOX_STORAGE_KEY]);
            document.getElementById('qcInboxLabel').textContent = 'Set inbox →';
            showStatus('Inbox project was deleted — please set a new one', 'error');
            setTimeout(() => openInboxSetupModal(), 800);
        } else {
            showStatus('Failed to save: ' + err.message, 'error');
        }

        saveBtn.disabled = false;
    }
}

// ============================================================================
// Unified select helpers
// ============================================================================

let currentMode = 'project';

async function populateRepoOptgroup(select) {
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) return;
        if (userRepositories.length === 0) userRepositories = await fetchUserRepositories(tokenData.access_token);
        const repoGroup = document.createElement('optgroup');
        repoGroup.label = 'Repositories';
        repoGroup.dataset.type = 'repo';
        userRepositories.forEach(repo => {
            const opt = document.createElement('option');
            opt.value = 'repo:' + repo.full_name;
            opt.textContent = repo.full_name;
            repoGroup.appendChild(opt);
        });
        select.appendChild(repoGroup);
    } catch (e) { console.error('Failed to load repos for unified select', e); }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Check if we're in a popout window
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('popout') === 'true') {
        document.body.classList.add('popout');
    }

    // Register benchmark click/change/input listeners
    attachBenchmarkUIHandlers();

    // ── Quick Capture listeners ──
    const qcTextarea = document.getElementById('qcTextarea');
    const qcSaveBtn = document.getElementById('qcSaveBtn');

    // Auto-resize textarea
    qcTextarea.addEventListener('input', () => {
        qcTextarea.style.height = 'auto';
        qcTextarea.style.height = Math.min(qcTextarea.scrollHeight, 90) + 'px';
    });

    // ⌘+Enter / Ctrl+Enter to save
    qcTextarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            quickCaptureSave();
        }
    });

    qcSaveBtn.addEventListener('click', quickCaptureSave);

    // Gear button → open inbox settings
    document.getElementById('qcInboxName').addEventListener('click', openInboxSetupModal);

    // Inbox setup modal
    document.getElementById('closeInboxSetupModal').addEventListener('click', () => closeModal('inboxSetupModal'));
    document.getElementById('cancelInboxSetup').addEventListener('click', () => closeModal('inboxSetupModal'));
    document.getElementById('confirmInboxSetup').addEventListener('click', saveInboxSetup);

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
            await initQuickCapture();
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
            const loginBtn = document.getElementById('loginBtn');
            loginBtn.disabled = false;
            loginBtn.textContent = 'Login with GitHub';
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

    // Issues tab — mode toggle
    // Unified project/repo select
    document.getElementById('unifiedSelect').addEventListener('change', async (e) => {
        const val = e.target.value;
        if (!val) { hideProjectIssues(); return; }
        if (val.startsWith('project:')) {
            currentMode = 'project';
            await loadProjectIssues(val.slice('project:'.length));
        } else if (val.startsWith('repo:')) {
            currentMode = 'repo';
            await loadRepoIssues(val.slice('repo:'.length));
        }
    });

    // Repo state tabs
    document.querySelectorAll('.repo-state-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            document.querySelectorAll('.repo-state-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentRepoIssueState = tab.dataset.state;
            if (currentRepoFullName) await loadRepoIssues(currentRepoFullName);
        });
    });

    // New repo issue modal
    document.getElementById('newRepoIssueBtn').addEventListener('click', () => {
        if (!currentRepoFullName) return;
        autoStartBenchmark('create_repo_issue');
        document.getElementById('newIssueRepoName').textContent = currentRepoFullName;
        document.getElementById('newIssueTitle').value = '';
        document.getElementById('newIssueBody').value = '';
        document.getElementById('newRepoIssueModal').style.display = 'flex';
        setTimeout(() => document.getElementById('newIssueTitle').focus(), 50);
    });
    document.getElementById('closeNewRepoIssueModal').addEventListener('click', () => {
        document.getElementById('newRepoIssueModal').style.display = 'none';
    });
    document.getElementById('cancelNewRepoIssue').addEventListener('click', () => {
        document.getElementById('newRepoIssueModal').style.display = 'none';
    });
    document.getElementById('newRepoIssueModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    document.getElementById('submitNewRepoIssue').addEventListener('click', async () => {
        const title = document.getElementById('newIssueTitle').value.trim();
        const body = document.getElementById('newIssueBody').value.trim();
        if (!title) { showStatus('Title is required', 'error'); return; }
        const btn = document.getElementById('submitNewRepoIssue');
        btn.disabled = true;
        btn.textContent = 'Creating...';
        try {
            const tokenData = await getStoredToken();
            const [owner, repo] = currentRepoFullName.split('/');
            const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, body: body || undefined })
            });
            if (!res.ok) throw new Error((await res.json()).message || 'Failed');
            const issue = await res.json();
            document.getElementById('newRepoIssueModal').style.display = 'none';
            showStatus(`Issue #${issue.number} created`, 'success');
            await loadRepoIssues(currentRepoFullName);
            await completeBenchmarkTask('create_repo_issue');
        } catch (err) {
            showStatus('Failed to create issue: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2Z" /></svg> Create Issue';
        }
    });

    // Refresh
    document.getElementById('refreshProjectsBtn').addEventListener('click', async () => {
        const btn = document.getElementById('refreshProjectsBtn');
        btn.disabled = true;
        try {
            if (currentMode === 'repo' && currentRepoFullName) {
                await loadRepoIssues(currentRepoFullName);
                showStatus('Issues refreshed', 'success');
            } else {
                await loadProjects();
                showStatus('Projects refreshed successfully', 'success');
            }
        } catch (error) {
            showStatus('Failed to refresh', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    // Create new gist button
    document.getElementById('createNewGistBtn').addEventListener('click', () => {
        currentGist = null;
        autoStartBenchmark('create_gist');
        openCreateGistModal();
    });

    // Create new project button
    document.getElementById('createNewProjectBtn').addEventListener('click', async () => {
        autoStartBenchmark('create_project');
        await openCreateProjectModal();
    });

    // Edit gist button
    document.getElementById('editGistBtn').addEventListener('click', () => {
        autoStartBenchmark('edit_gist');
        openFileEditorModal();
    });

    // Add file button
    document.getElementById('addFileBtn').addEventListener('click', () => {
        autoStartBenchmark('add_gist_file');
        openAddFileModal();
    });

    // Rename gist button
    document.getElementById('renameGistBtn').addEventListener('click', () => {
        autoStartBenchmark('rename_gist');
        openRenameGistModal();
    });

    // Delete gist button
    document.getElementById('deleteGistBtn').addEventListener('click', () => {
        autoStartBenchmark('delete_gist');
        deleteCurrentGist();
    });

    // Gist editor modal
    document.getElementById('closeGistEditorModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_gist', 'close_gist_editor_modal');
        await cancelBenchmarkTask('edit_gist', 'close_gist_editor_modal');
        closeModal('gistEditorModal');
        document.getElementById('gistFilename').disabled = false;
    });
    document.getElementById('cancelGistEditor').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_gist', 'cancel_gist_editor_modal');
        await cancelBenchmarkTask('edit_gist', 'cancel_gist_editor_modal');
        closeModal('gistEditorModal');
        document.getElementById('gistFilename').disabled = false;
    });
    document.getElementById('saveGist').addEventListener('click', saveGist);

    // Add file modal
    document.getElementById('closeAddFileModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('add_gist_file', 'close_add_file_modal');
        closeModal('addFileModal');
    });
    document.getElementById('cancelAddFile').addEventListener('click', async () => {
        await cancelBenchmarkTask('add_gist_file', 'cancel_add_file_modal');
        closeModal('addFileModal');
    });
    document.getElementById('saveNewFile').addEventListener('click', saveNewFile);

    // File editor modal
    document.getElementById('closeFileEditorModal').addEventListener('click', () => closeModal('fileEditorModal'));
    document.getElementById('cancelFileEditor').addEventListener('click', () => closeModal('fileEditorModal'));
    document.getElementById('saveFileChanges').addEventListener('click', saveFileChanges);
    document.getElementById('fileSelector').addEventListener('change', loadSelectedFile);
    document.getElementById('renameFileBtn').addEventListener('click', () => {
        autoStartBenchmark('rename_gist_file');
        openRenameFileModal();
    });
    document.getElementById('deleteFileBtn').addEventListener('click', () => {
        autoStartBenchmark('delete_gist_file');
        deleteCurrentFile();
    });

    // Delete confirm modal
    document.getElementById('closeDeleteConfirmModal').addEventListener('click', () => closeModal('deleteConfirmModal'));
    document.getElementById('cancelDelete').addEventListener('click', () => closeModal('deleteConfirmModal'));
    document.getElementById('confirmDelete').addEventListener('click', confirmDeleteAction);

    // Rename gist modal
    document.getElementById('closeRenameGistModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist', 'close_rename_gist_modal');
        closeModal('renameGistModal');
    });
    document.getElementById('cancelRenameGist').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist', 'cancel_rename_gist_modal');
        closeModal('renameGistModal');
    });
    document.getElementById('confirmRenameGist').addEventListener('click', renameGist);

    // Rename file modal
    document.getElementById('closeRenameFileModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist_file', 'close_rename_file_modal');
        closeModal('renameFileModal');
    });
    document.getElementById('cancelRenameFile').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist_file', 'cancel_rename_file_modal');
        closeModal('renameFileModal');
    });
    document.getElementById('confirmRenameFile').addEventListener('click', renameFile);

    // Rename project modal
    document.getElementById('closeRenameProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_project', 'close_rename_project_modal');
        closeModal('renameProjectModal');
    });
    document.getElementById('cancelRenameProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_project', 'cancel_rename_project_modal');
        closeModal('renameProjectModal');
    });
    document.getElementById('confirmRenameProject').addEventListener('click', renameProject);

    // Add issue modal
    document.getElementById('closeAddIssueModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_issue', 'close_add_issue_modal');
        closeModal('addIssueModal');
    });
    document.getElementById('cancelAddIssue').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_issue', 'cancel_add_issue_modal');
        closeModal('addIssueModal');
    });
    document.getElementById('confirmAddIssue').addEventListener('click', addIssueToProject);

    // Edit issue modal
    document.getElementById('closeEditIssueModal').addEventListener('click', () => closeModal('editIssueModal'));
    document.getElementById('cancelEditIssue').addEventListener('click', () => closeModal('editIssueModal'));
    document.getElementById('confirmEditIssue').addEventListener('click', saveIssueEdits);

    // Create project modal
    document.getElementById('closeCreateProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project', 'close_create_project_modal');
        closeModal('createProjectModal');
    });
    document.getElementById('cancelCreateProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project', 'cancel_create_project_modal');
        closeModal('createProjectModal');
    });
    document.getElementById('confirmCreateProject').addEventListener('click', createNewProject);

    // Edit project modal
    document.getElementById('closeEditProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('edit_project_settings', 'close_edit_project_modal');
        closeModal('editProjectModal');
    });
    document.getElementById('cancelEditProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('edit_project_settings', 'cancel_edit_project_modal');
        closeModal('editProjectModal');
    });
    document.getElementById('confirmEditProject').addEventListener('click', saveProjectEdits);

    // Project actions
    document.getElementById('addIssueBtn').addEventListener('click', openChooseAddTypeModal);
    document.getElementById('editProjectBtn').addEventListener('click', () => {
        autoStartBenchmark('edit_project_settings');
        openEditProjectModal();
    });
    document.getElementById('renameProjectBtn').addEventListener('click', () => {
        autoStartBenchmark('rename_project');
        openRenameProjectModal();
    });
    document.getElementById('deleteProjectBtn').addEventListener('click', () => {
        autoStartBenchmark('delete_repo_issue');
        deleteCurrentProject();
    });

    // Choose add type modal
    document.getElementById('closeChooseAddTypeModal').addEventListener('click', () => closeModal('chooseAddTypeModal'));
    document.getElementById('chooseAddIssue').addEventListener('click', () => {
        closeModal('chooseAddTypeModal');
        autoStartBenchmark('create_project_issue');
        openAddIssueModal();
    });
    document.getElementById('chooseAddDraft').addEventListener('click', () => {
        closeModal('chooseAddTypeModal');
        autoStartBenchmark('create_project_draft');
        openAddDraftModal();
    });

    // Add draft modal
    document.getElementById('closeAddDraftModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_draft', 'close_add_draft_modal');
        closeModal('addDraftModal');
    });
    document.getElementById('cancelAddDraft').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_draft', 'cancel_add_draft_modal');
        closeModal('addDraftModal');
    });
    document.getElementById('confirmAddDraft').addEventListener('click', addDraftToProject);

    // Convert draft to issue modal
    document.getElementById('closeConvertDraftModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('convert_draft_to_issue', 'close_convert_draft_modal');
        closeModal('convertDraftModal');
    });
    document.getElementById('cancelConvertDraft').addEventListener('click', async () => {
        await cancelBenchmarkTask('convert_draft_to_issue', 'cancel_convert_draft_modal');
        closeModal('convertDraftModal');
    });
    document.getElementById('confirmConvertDraft').addEventListener('click', convertDraftToIssue);

    // Move to project modal
    document.getElementById('closeMoveToProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('move_item_to_project', 'close_move_to_project_modal');
        closeModal('moveToProjectModal');
    });
    document.getElementById('cancelMoveToProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('move_item_to_project', 'cancel_move_to_project_modal');
        closeModal('moveToProjectModal');
    });
    document.getElementById('confirmMoveToProject').addEventListener('click', moveToProject);

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
            await initQuickCapture();

        } catch (error) {
            console.error('Error loading user data:', error);
            await clearStoredToken();
        }
    }
});