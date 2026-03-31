import { state } from './state.js';
import { getStoredToken } from './auth.js';
import { fetchProjects, fetchProjectItems, fetchUserRepositories, invalidateProjectCache, gql } from './api.js';
import { showStatus, openModal, closeModal, githubColorToCSS, extractFieldDefinitions } from './ui.js';
import { autoStartBenchmark, completeBenchmarkTask, cancelBenchmarkTask } from './benchmark.js';

// ============================================================================
// Projects
// ============================================================================

export async function loadProjects() {
    const tokenData = await getStoredToken();
    if (!tokenData?.access_token) return;

    try {
        state.allProjects = await fetchProjects(tokenData.access_token);
        if (state.allProjects.length === 0) { showStatus('No projects found', 'info'); return; }

        const unifiedSelect = document.getElementById('unifiedSelect');
        const existingRepoGroup = unifiedSelect.querySelector('optgroup[data-type="repo"]');
        unifiedSelect.innerHTML = '<option value="" disabled selected>Select a project or repository...</option>';

        const projectGroup = document.createElement('optgroup');
        projectGroup.label = 'Projects';
        projectGroup.dataset.type = 'project';

        state.allProjects.data.viewer.projectsV2.nodes.forEach(project => {
            state.projectFieldDefinitions[project.id] = extractFieldDefinitions(project);
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

export async function loadProjectIssues(projectId) {
    const tokenData = await getStoredToken();
    if (!tokenData?.access_token) return;

    try {
        const project = state.allProjects.data.viewer.projectsV2.nodes.find(p => p.id === projectId);
        if (!project) return;

        state.currentProject = project;
        document.getElementById('repoIssuesSection').style.display = 'none';
        document.getElementById('projectTitle').textContent = project.title;

        const repoSubtitle = document.getElementById('projectRepoSubtitle');
        const linkedRepos = project.repositories?.nodes?.filter(r => r.nameWithOwner) || [];
        if (linkedRepos.length > 0) {
            repoSubtitle.textContent = linkedRepos.map(r => r.nameWithOwner).join(', ');
            repoSubtitle.style.display = 'inline-flex';
        } else {
            repoSubtitle.textContent = '';
            repoSubtitle.style.display = 'none';
        }

        document.getElementById('viewProjectBtn').onclick = () => window.open(project.url, '_blank');

        const items = await fetchProjectItems(tokenData.access_token, projectId);
        const allCards = [];

        items.forEach(item => {
            if (!item.content) return;
            let statusName = 'No Status', statusColor = null;
            item.fieldValues.nodes.forEach(fv => {
                if (fv.field?.name === 'Status' && fv.name) { statusName = fv.name; statusColor = fv.color; }
            });
            allCards.push({
                itemId: item.id,
                title: item.content.title,
                body: item.content.body || '',
                status: statusName,
                statusColor,
                url: item.content.url,
                state: item.content.state || 'open',
                type: item.type,
                labels: item.content.labels?.nodes || [],
                assignees: item.content.assignees?.nodes || [],
                repository: item.content.repository?.nameWithOwner || 'Unknown'
            });
        });

        displayProjectIssues(allCards);

    } catch (error) {
        console.error('Error loading project issues:', error);
        showStatus('Failed to load project issues', 'error');
    }
}

export function displayProjectIssues(issues) {
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
            const cssColor = issue.statusColor ? githubColorToCSS(issue.statusColor) : '#6b7280';

            const statusBadge = `
                <span class="issue-status clickable-status" style="background-color:${cssColor}15;color:${cssColor};border:1px solid ${cssColor}30;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer;transition:all 0.2s;position:relative;"
                    data-item-id="${issue.itemId}" data-current-status="${issue.status}">
                    <span style="width:8px;height:8px;border-radius:50%;background-color:${cssColor};display:inline-block;"></span>
                    ${issue.status}
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                </span>`;

            const actionsBtn = `<button class="issue-actions-btn"
                data-issue-id="${issue.itemId}"
                data-issue-url="${issue.url || ''}"
                data-issue-title="${issue.title}"
                data-issue-body="${encodeURIComponent(issue.body || '')}"
                data-issue-type="${issue.type === 'DRAFT_ISSUE' ? 'DRAFT' : 'ISSUE'}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>
            </button>`;

            if (issue.type === 'DRAFT_ISSUE') {
                row.innerHTML = `<td><a class="issue-title" style="text-decoration:none;color:var(--text-primary);">${issue.title}</a></td><td>${statusBadge}</td><td class="issue-actions-cell">${actionsBtn}</td>`;
            } else {
                row.innerHTML = `<td>
                    <a href="${issue.url}" target="_blank" class="issue-title" style="text-decoration:none;color:var(--text-primary);">${issue.title}</a>
                    ${issue.repository ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:4px;">${issue.repository}</div>` : ''}
                </td><td>${statusBadge}</td><td class="issue-actions-cell">${actionsBtn}</td>`;
            }

            tableBody.appendChild(row);
        });

        tableBody.querySelectorAll('.clickable-status').forEach(badge => {
            badge.addEventListener('click', e => {
                e.stopPropagation();
                showStatusDropdown(e.currentTarget, e.currentTarget.dataset.itemId, e.currentTarget.dataset.currentStatus);
            });
            badge.addEventListener('mouseenter', e => e.currentTarget.style.transform = 'scale(1.05)');
            badge.addEventListener('mouseleave', e => e.currentTarget.style.transform = 'scale(1)');
        });

        tableBody.querySelectorAll('.issue-actions-btn').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); showIssueActionsMenu(e.currentTarget); });
        });
    }

    issuesSection.style.display = 'block';
}

export function hideProjectIssues() {
    document.getElementById('projectIssuesSection').style.display = 'none';
    document.getElementById('repoIssuesSection').style.display = 'none';
    state.currentProject = null;
}

// ============================================================================
// Repo Issues
// ============================================================================

export async function loadRepoIssues(repoFullName, issueState) {
    if (!repoFullName) return;
    state.currentRepoFullName = repoFullName;
    if (issueState) state.currentRepoIssueState = issueState;

    const tokenData = await getStoredToken();
    if (!tokenData?.access_token) return;

    document.getElementById('projectIssuesSection').style.display = 'none';
    document.getElementById('projectRepoSubtitle').style.display = 'none';
    const issuesSection = document.getElementById('repoIssuesSection');
    const tableBody = document.getElementById('repoIssuesTableBody');
    const emptyState = document.getElementById('emptyRepoIssuesState');

    document.getElementById('repoTitle').textContent = repoFullName;
    document.getElementById('viewRepoBtn').onclick = () => window.open(`https://github.com/${repoFullName}`, '_blank');

    document.querySelectorAll('.repo-state-tab').forEach(t => t.classList.toggle('active', t.dataset.state === state.currentRepoIssueState));

    issuesSection.style.display = 'block';
    tableBody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text-secondary);font-size:13px;">Loading...</td></tr>';
    tableBody.parentElement.style.display = 'table';
    emptyState.style.display = 'none';

    try {
        const [owner, repo] = repoFullName.split('/');
        const response = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/issues?state=${state.currentRepoIssueState}&per_page=100&sort=updated`,
            { headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github+json' } }
        );
        if (!response.ok) throw new Error('Failed to fetch issues');
        const allIssues = (await response.json()).filter(i => !i.pull_request);

        tableBody.innerHTML = '';

        if (allIssues.length === 0) {
            tableBody.parentElement.style.display = 'none';
            emptyState.style.display = 'block';
            emptyState.querySelector('p').textContent = `No ${state.currentRepoIssueState === 'all' ? '' : state.currentRepoIssueState + ' '}issues in this repository`;
            return;
        }

        allIssues.forEach(issue => {
            const isOpen = issue.state === 'open';
            const dotColor = isOpen ? '#22c55e' : '#a855f7';
            const stateBadge = `<span class="repo-state-badge" style="background:${dotColor}15;color:${dotColor};border:1px solid ${dotColor}30;"><span class="state-dot" style="background:${dotColor};"></span>${issue.state}</span>`;

            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <a href="${issue.html_url}" target="_blank" class="issue-title" style="text-decoration:none;color:var(--text-primary);">${issue.title} #${issue.number}</a>
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
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>
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

export async function populateRepoOptgroup(select) {
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) return;
        if (state.userRepositories.length === 0) state.userRepositories = await fetchUserRepositories(tokenData.access_token);
        const repoGroup = document.createElement('optgroup');
        repoGroup.label = 'Repositories';
        repoGroup.dataset.type = 'repo';
        state.userRepositories.forEach(repo => {
            const opt = document.createElement('option');
            opt.value = 'repo:' + repo.full_name;
            opt.textContent = repo.full_name;
            repoGroup.appendChild(opt);
        });
        select.appendChild(repoGroup);
    } catch (e) { console.error('Failed to load repos for unified select', e); }
}

// ============================================================================
// Issue Actions Menu (project issues)
// ============================================================================

function showIssueActionsMenu(button) {
    document.querySelectorAll('.issue-actions-menu').forEach(m => m.remove());

    const issueId = button.dataset.issueId;
    const issueUrl = button.dataset.issueUrl;
    const issueTitle = button.dataset.issueTitle;
    const issueType = button.dataset.issueType;
    const issueBody = decodeURIComponent(button.dataset.issueBody || '');

    state.currentIssueData = { issueId, issueUrl, issueTitle, issueType, issueBody };

    const menu = document.createElement('div');
    menu.className = 'issue-actions-menu show';

    if (issueUrl) {
        const openItem = document.createElement('a');
        openItem.href = issueUrl; openItem.target = '_blank'; openItem.className = 'issue-actions-menu-item';
        openItem.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg> Open on GitHub`;
        menu.appendChild(openItem);
    }

    const removeItem = document.createElement('div');
    removeItem.className = 'issue-actions-menu-item';
    removeItem.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M2 5.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zM0 11.5A1.5 1.5 0 0 0 1.5 13h13a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H1.5A1.5 1.5 0 0 0 0 1.5v10z"/></svg> Remove from Project`;
    removeItem.addEventListener('click', () => removeIssueFromProject(issueId));
    menu.appendChild(removeItem);

    if (issueType === 'DRAFT') {
        const convertItem = document.createElement('div');
        convertItem.className = 'issue-actions-menu-item';
        convertItem.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/></svg> Convert to Issue`;
        convertItem.addEventListener('click', () => {
            closeIssueActionsMenu();
            autoStartBenchmark('convert_draft_to_issue');
            openConvertDraftModal(issueId, issueTitle, issueBody);
        });
        menu.appendChild(convertItem);
    }

    const moveItem = document.createElement('div');
    moveItem.className = 'issue-actions-menu-item';
    moveItem.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 8a.5.5 0 0 1 .5-.5h11.793l-3.147-3.146a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L13.293 8.5H1.5A.5.5 0 0 1 1 8z"/></svg> Move to Project`;
    moveItem.addEventListener('click', () => {
        closeIssueActionsMenu();
        autoStartBenchmark('move_item_to_project');
        openMoveToProjectModal(issueId, issueTitle, issueType);
    });
    menu.appendChild(moveItem);

    if (issueType === 'ISSUE' && issueUrl) {
        const deleteItem = document.createElement('div');
        deleteItem.className = 'issue-actions-menu-item danger';
        deleteItem.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6Z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1ZM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118ZM2.5 3h11V2h-11v1Z"/></svg> Delete Issue`;
        deleteItem.addEventListener('click', () => deleteIssueCompletely(issueUrl, issueTitle));
        menu.appendChild(deleteItem);
    }

    window.showPopover({ anchor: button, element: menu, alignRight: true, onClose: closeIssueActionsMenu });
}

function closeIssueActionsMenu() {
    document.querySelectorAll('.issue-actions-menu').forEach(m => m.remove());
}

// ============================================================================
// Repo Issue Actions Menu
// ============================================================================

export function showRepoIssueActionsMenu(button) {
    document.querySelectorAll('.issue-actions-menu').forEach(m => m.remove());

    const url = button.dataset.issueUrl;
    const number = button.dataset.issueNumber;
    const issueState = button.dataset.issueState;
    const owner = button.dataset.issueOwner;
    const repo = button.dataset.issueRepo;
    const newState = issueState === 'open' ? 'closed' : 'open';

    const menu = document.createElement('div');
    menu.className = 'issue-actions-menu show';

    const openItem = document.createElement('a');
    openItem.href = url; openItem.target = '_blank'; openItem.className = 'issue-actions-menu-item';
    openItem.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg> Open on GitHub`;
    menu.appendChild(openItem);

    const toggleItem = document.createElement('div');
    toggleItem.className = 'issue-actions-menu-item' + (issueState === 'open' ? ' danger' : '');
    toggleItem.innerHTML = issueState === 'open'
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/></svg> Close issue`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/></svg> Reopen issue`;
    toggleItem.addEventListener('click', async () => {
        closeIssueActionsMenu();
        try {
            const tokenData = await getStoredToken();
            const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: newState })
            });
            if (!res.ok) throw new Error('Failed');
            showStatus(`Issue #${number} ${newState === 'closed' ? 'closed' : 'reopened'}`, 'success');
            await loadRepoIssues(state.currentRepoFullName);
        } catch (err) { showStatus('Failed: ' + err.message, 'error'); }
    });
    menu.appendChild(toggleItem);

    window.showPopover({ anchor: button, element: menu, alignRight: true, onClose: closeIssueActionsMenu });
}

// ============================================================================
// Remove / Delete Issues
// ============================================================================

export async function removeIssueFromProject(itemId) {
    if (!state.currentProject) return;
    autoStartBenchmark('remove_issue_from_project');
    if (!confirm('Remove this issue from the project? The issue will still exist on GitHub.')) {
        await cancelBenchmarkTask('remove_issue_from_project', 'user_declined_confirm');
        return;
    }
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
        await gql(tokenData.access_token, `
            mutation DeleteProjectV2Item($projectId: ID!, $itemId: ID!) {
                deleteProjectV2Item(input: { projectId: $projectId itemId: $itemId }) { deletedItemId }
            }`, { projectId: state.currentProject.id, itemId });
        showStatus('Issue removed from project', 'success');
        invalidateProjectCache(state.currentProject.id);
        await loadProjectIssues(state.currentProject.id);
        await completeBenchmarkTask('remove_issue_from_project');
    } catch (error) {
        console.error('Error removing issue:', error);
        showStatus('Failed to remove issue: ' + error.message, 'error');
    }
}

