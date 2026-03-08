// ============================================================================
// AI Assistance Module for GitHub Management Extension
// Integrates with Claude API to enhance productivity
// ============================================================================

const AI_ASSIST = (() => {

    // ── State ──────────────────────────────────────────────────────────────
    let aiPanelOpen = false;
    let aiChatHistory = [];
    let currentContext = null; // { type: 'issue'|'gist'|'project', data: {} }
    let isStreaming = false;

    // ── Config ─────────────────────────────────────────────────────────────
    const MODEL = 'claude-sonnet-4-20250514';
    const API_URL = 'https://api.anthropic.com/v1/messages';
    const MAX_TOKENS = 1024;

    // ── Prompts ────────────────────────────────────────────────────────────
    const SYSTEM_PROMPT = `You are an expert GitHub project manager and software engineer embedded in a GitHub Management browser extension. 
You help users manage their GitHub projects, issues, and gists more effectively.

Your capabilities:
- Summarize issues and projects concisely
- Draft well-structured GitHub issues with clear titles, descriptions, and acceptance criteria
- Improve existing issue/gist text (clarity, grammar, structure)
- Suggest status updates and prioritization
- Generate commit messages from diff descriptions
- Break down large issues into smaller sub-tasks
- Write technical documentation for gists

Always respond concisely. Use GitHub Markdown formatting where appropriate.
When drafting issues, use this structure:
## Summary
[1-2 sentence description]

## Steps to Reproduce / Details
[numbered list if applicable]

## Expected Behavior
[clear expectation]

## Acceptance Criteria
- [ ] criterion 1
- [ ] criterion 2`;

    // ── DOM Helpers ────────────────────────────────────────────────────────
    function el(id) { return document.getElementById(id); }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // Minimal markdown → HTML (bold, italic, code, headers, lists, checkboxes)
    function renderMarkdown(text) {
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/```([\s\S]*?)```/g, '<pre class="ai-code-block"><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>')
            .replace(/^#{3} (.+)$/gm, '<h3 class="ai-md-h3">$1</h3>')
            .replace(/^#{2} (.+)$/gm, '<h2 class="ai-md-h2">$1</h2>')
            .replace(/^#{1} (.+)$/gm, '<h1 class="ai-md-h1">$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^- \[ \] (.+)$/gm, '<li class="ai-checkbox"><input type="checkbox" disabled> $1</li>')
            .replace(/^- \[x\] (.+)$/gm, '<li class="ai-checkbox"><input type="checkbox" checked disabled> $1</li>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/^(\d+)\. (.+)$/gm, '<li class="ai-ol">$1. $2</li>')
            .replace(/\n{2,}/g, '</p><p class="ai-p">')
            .replace(/\n/g, '<br>');
    }

    // ── API Call ───────────────────────────────────────────────────────────
    async function callClaude(userMessage, extraContext = '') {
        const messages = [...aiChatHistory];

        // Inject context if present
        let content = userMessage;
        if (extraContext) {
            content = `${extraContext}\n\n---\n\n${userMessage}`;
        }

        messages.push({ role: 'user', content });

        const apiKey = window.__AI_ASSIST_API_KEY__;
        if (!apiKey) {
            throw new Error('No API key set. Add your Claude API key in the AI Assistant panel.');
        }

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                system: SYSTEM_PROMPT,
                messages
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `API error ${response.status}`);
        }

        const data = await response.json();
        const assistantText = data.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');

        // Store in history
        aiChatHistory.push({ role: 'user', content });
        aiChatHistory.push({ role: 'assistant', content: assistantText });

        // Trim history to last 10 turns
        if (aiChatHistory.length > 20) {
            aiChatHistory = aiChatHistory.slice(-20);
        }

        return assistantText;
    }

    // ── Context Builders ───────────────────────────────────────────────────
    function buildIssueContext(issue) {
        if (!issue) return '';
        const parts = [`**Issue #${issue.number || '?'}: ${issue.title || 'Untitled'}**`];
        if (issue.state) parts.push(`State: ${issue.state}`);
        if (issue.body) parts.push(`\nDescription:\n${issue.body}`);
        if (issue.labels?.nodes?.length) {
            parts.push(`Labels: ${issue.labels.nodes.map(l => l.name).join(', ')}`);
        }
        if (issue.assignees?.nodes?.length) {
            parts.push(`Assignees: ${issue.assignees.nodes.map(a => a.login).join(', ')}`);
        }
        return parts.join('\n');
    }

    function buildProjectContext(project) {
        if (!project) return '';
        const parts = [`**Project: ${project.title || 'Untitled'}**`];
        if (project.shortDescription) parts.push(project.shortDescription);
        if (project.items) {
            const items = project.items.nodes || [];
            const openIssues = items.filter(i => i.content?.state === 'OPEN');
            parts.push(`\nTotal items: ${items.length}, Open issues: ${openIssues.length}`);
            const sampleTitles = items.slice(0, 8).map(i => `- ${i.content?.title || i.content?.id || 'Draft'}`);
            if (sampleTitles.length) parts.push('Recent items:\n' + sampleTitles.join('\n'));
        }
        return parts.join('\n');
    }

    function buildGistContext(gist) {
        if (!gist) return '';
        const parts = [`**Gist: ${gist.description || 'Untitled'}**`];
        const files = Object.keys(gist.files || {});
        if (files.length) parts.push(`Files: ${files.join(', ')}`);
        // Include first file content (truncated)
        const firstFile = gist.files?.[files[0]];
        if (firstFile?.content) {
            parts.push(`\nContent preview:\n\`\`\`\n${firstFile.content.slice(0, 800)}${firstFile.content.length > 800 ? '\n...[truncated]' : ''}\n\`\`\``);
        }
        return parts.join('\n');
    }

    // ── Quick Actions ──────────────────────────────────────────────────────
    const QUICK_ACTIONS = [
        {
            id: 'summarize',
            label: '✦ Summarize',
            prompt: 'Summarize this in 2-3 bullet points.',
            requiresContext: true
        },
        {
            id: 'draft-issue',
            label: '✦ Draft Issue',
            prompt: 'Help me draft a well-structured GitHub issue based on this context. Include a clear title suggestion.',
            requiresContext: false
        },
        {
            id: 'improve',
            label: '✦ Improve Text',
            prompt: 'Improve the clarity, structure, and technical precision of this content.',
            requiresContext: true
        },
        {
            id: 'subtasks',
            label: '✦ Break into Sub-tasks',
            prompt: 'Break this down into smaller, actionable sub-tasks as a checklist.',
            requiresContext: true
        },
        {
            id: 'acceptance',
            label: '✦ Add Acceptance Criteria',
            prompt: 'Add clear acceptance criteria checkboxes to this issue.',
            requiresContext: true
        },
        {
            id: 'commit-msg',
            label: '✦ Commit Message',
            prompt: 'Generate a conventional commit message for the changes described here.',
            requiresContext: true
        }
    ];

    // ── Copy Button Factory ────────────────────────────────────────────────
    function makeCopyBtn(messageDiv) {
        const btn = document.createElement('button');
        btn.className = 'ai-copy-btn';
        btn.title = 'Copy to clipboard';
        btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
            <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
        </svg>`;
        btn.addEventListener('click', () => copyText(btn, messageDiv));
        return btn;
    }

    // ── Render Chat Messages ───────────────────────────────────────────────
    function appendMessage(role, text, streaming = false) {
        const messagesEl = el('aiChatMessages');
        if (!messagesEl) return null;

        const div = document.createElement('div');
        div.className = `ai-message ai-message-${role}`;

        if (role === 'assistant') {
            div.innerHTML = `
                <div class="ai-message-icon">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm5.5-2.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 1 .5-.5zM8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
                    </svg>
                </div>
                <div class="ai-message-content ${streaming ? 'ai-streaming' : ''}" id="ai-streaming-target">
                    <p class="ai-p">${streaming ? '<span class="ai-cursor">▋</span>' : renderMarkdown(text)}</p>
                </div>`;
            if (!streaming) {
                div.appendChild(makeCopyBtn(div));
            }
        } else {
            div.innerHTML = `
                <div class="ai-message-content">
                    <p class="ai-p">${escapeHtml(text)}</p>
                </div>`;
        }

        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
    }

    function updateStreamingMessage(div, text) {
        const contentEl = div.querySelector('#ai-streaming-target');
        if (contentEl) {
            contentEl.innerHTML = `<p class="ai-p">${renderMarkdown(text)}</p>`;
            contentEl.classList.remove('ai-streaming');
            div.appendChild(makeCopyBtn(div));
        }
        el('aiChatMessages').scrollTop = el('aiChatMessages').scrollHeight;
    }

    function showTypingIndicator() {
        const messagesEl = el('aiChatMessages');
        const div = document.createElement('div');
        div.className = 'ai-message ai-message-assistant ai-typing-indicator';
        div.id = 'aiTypingIndicator';
        div.innerHTML = `
            <div class="ai-message-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z"/>
                </svg>
            </div>
            <div class="ai-message-content">
                <div class="ai-dots"><span></span><span></span><span></span></div>
            </div>`;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function removeTypingIndicator() {
        const ind = el('aiTypingIndicator');
        if (ind) ind.remove();
    }

    // ── Send Message ───────────────────────────────────────────────────────
    async function sendMessage(prompt, quickActionContext = null) {
        if (isStreaming) return;

        const input = el('aiChatInput');
        const userText = prompt || input?.value?.trim();
        if (!userText) return;

        if (input && !prompt) input.value = '';

        isStreaming = true;
        updateSendBtn(true);

        appendMessage('user', userText);

        // Build context string
        let contextStr = '';
        if (quickActionContext) {
            contextStr = quickActionContext;
        } else if (currentContext) {
            contextStr = currentContext.contextStr || '';
        }

        showTypingIndicator();

        try {
            const reply = await callClaude(userText, contextStr);
            removeTypingIndicator();
            appendMessage('assistant', reply);
        } catch (err) {
            removeTypingIndicator();
            appendMessage('assistant', `⚠️ Error: ${err.message}. Please check your API key in settings.`);
        } finally {
            isStreaming = false;
            updateSendBtn(false);
            if (input) input.focus();
        }
    }

    function updateSendBtn(loading) {
        const btn = el('aiSendBtn');
        if (!btn) return;
        btn.disabled = loading;
        btn.innerHTML = loading
            ? `<svg class="ai-spin" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 0 1 7 7h-1a6 6 0 1 0-6 6v1a7 7 0 0 1 0-14z"/></svg>`
            : `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11zM6.636 10.07l2.761 4.338L14.13 2.576 6.636 10.07zm6.787-8.201L1.591 6.602l4.339 2.76 7.494-7.493z"/></svg>`;
    }

    // ── Set Context (called from popup.js) ────────────────────────────────
    function setIssueContext(issue) {
        const contextStr = buildIssueContext(issue);
        currentContext = { type: 'issue', data: issue, contextStr };
        updateContextBadge('issue', issue?.title);
    }

    function setProjectContext(project) {
        const contextStr = buildProjectContext(project);
        currentContext = { type: 'project', data: project, contextStr };
        updateContextBadge('project', project?.title);
    }

    function setGistContext(gist) {
        const contextStr = buildGistContext(gist);
        currentContext = { type: 'gist', data: gist, contextStr };
        updateContextBadge('gist', gist?.description || 'Untitled Gist');
    }

    function clearContext() {
        currentContext = null;
        updateContextBadge(null, null);
    }

    function updateContextBadge(type, label) {
        const badge = el('aiContextBadge');
        if (!badge) return;
        if (!type) {
            badge.innerHTML = '<span class="ai-ctx-empty">No context — select an issue, project, or gist</span>';
            badge.className = 'ai-context-badge ai-ctx-none';
            return;
        }
        const icons = {
            issue: '◉',
            project: '▦',
            gist: '≡'
        };
        const colors = {
            issue: 'ai-ctx-issue',
            project: 'ai-ctx-project',
            gist: 'ai-ctx-gist'
        };
        badge.className = `ai-context-badge ${colors[type]}`;
        badge.innerHTML = `
            <span class="ai-ctx-icon">${icons[type]}</span>
            <span class="ai-ctx-type">${type}</span>
            <span class="ai-ctx-label" title="${escapeHtml(label || '')}">${escapeHtml((label || '').slice(0, 35))}${(label || '').length > 35 ? '…' : ''}</span>`;
        const clearBtn = document.createElement('button');
        clearBtn.className = 'ai-ctx-clear';
        clearBtn.title = 'Clear context';
        clearBtn.textContent = '×';
        clearBtn.addEventListener('click', clearContext);
        badge.appendChild(clearBtn);
    }

    // ── Panel Toggle ───────────────────────────────────────────────────────
    function openPanel() {
        aiPanelOpen = true;
        const panel = el('aiAssistPanel');
        const overlay = el('aiPanelOverlay');
        if (panel) panel.classList.add('ai-panel-open');
        if (overlay) overlay.classList.add('ai-overlay-visible');

        // Show welcome message if empty
        const msgs = el('aiChatMessages');
        if (msgs && msgs.children.length === 0) {
            showWelcome();
        }
        el('aiChatInput')?.focus();
    }

    function closePanel() {
        aiPanelOpen = false;
        const panel = el('aiAssistPanel');
        const overlay = el('aiPanelOverlay');
        if (panel) panel.classList.remove('ai-panel-open');
        if (overlay) overlay.classList.remove('ai-overlay-visible');
    }

    function togglePanel() {
        aiPanelOpen ? closePanel() : openPanel();
    }

    function showWelcome() {
        const msgs = el('aiChatMessages');
        if (!msgs) return;
        const div = document.createElement('div');
        div.className = 'ai-welcome';
        div.innerHTML = `
            <div class="ai-welcome-icon">
                <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6 12.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5ZM3 8.062C3 6.76 4.235 5.765 5.53 5.886a26.58 26.58 0 0 0 4.94 0C11.765 5.765 13 6.76 13 8.062v1.157a.933.933 0 0 1-.765.935c-.845.147-2.34.346-4.235.346-1.895 0-3.39-.2-4.235-.346A.933.933 0 0 1 3 9.219V8.062Zm4.542-.827a.25.25 0 0 0-.217.065l-.092.092a.25.25 0 0 0 .177.427h.498a.25.25 0 0 0 .177-.427l-.092-.092a.25.25 0 0 0-.451-.065ZM11 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM5 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
                    <path d="M0 6.5C0 5.12 1.12 4 2.5 4h.025C2.51 3.978 2.5 3.955 2.5 3.5c0-1.38 1.12-2.5 2.5-2.5h2a.5.5 0 0 1 0 1h-2C4.122 2 3.5 2.622 3.5 3.5c0 .476.217.894.556 1.172A4.56 4.56 0 0 0 2.5 5C1.672 5 1 5.672 1 6.5v1a.5.5 0 0 1-1 0v-1ZM14.975 4H15c.828 0 1.5.672 1.5 1.5v1a.5.5 0 0 1-1 0v-1c0-.828-.672-1.5-1.5-1.5-.41 0-.781.164-1.055.43.339-.278.555-.696.555-1.172C13.5 2.622 12.878 2 12 2h-2a.5.5 0 0 1 0-1h2C13.38 1 14.5 2.12 14.5 3.5c0 .455-.01.478-.025.5h.5Z"/>
                </svg>
            </div>
            <div class="ai-welcome-text">
                <strong>AI Assistant</strong>
                <p>Select an issue, project, or gist — then ask me anything, or use a quick action below.</p>
            </div>`;
        msgs.appendChild(div);
    }

    // ── Quick Action Handler ───────────────────────────────────────────────
    function runQuickAction(actionId) {
        const action = QUICK_ACTIONS.find(a => a.id === actionId);
        if (!action) return;

        if (action.requiresContext && !currentContext) {
            // Prompt user to select context first
            const msgs = el('aiChatMessages');
            const note = document.createElement('div');
            note.className = 'ai-system-note';
            note.textContent = '⚠ Please select an issue, project, or gist first to use this action.';
            msgs.appendChild(note);
            msgs.scrollTop = msgs.scrollHeight;
            setTimeout(() => note.remove(), 3000);
            return;
        }

        const contextStr = currentContext?.contextStr || '';
        sendMessage(action.prompt, contextStr);
    }

    // ── Copy helper ────────────────────────────────────────────────────────
    function copyText(btn, messageDiv) {
        const content = (messageDiv || btn.closest('.ai-message'))?.querySelector('.ai-message-content');
        if (!content) return;
        const text = content.innerText || content.textContent;
        navigator.clipboard.writeText(text).then(() => {
            btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M10.97 4.97a.75.75 0 0 1 1.07 1.05l-3.99 4.99a.75.75 0 0 1-1.08.02L4.324 8.384a.75.75 0 1 1 1.06-1.06l2.094 2.093 3.473-4.425z"/></svg>`;
            setTimeout(() => {
                btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;
            }, 1500);
        });
    }

    // ── Clear Chat ─────────────────────────────────────────────────────────
    function clearChat() {
        aiChatHistory = [];
        const msgs = el('aiChatMessages');
        if (msgs) msgs.innerHTML = '';
        showWelcome();
    }

    // ── Render Quick Actions Bar ───────────────────────────────────────────
    function renderQuickActions() {
        const container = el('aiQuickActions');
        if (!container) return;
        container.innerHTML = '';
        QUICK_ACTIONS.forEach(a => {
            const btn = document.createElement('button');
            btn.className = 'ai-quick-btn';
            btn.title = a.label;
            btn.textContent = a.label;
            btn.addEventListener('click', () => runQuickAction(a.id));
            container.appendChild(btn);
        });
    }

    // ── Init ───────────────────────────────────────────────────────────────
    function init() {
        // Bind toggle button
        const toggleBtn = el('aiAssistToggleBtn');
        if (toggleBtn) toggleBtn.addEventListener('click', togglePanel);

        // Bind close button
        const closeBtn = el('aiPanelClose');
        if (closeBtn) closeBtn.addEventListener('click', closePanel);

        // Bind overlay
        const overlay = el('aiPanelOverlay');
        if (overlay) overlay.addEventListener('click', closePanel);

        // Bind send button
        const sendBtn = el('aiSendBtn');
        if (sendBtn) sendBtn.addEventListener('click', () => sendMessage());

        // Bind input enter key
        const input = el('aiChatInput');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });
            // Auto-resize
            input.addEventListener('input', () => {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 90) + 'px';
            });
        }

        // Bind clear button
        const clearBtn = el('aiClearChatBtn');
        if (clearBtn) clearBtn.addEventListener('click', clearChat);

        // Render quick actions
        renderQuickActions();

        // Init context badge
        updateContextBadge(null, null);
    }

    // ── Public API ─────────────────────────────────────────────────────────
    return {
        init,
        openPanel,
        closePanel,
        togglePanel,
        setIssueContext,
        setProjectContext,
        setGistContext,
        clearContext,
        runQuickAction,
        copyText,
        clearChat,
        sendMessage: (text) => sendMessage(text)
    };
})();

// Auto-init when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AI_ASSIST.init());
} else {
    AI_ASSIST.init();
}