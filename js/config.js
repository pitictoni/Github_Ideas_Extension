export const CONFIG = {
    GITHUB_CLIENT_ID: 'Ov23liMuwPTk5f4WfqNW',
    BACKEND_URL: 'https://github-oauth-worker.iopy.workers.dev',
    REDIRECT_URI: chrome.identity.getRedirectURL()
};

export async function getParticipantId() {
    const result = await chrome.storage.local.get(['participantId']);
    if (result.participantId) return result.participantId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ participantId: id });
    return id;
}
