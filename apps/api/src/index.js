import { Hono } from 'hono';
const LINKEDIN_REDIRECT_URI = 'https://codelore-api.codelore.workers.dev/auth/linkedin/callback';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const app = new Hono();
app.get('/health', (c) => {
    return c.json({
        service: 'codelore-api',
        status: 'ok',
    });
});
app.get('/auth/linkedin/start', async (c) => {
    const connectionId = c.req.query('connection_id');
    if (!connectionId || connectionId.length < 16) {
        return c.json({ error: 'A secure connection ID is required.' }, 400);
    }
    const state = randomValue();
    const now = Date.now();
    await c.env.DB.prepare(`INSERT INTO oauth_states (state_hash, connection_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`)
        .bind(await sha256(state), connectionId, now + OAUTH_STATE_TTL_MS, now)
        .run();
    const authorizationUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
    authorizationUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: c.env.LINKEDIN_CLIENT_ID,
        redirect_uri: LINKEDIN_REDIRECT_URI,
        state,
        scope: 'openid profile w_member_social',
    }).toString();
    return c.redirect(authorizationUrl.toString());
});
app.get('/auth/linkedin/callback', async (c) => {
    const error = c.req.query('error');
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (error || !code || !state) {
        return connectionResult(false, 'LinkedIn connection was cancelled or incomplete.');
    }
    const stateHash = await sha256(state);
    const savedState = await c.env.DB.prepare(`SELECT connection_id, expires_at
     FROM oauth_states
     WHERE state_hash = ?`)
        .bind(stateHash)
        .first();
    await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?')
        .bind(stateHash)
        .run();
    if (!savedState || savedState.expires_at < Date.now()) {
        return connectionResult(false, 'This connection link expired. Return to VS Code and try again.');
    }
    const token = await exchangeCode(c.env, code);
    const profile = await getLinkedInProfile(token.access_token);
    const now = Date.now();
    await c.env.DB.prepare(`INSERT INTO linkedin_connections (
       id, member_urn, encrypted_access_token, token_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_urn) DO UPDATE SET
       id = excluded.id,
       encrypted_access_token = excluded.encrypted_access_token,
       token_expires_at = excluded.token_expires_at,
       updated_at = excluded.updated_at`)
        .bind(savedState.connection_id, `urn:li:person:${profile.sub}`, await encrypt(token.access_token, c.env.TOKEN_ENCRYPTION_KEY), now + token.expires_in * 1000, now, now)
        .run();
    return connectionResult(true, 'LinkedIn is connected. You can return to VS Code.');
});
async function exchangeCode(env, code) {
    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: LINKEDIN_REDIRECT_URI,
            client_id: env.LINKEDIN_CLIENT_ID,
            client_secret: env.LINKEDIN_CLIENT_SECRET,
        }),
    });
    if (!response.ok) {
        throw new Error(`LinkedIn token exchange failed with status ${response.status}.`);
    }
    return response.json();
}
async function getLinkedInProfile(accessToken) {
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
        throw new Error(`LinkedIn profile lookup failed with status ${response.status}.`);
    }
    return response.json();
}
async function encrypt(value, base64Key) {
    const key = await crypto.subtle.importKey('raw', base64ToBytes(base64Key), { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return bytesToBase64(combined);
}
async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return bytesToBase64(new Uint8Array(digest));
}
function randomValue() {
    return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}
function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function bytesToBase64(value) {
    let binary = '';
    for (const byte of value) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
function connectionResult(success, message) {
    const title = success ? 'CodeLore is connected' : 'CodeLore could not connect';
    return new Response(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`, {
        headers: { 'content-type': 'text/html; charset=UTF-8' },
        status: success ? 200 : 400,
    });
}
export default app;
//# sourceMappingURL=index.js.map