export async function deleteIssueCompletely(issueUrl, issueTitle) {
    if (!issueUrl) return;
    const urlMatch = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!urlMatch) { showStatus('Could not parse issue URL', 'error'); return; }
    const [, owner, repo, issueNumber] = urlMatch;

    if (!confirm(`⚠️ DELETE ISSUE PERMANENTLY?\n\nThis will delete "${issueTitle}" from GitHub completely.\n\nThis action CANNOT be undone!\n\nAre you absolutely sure?`)) return;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }

        const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github+json' }
        });
        if (!issueRes.ok) throw new Error('Failed to fetch issue details');
        const { node_id } = await issueRes.json();

        await gql(tokenData.access_token, `
            mutation DeleteIssue($issueId: ID!) {
                deleteIssue(input: { issueId: $issueId }) { repository { id } }
            }`, { issueId: node_id });

        showStatus('Issue deleted permanently', 'success');
        if (state.currentMode === 'repo' && state.currentRepoFullName) {
            await loadRepoIssues(state.currentRepoFullName);
        } else if (state.currentProject) {
            invalidateProjectCache(state.currentProject.id);
            await loadProjectIssues(state.currentProject.id);
        }
        await completeBenchmarkTask('delete_repo_issue');
    } catch (error) {
        console.error('Error deleting issue:', error);
        showStatus('Failed to delete issue: ' + error.message, 'error');
    }
}

