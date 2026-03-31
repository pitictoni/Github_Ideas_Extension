import { getStoredToken, storeToken, clearStoredToken, authenticateWithGitHub } from './auth.js';
import { fetchGitHubUser } from './api.js';
import { attachBenchmarkUIHandlers, autoStartBenchmark, cancelBenchmarkTask, completeBenchmarkTask } from './benchmark.js';
import { showStatus, openModal, closeModal, confirmDeleteAction } from './ui.js';
import { state } from './state.js';

import {
    loadGists, displayGistPreview, hideGistPreview,
    openCreateGistModal, saveGist,
    openFileEditorModal, saveFileChanges, loadSelectedFile,
    openAddFileModal, saveNewFile,
    deleteCurrentGist, deleteCurrentFile,
    openRenameGistModal, renameGist,
    openRenameFileModal, renameFile
} from './gists.js';

import {
    loadProjects, loadProjectIssues, hideProjectIssues,
    loadRepoIssues, populateRepoOptgroup, showRepoIssueActionsMenu,
    openChooseAddTypeModal, openAddDraftModal, addDraftToProject,
    openAddIssueModal, addIssueToProject,
    openConvertDraftModal, convertDraftToIssue,
    openMoveToProjectModal, moveToProject,
    openRenameProjectModal, renameProject,
    openEditProjectModal, saveProjectEdits,
    openCreateProjectModal, createNewProject,
    deleteCurrentProject,
    openEditIssueModal, saveIssueEdits
} from './projects.js';

import {
    initQuickCapture, openInboxSetupModal, saveInboxSetup, quickCaptureSave
} from './quickcapture.js';


