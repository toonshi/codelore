import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
  LINKEDIN_CLIENT_ID: string
  LINKEDIN_CLIENT_SECRET: string
  TOKEN_ENCRYPTION_KEY: string
}

type OAuthState = {
  connection_id: string
  expires_at: number
}

type LinkedInProfile = {
  sub: string
  name?: string
  picture?: string
}

type LinkedInToken = {
  access_token: string
  expires_in: number
}

type PublishRequest = {
  connectionId?: string
  text?: string
}

const LINKEDIN_REDIRECT_URI =
  'https://codelore-api.codelore.workers.dev/auth/linkedin/callback'
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => {
  return c.json({
    service: 'codelore-api',
    status: 'ok',
  })
})

app.get('/auth/linkedin/status', async (c) => {
  const connectionId = c.req.query('connection_id')

  if (!connectionId || connectionId.length < 16) {
    return c.json({ connected: false }, 400)
  }

  const connection = await c.env.DB.prepare(
    `SELECT encrypted_access_token, display_name, profile_picture_url
     FROM linkedin_connections
     WHERE id = ? AND token_expires_at > ?`,
  )
    .bind(connectionId, Date.now())
    .first<{
      encrypted_access_token: string
      display_name: string | null
      profile_picture_url: string | null
    }>()

  if (!connection) {
    return c.json({ connected: false })
  }

  if (connection.display_name || connection.profile_picture_url) {
    return c.json({
      connected: true,
      displayName: connection.display_name,
      pictureUrl: connection.profile_picture_url,
    })
  }

  try {
    const profile = await getLinkedInProfile(
      await decrypt(connection.encrypted_access_token, c.env.TOKEN_ENCRYPTION_KEY),
    )

    await c.env.DB.prepare(
      `UPDATE linkedin_connections
       SET display_name = ?, profile_picture_url = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(profile.name ?? null, profile.picture ?? null, Date.now(), connectionId)
      .run()

    return c.json({
      connected: true,
      displayName: profile.name ?? null,
      pictureUrl: profile.picture ?? null,
    })
  } catch (error) {
    console.error('LinkedIn profile refresh failed:', error)
    return c.json({ connected: true, displayName: null, pictureUrl: null })
  }
})

app.post('/linkedin/publish', async (c) => {
  const body = await c.req.json<PublishRequest>()
  const connectionId = body.connectionId?.trim()
  const text = body.text?.trim()

  if (!connectionId || !text) {
    return c.json({ error: 'A connection and post text are required.' }, 400)
  }

  if (text.length > 3_000) {
    return c.json({ error: 'LinkedIn posts must be 3,000 characters or fewer.' }, 400)
  }

  const connection = await c.env.DB.prepare(
    `SELECT member_urn, encrypted_access_token
     FROM linkedin_connections
     WHERE id = ? AND token_expires_at > ?`,
  )
    .bind(connectionId, Date.now())
    .first<{member_urn: string; encrypted_access_token: string}>()

  if (!connection) {
    return c.json({ error: 'Your LinkedIn connection expired. Reconnect to continue.' }, 401)
  }

  const response = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await decrypt(connection.encrypted_access_token, c.env.TOKEN_ENCRYPTION_KEY)}`,
      'Content-Type': 'application/json',
      'Linkedin-Version': '202601',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: connection.member_urn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  })

  if (!response.ok) {
    console.error(`LinkedIn publish failed with status ${response.status}.`)
    return c.json({ error: 'LinkedIn could not publish this post. Try again shortly.' }, 502)
  }

  return c.json({ published: true, postId: response.headers.get('x-restli-id') })
})

app.get('/auth/linkedin/start', async (c) => {
  const connectionId = c.req.query('connection_id')

  if (!connectionId || connectionId.length < 16) {
    return c.json({ error: 'A secure connection ID is required.' }, 400)
  }

  const state = randomValue()
  const now = Date.now()

  await c.env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, connection_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256(state), connectionId, now + OAUTH_STATE_TTL_MS, now)
    .run()

  const authorizationUrl = new URL('https://www.linkedin.com/oauth/v2/authorization')
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: c.env.LINKEDIN_CLIENT_ID,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    state,
    scope: 'openid profile w_member_social',
  }).toString()

  return c.redirect(authorizationUrl.toString())
})

app.get('/auth/linkedin/callback', async (c) => {
  const error = c.req.query('error')
  const code = c.req.query('code')
  const state = c.req.query('state')

  if (error || !code || !state) {
    return connectionResult(false, 'LinkedIn connection was cancelled or incomplete.')
  }

  const stateHash = await sha256(state)
  const savedState = await c.env.DB.prepare(
    `SELECT connection_id, expires_at
     FROM oauth_states
     WHERE state_hash = ?`,
  )
    .bind(stateHash)
    .first<OAuthState>()

  await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?')
    .bind(stateHash)
    .run()

  if (!savedState || savedState.expires_at < Date.now()) {
    return connectionResult(false, 'This connection link expired. Return to VS Code and try again.')
  }

  const token = await exchangeCode(c.env, code)
  const profile = await getLinkedInProfile(token.access_token)
  const now = Date.now()

  await c.env.DB.prepare(
    `INSERT INTO linkedin_connections (
      id, member_urn, encrypted_access_token, token_expires_at, display_name, profile_picture_url, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_urn) DO UPDATE SET
       id = excluded.id,
       encrypted_access_token = excluded.encrypted_access_token,
       token_expires_at = excluded.token_expires_at,
       display_name = excluded.display_name,
       profile_picture_url = excluded.profile_picture_url,
       updated_at = excluded.updated_at`,
  )
    .bind(
      savedState.connection_id,
      `urn:li:person:${profile.sub}`,
      await encrypt(token.access_token, c.env.TOKEN_ENCRYPTION_KEY),
      now + token.expires_in * 1000,
      profile.name ?? null,
      profile.picture ?? null,
      now,
      now,
    )
    .run()

  return connectionResult(true, 'LinkedIn is connected. You can return to VS Code.')
})

app.onError((error, c) => {
  console.error(error.message)
  return c.json({ error: 'Something went wrong while connecting LinkedIn.' }, 500)
})

async function exchangeCode(env: Bindings, code: string): Promise<LinkedInToken> {
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
  })

  if (!response.ok) {
    throw new Error(`LinkedIn token exchange failed with status ${response.status}.`)
  }

  return response.json<LinkedInToken>()
}

async function getLinkedInProfile(accessToken: string): Promise<LinkedInProfile> {
  const response = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!response.ok) {
    throw new Error(`LinkedIn profile lookup failed with status ${response.status}.`)
  }

  return response.json<LinkedInProfile>()
}

async function encrypt(value: string, base64Key: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(base64Key),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value),
  )
  const combined = new Uint8Array(iv.length + encrypted.byteLength)

  combined.set(iv)
  combined.set(new Uint8Array(encrypted), iv.length)

  return bytesToBase64(combined)
}

async function decrypt(value: string, base64Key: string): Promise<string> {
  const combined = base64ToBytes(value)
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(base64Key),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  )

  return new TextDecoder().decode(decrypted)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return bytesToBase64(new Uint8Array(digest))
}

function randomValue(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ''

  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function connectionResult(success: boolean, message: string): Response {
  const title = success ? 'CodeLore is connected' : 'CodeLore could not connect'

  return new Response(
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
    {
      headers: { 'content-type': 'text/html; charset=UTF-8' },
      status: success ? 200 : 400,
    },
  )
}

export default app