// ============================================================================
// Status Dropdown
// ============================================================================

function showStatusDropdown(badgeElement, itemId, currentStatus) {
    hideStatusDropdown();
    if (!state.currentProject || !state.projectFieldDefinitions[state.currentProject.id]) {
        showStatus('Project field definitions not loaded', 'error'); return;
    }
    const fieldDefs = state.projectFieldDefinitions[state.currentProject.id];
    if (!fieldDefs.status?.options) { showStatus('No status field found in this project', 'error'); return; }

    const dropdown = document.createElement('div');
    dropdown.className = 'status-dropdown';

    fieldDefs.status.options.forEach(option => {
        const cssColor = githubColorToCSS(option.color);
        const isSelected = option.name === currentStatus;
        const optionDiv = document.createElement('div');
        optionDiv.className = 'status-dropdown-option' + (isSelected ? ' selected' : '');
        optionDiv.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background-color:${cssColor};display:inline-block;"></span><span style="flex:1;">${option.name}</span>${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10.97 4.97a.75.75 0 0 1 1.07 1.05l-3.99 4.99a.75.75 0 0 1-1.08.02L4.324 8.384a.75.75 0 1 1 1.06-1.06l2.094 2.093 3.473-4.425a.267.267 0 0 1 .02-.022z"/></svg>' : ''}`;
        optionDiv.style.color = cssColor;
        if (!isSelected) optionDiv.addEventListener('click', async () => { await updateItemStatus(itemId, option.id, option.name, option.color); hideStatusDropdown(); });
        dropdown.appendChild(optionDiv);
    });

    window.showPopover({ anchor: badgeElement, element: dropdown, alignRight: false, onClose: hideStatusDropdown });
    state.currentStatusDropdown = dropdown;
}

