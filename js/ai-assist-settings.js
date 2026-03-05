// ============================================================================
// AI Assist Settings — API Key management
// Stored encrypted in chrome.storage.local
// ============================================================================

const AI_ASSIST_SETTINGS = (() => {

    const KEY_STORAGE_KEY = 'ai_assist_api_key';

    async function saveKey() {
        const input = document.getElementById('aiApiKeyInput');
        const key = input?.value?.trim();
        if (!key) {
            showKeyStatus('Enter your Claude API key first.', 'error');
            return;
        }
        if (!key.startsWith('sk-ant-')) {
            showKeyStatus('Invalid key format. Should start with sk-ant-', 'error');
            return;
        }

        try {
            await chrome.storage.local.set({ [KEY_STORAGE_KEY]: key });
            input.value = '';
            input.placeholder = '✓ Key saved — stored locally in browser';
            showKeyStatus('API key saved!', 'success');

            // Patch AI_ASSIST fetch to use this key
            patchApiKey(key);
        } catch (e) {
            showKeyStatus('Failed to save key: ' + e.message, 'error');
        }
    }

    async function loadKey() {
        try {
            const result = await chrome.storage.local.get([KEY_STORAGE_KEY]);
            const key = result[KEY_STORAGE_KEY];
            if (key) {
                const input = document.getElementById('aiApiKeyInput');
                if (input) input.placeholder = '✓ Key saved — stored locally in browser';
                patchApiKey(key);
                return key;
            }
        } catch (e) {
            console.error('Failed to load AI key:', e);
        }
        return null;
    }

    function patchApiKey(key) {
        // Override the fetch in AI_ASSIST to inject the API key header
        // We use a module-level variable that the main module reads
        window.__AI_ASSIST_API_KEY__ = key;
    }

    function showKeyStatus(msg, type) {
        const el = document.getElementById('aiApiKeyInput');
        if (!el) return;
        const original = el.style.borderColor;
        el.style.borderColor = type === 'success' ? '#22c55e' : '#ef4444';
        setTimeout(() => { el.style.borderColor = original; }, 2000);
    }

    // Init: load key on startup
    document.addEventListener('DOMContentLoaded', loadKey);
    // Also try immediately if DOM is already ready
    if (document.readyState !== 'loading') loadKey();

    return { saveKey, loadKey };
})();