document.addEventListener('DOMContentLoaded', async () => {

    // Popout mode
    if (new URLSearchParams(window.location.search).get('popout') === 'true') {
        document.body.classList.add('popout');
    }

    // Register benchmark click/change/input tracking
    attachBenchmarkUIHandlers();

    // ── Quick Capture ─────────────────────────────────────────────────────────
    const qcTextarea = document.getElementById('qcTextarea');
    qcTextarea.addEventListener('input', () => {
        qcTextarea.style.height = 'auto';
        qcTextarea.style.height = Math.min(qcTextarea.scrollHeight, 90) + 'px';
    });
    qcTextarea.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { 
            e.preventDefault(); 
            quickCaptureSave(); 
        }
    });
    document.getElementById('qcSaveBtn').addEventListener('click', quickCaptureSave);
    document.getElementById('qcInboxName').addEventListener('click', openInboxSetupModal);
    document.getElementById('closeInboxSetupModal').addEventListener('click', () => closeModal('inboxSetupModal'));
    document.getElementById('cancelInboxSetup').addEventListener('click', () => closeModal('inboxSetupModal'));
    document.getElementById('confirmInboxSetup').addEventListener('click', saveInboxSetup);

    // ── Popout button ─────────────────────────────────────────────────────────
    document.getElementById('popoutBtn').addEventListener('click', () => {
        const width = 800, height = 700;
        chrome.windows.create({
            url: chrome.runtime.getURL('popup.html?popout=true'),
            type: 'popup', width, height,
            left: Math.round((screen.width - width) / 2),
            top: Math.round((screen.height - height) / 2)
        });
        window.close();
    });

    // ── Login / Logout ────────────────────────────────────────────────────────
    document.getElementById('loginBtn').addEventListener('click', async () => {
        const loginBtn = document.getElementById('loginBtn');
        loginBtn.disabled = true;
        loginBtn.textContent = 'Logging in...';
        try {
            const tokenData = await authenticateWithGitHub();
            await storeToken(tokenData);
            const userData = await fetchGitHubUser(tokenData.access_token);
            showMainView(userData);
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

    // ── Tabs ──────────────────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab + 'Tab').classList.add('active');
        });
    });

    // ── Gist select ───────────────────────────────────────────────────────────
    document.getElementById('gistSelect').addEventListener('change', async e => {
        const gistId = e.target.value;
        if (!gistId) { 
            hideGistPreview(); 
            return; 
        }
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { 
            showStatus('Not authenticated', 'error'); 
            return; 
        }
        const { fetchGistById } = await import('./api.js');
        displayGistPreview(await fetchGistById(tokenData.access_token, gistId));
    });

    document.getElementById('refreshGistsBtn').addEventListener('click', async () => {
        const btn = document.getElementById('refreshGistsBtn');
        btn.disabled = true;
        try { 
            await loadGists(); 
            showStatus('Gists refreshed successfully', 'success'); 
        }
        catch (e) { 
            showStatus('Failed to refresh gists', 'error'); 
        }
        finally { 
            btn.disabled = false; 
        }
    });

    // ── Gist action buttons ───────────────────────────────────────────────────
    document.getElementById('createNewGistBtn').addEventListener('click', () => {
        state.currentGist = null;
        autoStartBenchmark('create_gist');
        openCreateGistModal();
    });
    document.getElementById('editGistBtn').addEventListener('click', openFileEditorModal);
    document.getElementById('addFileBtn').addEventListener('click', () => {
        autoStartBenchmark('add_gist_file');
        openAddFileModal();
    });
    document.getElementById('renameGistBtn').addEventListener('click', () => {
        autoStartBenchmark('rename_gist');
        openRenameGistModal();
    });
    document.getElementById('deleteGistBtn').addEventListener('click', () => {
        autoStartBenchmark('delete_gist');
        deleteCurrentGist();
    });

    // ── Gist editor modal ─────────────────────────────────────────────────────
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

    // ── Add file modal ────────────────────────────────────────────────────────
    document.getElementById('closeAddFileModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('add_gist_file', 'close_add_file_modal');
        closeModal('addFileModal');
    });
    document.getElementById('cancelAddFile').addEventListener('click', async () => {
        await cancelBenchmarkTask('add_gist_file', 'cancel_add_file_modal');
        closeModal('addFileModal');
    });
    document.getElementById('saveNewFile').addEventListener('click', saveNewFile);

    // ── File editor modal ─────────────────────────────────────────────────────
    document.getElementById('closeFileEditorModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('edit_gist', 'close_file_editor_modal');
        await cancelBenchmarkTask('rename_gist_file', 'close_file_editor_modal');
        await cancelBenchmarkTask('delete_gist_file', 'close_file_editor_modal');
        closeModal('fileEditorModal');
    });
    document.getElementById('cancelFileEditor').addEventListener('click', async () => {
        await cancelBenchmarkTask('edit_gist', 'cancel_file_editor_modal');
        await cancelBenchmarkTask('rename_gist_file', 'cancel_file_editor_modal');
        await cancelBenchmarkTask('delete_gist_file', 'cancel_file_editor_modal');
        closeModal('fileEditorModal');
    });
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

    // ── Delete confirm modal ──────────────────────────────────────────────────
    document.getElementById('closeDeleteConfirmModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('delete_gist', 'close_delete_confirm_modal');
        await cancelBenchmarkTask('delete_gist_file', 'close_delete_confirm_modal');
        await cancelBenchmarkTask('delete_repo_issue', 'close_delete_confirm_modal');
        closeModal('deleteConfirmModal');
    });
    document.getElementById('cancelDelete').addEventListener('click', async () => {
        await cancelBenchmarkTask('delete_gist', 'cancel_delete_confirm_modal');
        await cancelBenchmarkTask('delete_gist_file', 'cancel_delete_confirm_modal');
        await cancelBenchmarkTask('delete_repo_issue', 'cancel_delete_confirm_modal');
        closeModal('deleteConfirmModal');
    });
    document.getElementById('confirmDelete').addEventListener('click', confirmDeleteAction);

    // ── Rename gist modal ─────────────────────────────────────────────────────
    document.getElementById('closeRenameGistModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist', 'close_rename_gist_modal');
        closeModal('renameGistModal');
    });
    document.getElementById('cancelRenameGist').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist', 'cancel_rename_gist_modal');
        closeModal('renameGistModal');
    });
    document.getElementById('confirmRenameGist').addEventListener('click', renameGist);

    // ── Rename file modal ─────────────────────────────────────────────────────
    document.getElementById('closeRenameFileModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist_file', 'close_rename_file_modal');
        closeModal('renameFileModal');
    });
    document.getElementById('cancelRenameFile').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_gist_file', 'cancel_rename_file_modal');
        closeModal('renameFileModal');
    });
    document.getElementById('confirmRenameFile').addEventListener('click', renameFile);

    // ── Project / Repo unified select ─────────────────────────────────────────
    document.getElementById('unifiedSelect').addEventListener('change', async e => {
        const val = e.target.value;
        if (!val) { 
            hideProjectIssues(); 
            return; 
        }
        if (val.startsWith('project:')) {
            state.currentMode = 'project';
            await loadProjectIssues(val.slice('project:'.length));
        } else if (val.startsWith('repo:')) {
            state.currentMode = 'repo';
            await loadRepoIssues(val.slice('repo:'.length));
        }
    });

    document.getElementById('refreshProjectsBtn').addEventListener('click', async () => {
        const btn = document.getElementById('refreshProjectsBtn');
        btn.disabled = true;
        try {
            if (state.currentMode === 'repo' && state.currentRepoFullName) {
                await loadRepoIssues(state.currentRepoFullName);
                showStatus('Issues refreshed', 'success');
            } else {
                await loadProjects();
                showStatus('Projects refreshed successfully', 'success');
            }
        } 
        catch { 
            showStatus('Failed to refresh', 'error'); 
        }
        finally { 
            btn.disabled = false; 
        }
    });

    // ── Repo state tabs ───────────────────────────────────────────────────────
    document.querySelectorAll('.repo-state-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            document.querySelectorAll('.repo-state-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.currentRepoIssueState = tab.dataset.state;
            if (state.currentRepoFullName) await loadRepoIssues(state.currentRepoFullName);
        });
    });

    // ── New repo issue modal ──────────────────────────────────────────────────
    document.getElementById('newRepoIssueBtn').addEventListener('click', () => {
        if (!state.currentRepoFullName) return;
        autoStartBenchmark('create_repo_issue');
        document.getElementById('newIssueRepoName').textContent = state.currentRepoFullName;
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
    document.getElementById('newRepoIssueModal').addEventListener('click', e => {
        if (e.target === e.currentTarget) 
            e.currentTarget.style.display = 'none';
    });
    document.getElementById('submitNewRepoIssue').addEventListener('click', async () => {
        const title = document.getElementById('newIssueTitle').value.trim();
        const body = document.getElementById('newIssueBody').value.trim();
        if (!title) { 
            showStatus('Title is required', 'error'); 
            return; 
        }
        const btn = document.getElementById('submitNewRepoIssue');
        btn.disabled = true;
        btn.textContent = 'Creating...';
        try {
            const tokenData = await getStoredToken();
            const [owner, repo] = state.currentRepoFullName.split('/');
            const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${tokenData.access_token}`, 
                    'Accept': 'application/vnd.github+json', 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ title, body: body || undefined })
            });
            if (!res.ok) {
                throw new Error((await res.json()).message || 'Failed');
            }
            const issue = await res.json();
            document.getElementById('newRepoIssueModal').style.display = 'none';
            showStatus(`Issue #${issue.number} created`, 'success');
            await loadRepoIssues(state.currentRepoFullName);
            await completeBenchmarkTask('create_repo_issue');
        } catch (err) {
            showStatus('Failed to create issue: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2Z" /></svg> Create Issue';
        }
    });

    // ── Project action buttons ────────────────────────────────────────────────
    document.getElementById('createNewProjectBtn').addEventListener('click', () => {
        autoStartBenchmark('create_project');
        openCreateProjectModal();
    });
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
    document.getElementById('viewProjectBtn').addEventListener('click', () => {
        if (state.currentProject) window.open(state.currentProject.url, '_blank');
    });

    // ── Choose add type modal ─────────────────────────────────────────────────
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

    // ── Add issue modal ───────────────────────────────────────────────────────
    document.getElementById('closeAddIssueModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_issue', 'close_add_issue_modal');
        closeModal('addIssueModal');
    });
    document.getElementById('cancelAddIssue').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_issue', 'cancel_add_issue_modal');
        closeModal('addIssueModal');
    });
    document.getElementById('confirmAddIssue').addEventListener('click', addIssueToProject);

    // ── Add draft modal ───────────────────────────────────────────────────────
    document.getElementById('closeAddDraftModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_draft', 'close_add_draft_modal');
        closeModal('addDraftModal');
    });
    document.getElementById('cancelAddDraft').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project_draft', 'cancel_add_draft_modal');
        closeModal('addDraftModal');
    });
    document.getElementById('confirmAddDraft').addEventListener('click', addDraftToProject);

    // ── Convert draft modal ───────────────────────────────────────────────────
    document.getElementById('closeConvertDraftModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('convert_draft_to_issue', 'close_convert_draft_modal');
        closeModal('convertDraftModal');
    });
    document.getElementById('cancelConvertDraft').addEventListener('click', async () => {
        await cancelBenchmarkTask('convert_draft_to_issue', 'cancel_convert_draft_modal');
        closeModal('convertDraftModal');
    });
    document.getElementById('confirmConvertDraft').addEventListener('click', convertDraftToIssue);

    // ── Move to project modal ─────────────────────────────────────────────────
    document.getElementById('closeMoveToProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('move_item_to_project', 'close_move_to_project_modal');
        closeModal('moveToProjectModal');
    });
    document.getElementById('cancelMoveToProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('move_item_to_project', 'cancel_move_to_project_modal');
        closeModal('moveToProjectModal');
    });
    document.getElementById('confirmMoveToProject').addEventListener('click', moveToProject);

    // ── Rename project modal ──────────────────────────────────────────────────
    document.getElementById('closeRenameProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_project', 'close_rename_project_modal');
        closeModal('renameProjectModal');
    });
    document.getElementById('cancelRenameProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('rename_project', 'cancel_rename_project_modal');
        closeModal('renameProjectModal');
    });
    document.getElementById('confirmRenameProject').addEventListener('click', renameProject);

    // ── Edit project modal ────────────────────────────────────────────────────
    document.getElementById('closeEditProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('edit_project_settings', 'close_edit_project_modal');
        closeModal('editProjectModal');
    });
    document.getElementById('cancelEditProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('edit_project_settings', 'cancel_edit_project_modal');
        closeModal('editProjectModal');
    });
    document.getElementById('confirmEditProject').addEventListener('click', saveProjectEdits);

    // ── Create project modal ──────────────────────────────────────────────────
    document.getElementById('closeCreateProjectModal').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project', 'close_create_project_modal');
        closeModal('createProjectModal');
    });
    document.getElementById('cancelCreateProject').addEventListener('click', async () => {
        await cancelBenchmarkTask('create_project', 'cancel_create_project_modal');
        closeModal('createProjectModal');
    });
    document.getElementById('confirmCreateProject').addEventListener('click', createNewProject);

    // ── Edit issue modal ──────────────────────────────────────────────────────
    document.getElementById('closeEditIssueModal').addEventListener('click', () => closeModal('editIssueModal'));
    document.getElementById('cancelEditIssue').addEventListener('click', () => closeModal('editIssueModal'));
    document.getElementById('confirmEditIssue').addEventListener('click', saveIssueEdits);

    // ── Close modals on overlay click ─────────────────────────────────────────
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                overlay.style.display = 'none';
                document.getElementById('gistFilename').disabled = false;
            }
        });
    });

    // ── Check for existing auth on load ───────────────────────────────────────
    const tokenData = await getStoredToken();
    if (tokenData?.access_token) {
        try {
            const userData = await fetchGitHubUser(tokenData.access_token);
            showMainView(userData);
            await loadGists();
            await loadProjects();
            await initQuickCapture();
        } catch (error) {
            console.error('Error loading user data:', error);
            await clearStoredToken();
        }
    }
});

// ============================================================================
// Helper
// ============================================================================

function showMainView(userData) {
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('mainView').classList.remove('hidden');
    document.getElementById('userAvatar').src = userData.avatar_url;
    document.getElementById('avatarWrapper').style.display = 'block';
}