function hideStatusDropdown() {
    if (state.currentStatusDropdown) { state.currentStatusDropdown.remove(); state.currentStatusDropdown = null; }
}

async function updateItemStatus(itemId, optionId, optionName, optionColor) {
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
        const fieldDefs = state.projectFieldDefinitions[state.currentProject.id];
        await gql(tokenData.access_token, `
            mutation UpdateItemStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
                updateProjectV2ItemFieldValue(input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: { singleSelectOptionId: $optionId } }) {
                    projectV2Item { id }
                }
            }`, { projectId: state.currentProject.id, itemId, fieldId: fieldDefs.status.id, optionId });

        const cssColor = githubColorToCSS(optionColor);
        const badge = document.querySelector(`[data-item-id="${itemId}"]`);
        if (badge) {
            badge.style.backgroundColor = `${cssColor}15`;
            badge.style.color = cssColor;
            badge.style.borderColor = `${cssColor}30`;
            badge.dataset.currentStatus = optionName;
            badge.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background-color:${cssColor};display:inline-block;"></span>${optionName}<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>`;
            badge.addEventListener('click', e => { e.stopPropagation(); showStatusDropdown(e.currentTarget, e.currentTarget.dataset.itemId, e.currentTarget.dataset.currentStatus); });
            badge.addEventListener('mouseenter', e => e.currentTarget.style.transform = 'scale(1.05)');
            badge.addEventListener('mouseleave', e => e.currentTarget.style.transform = 'scale(1)');
        }
        showStatus(`Status changed to "${optionName}"`, 'success');
    } catch (error) {
        console.error('Error updating status:', error);
        showStatus('Failed to update status: ' + error.message, 'error');
    }
}

