import { CONFIG } from './config.js';

// ============================================================================
// Token Encryption / Decryption
// ============================================================================

function base64URLEncode(buffer) {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getKey(usage) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(chrome.runtime.id.padEnd(32, '0')),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: encoder.encode('github-oauth-salt'), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        [usage]
    );
}

export async function encryptToken(token) {
    const encoder = new TextEncoder();
    const key = await getKey('encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(token));
    return {
        encrypted: base64URLEncode(new Uint8Array(encrypted)),
        iv: base64URLEncode(iv)
    };
}

export async function decryptToken(encryptedData) {
    const key = await getKey('decrypt');
    const encrypted = Uint8Array.from(
        atob(encryptedData.encrypted.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
    );
    const iv = Uint8Array.from(
        atob(encryptedData.iv.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
    );
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return new TextDecoder().decode(decrypted);
}

// ============================================================================
// Token Storage
// ============================================================================

export async function storeToken(tokenData) {
    const encrypted = await encryptToken(JSON.stringify(tokenData));
    await chrome.storage.local.set({
        githubToken: encrypted,
        tokenExpiry: Date.now() + (tokenData.expires_in || 86400) * 1000
    });
}

export async function getStoredToken() {
    try {
        const result = await chrome.storage.local.get(['githubToken', 'tokenExpiry']);
        if (!result.githubToken) return null;
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

export async function clearStoredToken() {
    await chrome.storage.local.remove([
        'githubToken', 'tokenExpiry', 'repos', 'selectedRepo',
        'userData', 'quickCaptureEnabled', 'quickCaptureInboxProject', 'theme'
    ]);
}

// ============================================================================
// GitHub OAuth
// ============================================================================

export async function authenticateWithGitHub() {
    const state = base64URLEncode(crypto.getRandomValues(new Uint8Array(32)));

    const authUrl = `https://github.com/login/oauth/authorize?` +
        `client_id=${CONFIG.GITHUB_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}` +
        `&scope=repo gist project read:user` +
        `&state=${state}`;

    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
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
                resolve(await exchangeCodeForToken(code));
            } catch (error) { 
                reject(error); 
            }
        });
    });
}

export async function exchangeCodeForToken(code) {
    try {
        const response = await fetch(`${CONFIG.BACKEND_URL}/api/github/token`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ code, redirect_uri: CONFIG.REDIRECT_URI })
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
