import { state } from './state.js';
import { getStoredToken } from './auth.js';
import { fetchViewerId, createProject, addDraftIssue, invalidateProjectCache } from './api.js';
import { showStatus, openModal, closeModal } from './ui.js';
import { loadProjects, loadProjectIssues } from './projects.js';

// ============================================================================
// Quick Capture — Inbox Project
// ============================================================================

export async function getInboxProject() {
    const result = await chrome.storage.local.get([state.INBOX_STORAGE_KEY]);
    return result[state.INBOX_STORAGE_KEY] || null;
}

export async function setInboxProject(id, title) {
    await chrome.storage.local.set({ [state.INBOX_STORAGE_KEY]: { id, title } });
}

export async function initQuickCapture() {
    const inbox = await getInboxProject();
    const label = document.getElementById('qcInboxLabel');

    if (inbox) {
        // Verify stored title is still accurate — project may have been renamed
        if (state.allProjects?.data) {
            const live = state.allProjects.data.viewer.projectsV2.nodes.find(p => p.id === inbox.id);
            if (live && live.title !== inbox.title) {
                await setInboxProject(inbox.id, live.title);
                inbox.title = live.title;
            }
        }
        label.textContent = inbox.title;
    } else {
        label.textContent = 'Set inbox →';
        const result2 = await chrome.storage.local.get(['quickCaptureEnabled']);
        const enabled = result2.quickCaptureEnabled !== false;
        if (enabled) setTimeout(() => openInboxSetupModal(), 600);
    }

    const result = await chrome.storage.local.get(['quickCaptureEnabled']);
    const enabled = result.quickCaptureEnabled !== false;
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

export function openInboxSetupModal() {
    const sel = document.getElementById('inboxProjectSelect');
    sel.innerHTML = '<option value="" disabled selected>Choose a project...</option>';

    if (state.allProjects?.data) {
        state.allProjects.data.viewer.projectsV2.nodes.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.title;
            sel.appendChild(opt);
        });
    }

    document.getElementById('inboxNewProjectName').value = '';
    openModal('inboxSetupModal');
}

export async function saveInboxSetup() {
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
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }

        let inboxId, inboxTitle;

        if (newName) {
            const ownerId = await fetchViewerId(tokenData.access_token);
            const project = await createProject(tokenData.access_token, ownerId, newName);
            inboxId = project.id;
            inboxTitle = project.title;
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

export async function quickCaptureSave() {
    const textarea = document.getElementById('qcTextarea');
    const text = textarea.value.trim();

    if (!text) { textarea.focus(); return; }

    const inbox = await getInboxProject();
    if (!inbox) { openInboxSetupModal(); return; }

    const saveBtn = document.getElementById('qcSaveBtn');
    saveBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }

        await addDraftIssue(tokenData.access_token, inbox.id, text);

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

        if (state.currentProject && state.currentProject.id === inbox.id) {
            invalidateProjectCache(inbox.id);
            await loadProjectIssues(inbox.id);
        }

    } catch (err) {
        console.error('Quick capture error:', err);

        const isGone = err.message && (
            err.message.toLowerCase().includes('could not resolve to a node') ||
            err.message.toLowerCase().includes('not found') ||
            err.message.toLowerCase().includes('does not exist')
        );

        if (isGone) {
            await chrome.storage.local.remove([state.INBOX_STORAGE_KEY]);
            document.getElementById('qcInboxLabel').textContent = 'Set inbox →';
            showStatus('Inbox project was deleted — please set a new one', 'error');
            setTimeout(() => openInboxSetupModal(), 800);
        } else {
            showStatus('Failed to save: ' + err.message, 'error');
        }

        saveBtn.disabled = false;
    }
}