// ============================================================================
// Move to Project
// ============================================================================

export function openMoveToProjectModal(itemId, itemTitle, itemType) {
    state.moveItemId = itemId;
    state.moveItemType = itemType;

    const sel = document.getElementById('moveToProjectSelect');
    sel.innerHTML = '<option value="" disabled selected>Choose a project...</option>';
    if (state.allProjects?.data) {
        state.allProjects.data.viewer.projectsV2.nodes
            .filter(p => p.id !== state.currentProject.id)
            .forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id; opt.textContent = p.title;
                sel.appendChild(opt);
            });
    }
    document.getElementById('moveToProjectDesc').textContent = `Move "${itemTitle}" from "${state.currentProject.title}" to another project.`;
    openModal('moveToProjectModal');
}

export async function moveToProject() {
    const sel = document.getElementById('moveToProjectSelect');
    const targetProjectId = sel.value;
    if (!targetProjectId) { showStatus('Please select a target project', 'error'); return; }

    const confirmBtn = document.getElementById('confirmMoveToProject');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }

        if (state.moveItemType === 'DRAFT') {
            const titleEl = document.querySelector(`[data-issue-id="${state.moveItemId}"]`)?.closest('tr')?.querySelector('.issue-title');
            const title = titleEl?.textContent?.trim() || 'Untitled';
            await gql(tokenData.access_token, `
                mutation AddDraft($projectId: ID!, $title: String!) {
                    addProjectV2DraftIssue(input: { projectId: $projectId, title: $title }) { projectItem { id } }
                }`, { projectId: targetProjectId, title });
        } else {
            const cached = state.projectItemsCache[state.currentProject.id];
            const item = cached?.find(i => i.id === state.moveItemId);
            if (!item?.content?.id) throw new Error('Could not find issue node ID');
            await gql(tokenData.access_token, `
                mutation AddIssue($projectId: ID!, $contentId: ID!) {
                    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
                }`, { projectId: targetProjectId, contentId: item.content.id });
        }

        await gql(tokenData.access_token, `
            mutation RemoveItem($projectId: ID!, $itemId: ID!) {
                deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
            }`, { projectId: state.currentProject.id, itemId: state.moveItemId });

        const targetName = sel.options[sel.selectedIndex].textContent;
        showStatus(`Moved to "${targetName}" successfully`, 'success');
        closeModal('moveToProjectModal');
        const projectId = state.currentProject.id;
        await new Promise(r => setTimeout(r, 800));
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

// ============================================================================
// Convert Draft to Issue
// ============================================================================

