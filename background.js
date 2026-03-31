// ============================================================================
// background.js
// Generates a stable anonymous participant ID on first install.
// This ID is used to identify unique users in benchmark statistics
// without storing any personal data.
// ============================================================================

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
        const existing = await chrome.storage.local.get(['participantId']);
        if (!existing.participantId) {
            const id = crypto.randomUUID();
            await chrome.storage.local.set({ participantId: id });
            console.log('[Benchmark] Participant ID generated:', id);
        }
    }
});

// Also ensure the ID exists on startup (in case storage was cleared)
chrome.runtime.onStartup.addListener(async () => {
    const existing = await chrome.storage.local.get(['participantId']);
    if (!existing.participantId) {
        const id = crypto.randomUUID();
        await chrome.storage.local.set({ participantId: id });
    }
});