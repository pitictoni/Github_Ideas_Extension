import { state } from './state.js';
import { getStoredToken } from './auth.js';
import { fetchGists, fetchGistById, createGist, updateGist, deleteGist, renameGistDescription } from './api.js';
import { showStatus, openModal, closeModal, openDeleteConfirmModal } from './ui.js';
import { autoStartBenchmark, completeBenchmarkTask, cancelBenchmarkTask } from './benchmark.js';


export async function loadGists() {
    const tokenData = await getStoredToken();
    if (!tokenData?.access_token) return;

    state.allGists = await fetchGists(tokenData.access_token);
    const gistSelect = document.getElementById('gistSelect');
    gistSelect.innerHTML = '<option value="" disabled selected>Select a gist to view/edit</option>';

    state.allGists.forEach(gist => {
        const option = document.createElement('option');
        option.value = gist.id;
        const firstFilename = Object.keys(gist.files)[0];
        const displayName = gist.description || firstFilename || 'Untitled Gist';
        option.textContent = `${gist.public ? '[Public]' : '[Secret]'} ${displayName}`;
        gistSelect.appendChild(option);
    });
}

export function displayGistPreview(gist) {
    state.currentGist = gist;

    const preview = document.getElementById('gistPreview');
    document.getElementById('previewGistName').textContent = gist.description || Object.keys(gist.files)[0] || 'Untitled Gist';
    document.getElementById('viewGistBtn').onclick = () => window.open(gist.html_url, '_blank');

    const filesList = document.getElementById('gistFilesList');
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

export function hideGistPreview() {
    document.getElementById('gistPreview').style.display = 'none';
    state.currentGist = null;
}

export function openCreateGistModal() {
    document.getElementById('gistEditorModalTitle').textContent = 'Create New Gist';
    document.getElementById('saveGistText').textContent = 'Create Gist';
    document.getElementById('gistDescription').value = '';
    document.getElementById('gistFilename').value = '';
    document.getElementById('gistContent').value = '';
    document.getElementById('gistPublic').checked = false;
    openModal('gistEditorModal');
}

export async function saveGist() {
    const benchmarkTask = state.currentGist ? 'edit_gist' : 'create_gist';
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
        if (!tokenData?.access_token) { 
            showStatus('Not authenticated', 'error'); 
            return; 
        }

        if (state.currentGist) {
            const files = {}; files[filename] = { content };
            await updateGist(tokenData.access_token, state.currentGist.id, files);
            showStatus('Gist updated successfully!', 'success');
            await loadGists();
            state.currentGist = await fetchGistById(tokenData.access_token, state.currentGist.id);
            displayGistPreview(state.currentGist);
        } else {
            const newGist = await createGist(tokenData.access_token, description, filename, content, isPublic);
            showStatus('Gist created successfully!', 'success');
            await loadGists();
            document.getElementById('gistSelect').value = newGist.id;
            state.currentGist = newGist;
            displayGistPreview(newGist);
        }

        closeModal('gistEditorModal');
        await completeBenchmarkTask(benchmarkTask);
        document.getElementById('gistFilename').disabled = false;

    } catch (error) {
        console.error('Error saving gist:', error);
        showStatus('Failed to save gist: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
}

export function openFileEditorModal() {
    if (!state.currentGist) return;

    const fileSelector = document.getElementById('fileSelector');
    const fileContent = document.getElementById('fileContent');

    fileSelector.innerHTML = '';
    Object.keys(state.currentGist.files).forEach(filename => {
        const option = document.createElement('option');
        option.value = filename;
        option.textContent = filename;
        fileSelector.appendChild(option);
    });

    const firstFilename = Object.keys(state.currentGist.files)[0];
    state.currentFile = firstFilename;
    document.getElementById('currentFileName').textContent = firstFilename;
    fileContent.value = state.currentGist.files[firstFilename].content;
    document.getElementById('deleteFileBtn').style.display =
        Object.keys(state.currentGist.files).length > 1 ? 'inline-flex' : 'none';

    openModal('fileEditorModal');
}

export function loadSelectedFile() {
    const fileSelector = document.getElementById('fileSelector');
    const selectedFilename = fileSelector.value;
    if (!state.currentGist || !selectedFilename) return;

    state.currentFile = selectedFilename;
    document.getElementById('currentFileName').textContent = selectedFilename;
    document.getElementById('fileContent').value = state.currentGist.files[selectedFilename].content;
    document.getElementById('deleteFileBtn').style.display =
        Object.keys(state.currentGist.files).length > 1 ? 'inline-flex' : 'none';
}

export async function saveFileChanges() {
    if (!state.currentGist || !state.currentFile) return;

    const content = document.getElementById('fileContent').value.trim();
    if (!content) { showStatus('Content cannot be empty', 'error'); return; }

    autoStartBenchmark('edit_gist');
    const saveBtn = document.getElementById('saveFileChanges');
    saveBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { 
            showStatus('Not authenticated', 'error'); 
            return; 
        }

        const files = {}; files[state.currentFile] = { content };
        await updateGist(tokenData.access_token, state.currentGist.id, files);
        showStatus('File updated successfully!', 'success');

        state.currentGist = await fetchGistById(tokenData.access_token, state.currentGist.id);
        await loadGists();
        displayGistPreview(state.currentGist);
        closeModal('fileEditorModal');
        await completeBenchmarkTask('edit_gist');

    } catch (error) {
        console.error('Error saving file:', error);
        showStatus('Failed to save file: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
}

// ============================================================================
// Add File Modal
// ============================================================================

export function openAddFileModal() {
    if (!state.currentGist) return;
    document.getElementById('newFileName').value = '';
    document.getElementById('newFileContent').value = '';
    openModal('addFileModal');
}

export async function saveNewFile() {
    if (!state.currentGist) return;

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
    if (state.currentGist.files[filename]) { 
        showStatus('A file with this name already exists', 'error'); 
        return; 
    }

    const saveBtn = document.getElementById('saveNewFile');
    saveBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { 
            showStatus('Not authenticated', 'error'); 
            return; 
        }

        const files = {}; files[filename] = { content };
        await updateGist(tokenData.access_token, state.currentGist.id, files);
        showStatus('File added successfully!', 'success');

        document.getElementById('newFileName').value = '';
        document.getElementById('newFileContent').value = '';

        state.currentGist = await fetchGistById(tokenData.access_token, state.currentGist.id);
        await loadGists();
        displayGistPreview(state.currentGist);
        closeModal('addFileModal');
        await completeBenchmarkTask('add_gist_file');

    } catch (error) {
        console.error('Error adding file:', error);
        showStatus('Failed to add file: ' + error.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
}

export async function deleteCurrentGist() {
    if (!state.currentGist) return;
    const gistName = state.currentGist.description || Object.keys(state.currentGist.files)[0] || 'this gist';

    openDeleteConfirmModal(
        `Are you sure you want to delete "${gistName}"? This action cannot be undone.`,
        async () => {
            try {
                const tokenData = await getStoredToken();
                if (!tokenData?.access_token) { 
                    showStatus('Not authenticated', 'error'); 
                    return; 
                }
                await deleteGist(tokenData.access_token, state.currentGist.id);
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

export async function deleteCurrentFile() {
    if (!state.currentGist || !state.currentFile) return;
    if (Object.keys(state.currentGist.files).length <= 1) {
        showStatus('Cannot delete the only file in a gist', 'error');
        return;
    }

    openDeleteConfirmModal(
        `Are you sure you want to delete "${state.currentFile}"? This action cannot be undone.`,
        async () => {
            try {
                const tokenData = await getStoredToken();
                if (!tokenData?.access_token) { 
                    showStatus('Not authenticated', 'error'); 
                    return; 
                }
                const files = {}; files[state.currentFile] = null;
                await updateGist(tokenData.access_token, state.currentGist.id, files);
                showStatus('File deleted successfully!', 'success');
                state.currentGist = await fetchGistById(tokenData.access_token, state.currentGist.id);
                await loadGists();
                displayGistPreview(state.currentGist);
                closeModal('fileEditorModal');
                await completeBenchmarkTask('delete_gist_file');
            } catch (error) {
                console.error('Error deleting file:', error);
                showStatus('Failed to delete file: ' + error.message, 'error');
            }
        }
    );
}

export function openRenameGistModal() {
    if (!state.currentGist) return;
    document.getElementById('newGistDescription').value = state.currentGist.description || '';
    openModal('renameGistModal');
}

export async function renameGist() {
    if (!state.currentGist) return;
    const newDescription = document.getElementById('newGistDescription').value.trim();
    const renameBtn = document.getElementById('confirmRenameGist');
    renameBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { 
            showStatus('Not authenticated', 'error'); 
            return; 
        }

        await renameGistDescription(tokenData.access_token, state.currentGist.id, newDescription);

        showStatus('Gist renamed successfully!', 'success');
        state.currentGist = await fetchGistById(tokenData.access_token, state.currentGist.id);
        await loadGists();
        displayGistPreview(state.currentGist);
        document.getElementById('gistSelect').value = state.currentGist.id;
        closeModal('renameGistModal');
        await completeBenchmarkTask('rename_gist');

    } catch (error) {
        console.error('Error renaming gist:', error);
        showStatus('Failed to rename gist: ' + error.message, 'error');
    } finally {
        renameBtn.disabled = false;
    }
}

export function openRenameFileModal() {
    if (!state.currentGist || !state.currentFile) return;
    document.getElementById('oldFilename').value = state.currentFile;
    document.getElementById('newFilename').value = state.currentFile;
    openModal('renameFileModal');
}

export async function renameFile() {
    if (!state.currentGist || !state.currentFile) return;

    const newFilename = document.getElementById('newFilename').value.trim();
    if (!newFilename) { 
        showStatus('Please enter a filename', 'error'); 
        return; 
    }
    if (newFilename === state.currentFile) { 
        showStatus('New filename is the same as the current filename', 'error'); 
        return; 
    }
    if (state.currentGist.files[newFilename]) { 
        showStatus('A file with this name already exists', 'error'); 
        return; 
    }

    const renameBtn = document.getElementById('confirmRenameFile');
    renameBtn.disabled = true;

    try {
        const tokenData = await getStoredToken();
        if (!tokenData?.access_token) { 
            showStatus('Not authenticated', 'error'); 
            return; 
        }

        const files = {};
        files[newFilename] = { content: state.currentGist.files[state.currentFile].content };
        files[state.currentFile] = null;
        await updateGist(tokenData.access_token, state.currentGist.id, files);

        showStatus('File renamed successfully!', 'success');
        state.currentFile = newFilename;

        state.currentGist = await fetchGistById(tokenData.access_token, state.currentGist.id);
        await loadGists();
        displayGistPreview(state.currentGist);
        closeModal('renameFileModal');
        await completeBenchmarkTask('rename_gist_file');

        document.getElementById('currentFileName').textContent = newFilename;
        const fileSelector = document.getElementById('fileSelector');
        fileSelector.innerHTML = '';
        Object.keys(state.currentGist.files).forEach(filename => {
            const option = document.createElement('option');
            option.value = filename;
            option.textContent = filename;
            if (filename === newFilename) option.selected = true;
            fileSelector.appendChild(option);
        });

    } catch (error) {
        console.error('Error renaming file:', error);
        showStatus('Failed to rename file: ' + error.message, 'error');
    } finally {
        renameBtn.disabled = false;
    }
}