export async function openConvertDraftModal(itemId, title, body) {
    if (!state.currentProject) return;
    state.convertDraftItemId = itemId;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
        if (state.userRepositories.length === 0) {
            showStatus('Loading repositories...', 'info');
            state.userRepositories = await fetchUserRepositories(tokenData.access_token);
        }

        const repoSelect = document.getElementById('convertDraftRepository');
        repoSelect.innerHTML = '<option value="" disabled selected>Select a repository</option>';
        state.userRepositories.forEach(repo => {
            const opt = document.createElement('option');
            opt.value = repo.full_name; opt.textContent = repo.full_name;
            opt.dataset.owner = repo.owner.login; opt.dataset.name = repo.name;
            repoSelect.appendChild(opt);
        });

        const convertLinkedRepos = state.currentProject.repositories?.nodes?.filter(r => r.nameWithOwner) || [];
        const convertRepoRow = document.getElementById('convertDraftRepositoryRow');
        if (convertLinkedRepos.length === 1) {
            repoSelect.value = convertLinkedRepos[0].nameWithOwner;
            if (convertRepoRow) convertRepoRow.style.display = 'none';
        } else {
            if (convertRepoRow) convertRepoRow.style.display = '';
        }

        const targetSel = document.getElementById('convertDraftTargetProject');
        targetSel.innerHTML = '<option value="">Keep in current project</option>';
        if (state.allProjects?.data) {
            state.allProjects.data.viewer.projectsV2.nodes.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id; opt.textContent = p.title + (p.id === state.currentProject.id ? ' (current)' : '');
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

export async function convertDraftToIssue() {
    const repoSelect = document.getElementById('convertDraftRepository');
    const selectedOption = repoSelect.options[repoSelect.selectedIndex];
    const title = document.getElementById('convertDraftTitle').value.trim();
    const body = document.getElementById('convertDraftBody').value.trim();

    if (!repoSelect.value) { showStatus('Please select a repository', 'error'); return; }
    if (!title) { showStatus('Please enter an issue title', 'error'); return; }

    const confirmBtn = document.getElementById('confirmConvertDraft');
    confirmBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }

        const issueRes = await fetch(`https://api.github.com/repos/${selectedOption.dataset.owner}/${selectedOption.dataset.name}/issues`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, body: body || '' })
        });
        if (!issueRes.ok) { const err = await issueRes.json(); throw new Error(err.message || 'Failed to create issue'); }
        const newIssue = await issueRes.json();

        const targetProjectSel = document.getElementById('convertDraftTargetProject');
        const targetProjectId = targetProjectSel.value || state.currentProject.id;

        await gql(tokenData.access_token, `
            mutation AddIssueToProject($projectId: ID!, $contentId: ID!) {
                addProjectV2ItemById(input: { projectId: $projectId contentId: $contentId }) { item { id } }
            }`, { projectId: targetProjectId, contentId: newIssue.node_id });

        await gql(tokenData.access_token, `
            mutation DeleteProjectV2Item($projectId: ID!, $itemId: ID!) {
                deleteProjectV2Item(input: { projectId: $projectId itemId: $itemId }) { deletedItemId }
            }`, { projectId: state.currentProject.id, itemId: state.convertDraftItemId });

        const targetName = targetProjectSel.value
            ? targetProjectSel.options[targetProjectSel.selectedIndex].textContent.replace(' (current)', '')
            : state.currentProject.title;
        showStatus(`Draft converted to issue in "${targetName}"!`, 'success');
        closeModal('convertDraftModal');
        const projectId = state.currentProject.id;
        await new Promise(r => setTimeout(r, 1000));
        invalidateProjectCache(projectId);
        await loadProjectIssues(projectId);
        await completeBenchmarkTask('convert_draft_to_issue');

    } catch (error) {
        console.error('Error converting draft:', error);
        showStatus('Failed to convert draft: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

// ============================================================================
// Project CRUD
// ============================================================================

export function openChooseAddTypeModal() {
    if (!state.currentProject) return;
    openModal('chooseAddTypeModal');
}

export function openAddDraftModal() {
    if (!state.currentProject) return;
    document.getElementById('draftTitle').value = '';
    document.getElementById('draftBody').value = '';
    openModal('addDraftModal');
}

export async function addDraftToProject() {
    const title = document.getElementById('draftTitle').value.trim();
    const body = document.getElementById('draftBody').value.trim();
    if (!title) { showStatus('Please enter a draft title', 'error'); return; }

    const confirmBtn = document.getElementById('confirmAddDraft');
    confirmBtn.disabled = true;
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
        await gql(tokenData.access_token, `
            mutation AddProjectV2DraftIssue($projectId: ID!, $title: String!, $body: String) {
                addProjectV2DraftIssue(input: { projectId: $projectId title: $title body: $body }) { projectItem { id } }
            }`, { projectId: state.currentProject.id, title, body: body || null });
        showStatus('Draft issue added to project!', 'success');
        document.getElementById('draftTitle').value = '';
        document.getElementById('draftBody').value = '';
        closeModal('addDraftModal');
        const projectId = state.currentProject.id;
        await new Promise(r => setTimeout(r, 1000));
        invalidateProjectCache(projectId);
        await loadProjectIssues(projectId);
        await completeBenchmarkTask('create_project_draft');
    } catch (error) {
        console.error('Error adding draft:', error);
        showStatus('Failed to add draft: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

export async function openAddIssueModal() {
    if (!state.currentProject) return;
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
        if (state.userRepositories.length === 0) {
            showStatus('Loading repositories...', 'info');
            state.userRepositories = await fetchUserRepositories(tokenData.access_token);
        }
        const repoSelect = document.getElementById('issueRepository');
        repoSelect.innerHTML = '<option value="" disabled selected>Select a repository</option>';
        state.userRepositories.forEach(repo => {
            const opt = document.createElement('option');
            opt.value = repo.full_name; opt.textContent = repo.full_name;
            opt.dataset.owner = repo.owner.login; opt.dataset.name = repo.name;
            repoSelect.appendChild(opt);
        });
        const projectLinkedRepos = state.currentProject.repositories?.nodes?.filter(r => r.nameWithOwner) || [];
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

export async function addIssueToProject() {
    const repoSelect = document.getElementById('issueRepository');
    const selectedOption = repoSelect.options[repoSelect.selectedIndex];
    const title = document.getElementById('issueTitle').value.trim();
    const body = document.getElementById('issueBody').value.trim();

    if (!selectedOption?.value) { showStatus('Please select a repository', 'error'); return; }
    if (!title) { showStatus('Please enter an issue title', 'error'); return; }

    const confirmBtn = document.getElementById('confirmAddIssue');
    confirmBtn.disabled = true;
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }

        const issueRes = await fetch(`https://api.github.com/repos/${selectedOption.dataset.owner}/${selectedOption.dataset.name}/issues`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, body: body || undefined })
        });
        if (!issueRes.ok) { const err = await issueRes.json(); throw new Error(err.message || 'Failed to create issue'); }
        const createdIssue = await issueRes.json();

        await gql(tokenData.access_token, `
            mutation AddProjectV2Item($projectId: ID!, $contentId: ID!) {
                addProjectV2ItemById(input: { projectId: $projectId contentId: $contentId }) { item { id } }
            }`, { projectId: state.currentProject.id, contentId: createdIssue.node_id });

        showStatus('Issue added to project successfully!', 'success');
        document.getElementById('issueTitle').value = '';
        document.getElementById('issueBody').value = '';
        document.getElementById('issueRepository').selectedIndex = 0;
        closeModal('addIssueModal');
        const projectId = state.currentProject.id;
        await new Promise(r => setTimeout(r, 1000));
        invalidateProjectCache(projectId);
        await loadProjectIssues(projectId);
        await completeBenchmarkTask('create_project_issue');
    } catch (error) {
        console.error('Error adding issue:', error);
        showStatus('Failed to add issue: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

export function openRenameProjectModal() {
    if (!state.currentProject) return;
    document.getElementById('newProjectTitle').value = state.currentProject.title;
    openModal('renameProjectModal');
}

export async function renameProject() {
    if (!state.currentProject) return;
    const newTitle = document.getElementById('newProjectTitle').value.trim();
    if (!newTitle) { showStatus('Please enter a project title', 'error'); return; }

    const renameBtn = document.getElementById('confirmRenameProject');
    renameBtn.disabled = true;
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
        await gql(tokenData.access_token, `
            mutation UpdateProject($projectId: ID!, $title: String!) {
                updateProjectV2(input: { projectId: $projectId title: $title }) { projectV2 { id title } }
            }`, { projectId: state.currentProject.id, title: newTitle });

        showStatus('Project renamed successfully', 'success');
        state.currentProject.title = newTitle;
        document.getElementById('projectTitle').textContent = newTitle;
        const selectedOption = document.getElementById('unifiedSelect').querySelector(`option[value="project:${state.currentProject.id}"]`);
        if (selectedOption) selectedOption.textContent = newTitle;
        const idx = state.allProjects.data.viewer.projectsV2.nodes.findIndex(p => p.id === state.currentProject.id);
        if (idx !== -1) state.allProjects.data.viewer.projectsV2.nodes[idx].title = newTitle;
        closeModal('renameProjectModal');
        await completeBenchmarkTask('rename_project');
    } catch (error) {
        console.error('Error renaming project:', error);
        showStatus('Failed to rename project: ' + error.message, 'error');
    } finally {
        renameBtn.disabled = false;
    }
}

export function openEditProjectModal() {
    if (!state.currentProject) return;
    document.getElementById('editProjectDescription').value = state.currentProject.shortDescription || '';
    if (state.currentProject.public) document.getElementById('editProjectPublic').checked = true;
    else document.getElementById('editProjectPrivate').checked = true;
    openModal('editProjectModal');
}

export async function saveProjectEdits() {
    if (!state.currentProject) return;
    const newDescription = document.getElementById('editProjectDescription').value.trim();
    const isPublic = document.getElementById('editProjectPublic').checked;

    const confirmBtn = document.getElementById('confirmEditProject');
    confirmBtn.disabled = true;
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
        await gql(tokenData.access_token, `
            mutation UpdateProject($projectId: ID!, $shortDescription: String, $public: Boolean!) {
                updateProjectV2(input: { projectId: $projectId shortDescription: $shortDescription public: $public }) {
                    projectV2 { id title shortDescription public }
                }
            }`, { projectId: state.currentProject.id, shortDescription: newDescription || null, public: isPublic });

        showStatus('Project settings updated successfully', 'success');
        state.currentProject.shortDescription = newDescription;
        state.currentProject.public = isPublic;
        const idx = state.allProjects.data.viewer.projectsV2.nodes.findIndex(p => p.id === state.currentProject.id);
        if (idx !== -1) {
            state.allProjects.data.viewer.projectsV2.nodes[idx].shortDescription = newDescription;
            state.allProjects.data.viewer.projectsV2.nodes[idx].public = isPublic;
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

export async function openCreateProjectModal() {
    document.getElementById('newProjectTitleInput').value = '';
    document.getElementById('newProjectDescription').value = '';
    document.getElementById('projectPublic').checked = false;

    const repoSelect = document.getElementById('newProjectRepository');
    repoSelect.innerHTML = '<option value="">No repository</option>';
    try {
        const tokenData = await getStoredToken();
        if (tokenData?.access_token) {
            if (state.userRepositories.length === 0) state.userRepositories = await fetchUserRepositories(tokenData.access_token);
            state.userRepositories.forEach(repo => {
                const opt = document.createElement('option');
                opt.value = repo.node_id; opt.textContent = repo.full_name;
                opt.dataset.owner = repo.owner.login; opt.dataset.name = repo.name;
                repoSelect.appendChild(opt);
            });
        }
    } catch (e) { console.error('Error loading repos:', e); }
    openModal('createProjectModal');
}

export async function createNewProject() {
    const title = document.getElementById('newProjectTitleInput').value.trim();
    const isPublic = document.getElementById('projectPublic').checked;
    const repoSelect = document.getElementById('newProjectRepository');
    const selectedRepoNodeId = repoSelect.value || null;

    if (!title) { showStatus('Please enter a project title', 'error'); return; }

    const confirmBtn = document.getElementById('confirmCreateProject');
    confirmBtn.disabled = true;
    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }

        const userData = await gql(tokenData.access_token, `query { viewer { id } }`);
        const ownerId = userData.viewer.id;

        const createData = await gql(tokenData.access_token, `
            mutation CreateProject($ownerId: ID!, $title: String!) {
                createProjectV2(input: { ownerId: $ownerId title: $title }) { projectV2 { id title url public } }
            }`, { ownerId, title });
        const newProjectId = createData.createProjectV2.projectV2.id;

        if (isPublic !== createData.createProjectV2.projectV2.public) {
            await gql(tokenData.access_token, `
                mutation UpdateProjectVisibility($projectId: ID!, $public: Boolean!) {
                    updateProjectV2(input: { projectId: $projectId public: $public }) { projectV2 { id public } }
                }`, { projectId: newProjectId, public: isPublic }).catch(e => console.error('Visibility update failed:', e));
        }

        if (selectedRepoNodeId) {
            await gql(tokenData.access_token, `
                mutation LinkProjectToRepo($projectId: ID!, $repositoryId: ID!) {
                    linkProjectV2ToRepository(input: { projectId: $projectId repositoryId: $repositoryId }) { repository { name } }
                }`, { projectId: newProjectId, repositoryId: selectedRepoNodeId }).catch(e => console.error('Repo link failed:', e));
        }

        showStatus('Project created successfully!', 'success');
        document.getElementById('newProjectTitleInput').value = '';
        document.getElementById('newProjectDescription').value = '';
        document.getElementById('projectPublic').checked = false;
        document.getElementById('newProjectRepository').value = '';
        closeModal('createProjectModal');
        await loadProjects();
        document.getElementById('unifiedSelect').value = 'project:' + newProjectId;
        await loadProjectIssues(newProjectId);
        await completeBenchmarkTask('create_project');
    } catch (error) {
        console.error('Error creating project:', error);
        showStatus('Failed to create project: ' + error.message, 'error');
    } finally {
        confirmBtn.disabled = false;
    }
}

export async function deleteCurrentProject() {
    if (!state.currentProject) return;

    state.deleteCallback = async () => {
        try {
            const tokenData = await getStoredToken();
            if (!tokenData?.access_token) { showStatus('Not authenticated', 'error'); return; }
            await gql(tokenData.access_token, `
                mutation DeleteProject($projectId: ID!) {
                    deleteProjectV2(input: { projectId: $projectId }) { projectV2 { id } }
                }`, { projectId: state.currentProject.id });

            showStatus('Project deleted successfully', 'success');
            const idx = state.allProjects.data.viewer.projectsV2.nodes.findIndex(p => p.id === state.currentProject.id);
            if (idx !== -1) state.allProjects.data.viewer.projectsV2.nodes.splice(idx, 1);
            const opt = document.getElementById('unifiedSelect').querySelector(`option[value="project:${state.currentProject.id}"]`);
            if (opt) opt.remove();
            document.getElementById('unifiedSelect').value = '';
            hideProjectIssues();
        } catch (error) {
            console.error('Error deleting project:', error);
            showStatus('Failed to delete project: ' + error.message, 'error');
        }
    };

    document.getElementById('deleteConfirmMessage').textContent = `Are you sure you want to delete the project "${state.currentProject.title}"? This action cannot be undone.`;
    openModal('deleteConfirmModal');
}

// Placeholder
export function openEditIssueModal() { showStatus('To edit this issue, click "Open on GitHub"', 'info'); }
export async function saveIssueEdits() { closeModal('editIssueModal'); }
