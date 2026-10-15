// Central, validated configuration. Reads from process.env (Lockbox-injected in production,
// .env in local dev). Fail fast if a required value is missing.

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

function int(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`)
  return n
}

export interface OAuthProviderConfig {
  clientId: string
  clientSecret: string
  authUrl: string
  tokenUrl: string
  userInfoUrl: string
  scope: string
  // Extra query parameters of the authorize URL, the provider's own switches.
  authParams?: Record<string, string>
}

// Env-derived values are lazy getters so merely importing `config` never throws — only
// *accessing* a missing required var does (keeps the domain layer importable in tests while
// preserving fail-fast at the server/handler entrypoints). Constants are plain fields.
export const config = {
  get allowedOrigins(): string[] {
    const raw = process.env.ALLOWED_ORIGINS
    if (!raw) {
      // No explicit allow-list. A localhost default is fine for local http dev, but in
      // production (https API) we refuse to fall back — an unset ALLOWED_ORIGINS there is
      // a misconfiguration that would otherwise silently weaken CSRF defence.
      if (this.apiBaseUrl.startsWith('https')) {
        throw new Error('Missing required env var: ALLOWED_ORIGINS')
      }
      return ['http://localhost:5173']
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  },
  get apiBaseUrl(): string {
    return req('API_BASE_URL').replace(/\/$/, '')
  },
  get appAfterLoginUrl(): string {
    return req('APP_AFTER_LOGIN_URL')
  },
  get cookieDomain(): string {
    return opt('COOKIE_DOMAIN')
  },

  get jwtSigningKey(): string {
    return req('JWT_SIGNING_KEY')
  },
  get accessTokenTtl(): number {
    return int('ACCESS_TOKEN_TTL_SECONDS', 900)
  },
  get refreshTokenTtl(): number {
    return int('REFRESH_TOKEN_TTL_SECONDS', 2_592_000)
  },

  // postgres://user:pass@host:port/db — the stand's compose file sets it, production's .env too.
  get databaseUrl(): string {
    return req('DATABASE_URL')
  },

  // Per-game payload cap and per-user game cap (defence-in-depth limits).
  maxGameBytes: 64 * 1024,
  maxGamesPerUser: 500,
  // Same for army lists. A big list measures well under 12 KB, so 32 KB is roomy; the per-user
  // cap is lower than games' because a collection of lists is curated, not accumulated.
  maxRosterBytes: 32 * 1024,
  maxRostersPerUser: 200,

  // A player's marks, one row per faction. 64 KB is far above a heavy shelf (a few hundred
  // datasheets, each a small timestamped cell) and still small enough that a runaway client
  // cannot fill the table; the scope cap is "every faction plus the pinned list", with room.
  maxPrefsScopeBytes: 64 * 1024,
  maxPrefsScopesPerUser: 80,
  // Live-broadcast payload (the client-projected read-only scoreboard, not the full game) and
  // how long an untouched broadcast row lives before the expiry sweep (db/sweep.ts) takes it.
  maxBroadcastBytes: 16 * 1024,
  broadcastTtlDays: 7,
  // A shared live game (routes/party.ts): one slice of a game per write. A whole side after five
  // rounds measures ~2 KB and a Strike Force list ~1–2 KB, so 32 KB is roomy without letting a
  // slice approach the game cap. A party nobody touched for a week is garbage; a join code is
  // typed across a table and dies in minutes.
  maxPartySliceBytes: 32 * 1024,
  partyTtlDays: 7,
  partyCodeTtlMinutes: 10,
  // Feedback notifications over plain SMTP (the stand points it at Mailpit). Entirely optional:
  // with no host or addresses the sender is inert and reports simply wait in
  // `npm run feedback:list`. User/password may be empty for a relay that takes none.
  mail: {
    get host(): string {
      return process.env.SMTP_HOST || ''
    },
    get port(): number {
      return int('SMTP_PORT', 587)
    },
    // true = TLS from the first byte (465); false = STARTTLS when the server offers it (587, 1025).
    get secure(): boolean {
      return process.env.SMTP_SECURE === 'true'
    },
    get user(): string {
      return process.env.SMTP_USER || ''
    },
    get pass(): string {
      return process.env.SMTP_PASS || ''
    },
    get from(): string {
      return process.env.FEEDBACK_MAIL_FROM || ''
    },
    get to(): string {
      return process.env.FEEDBACK_MAIL_TO || ''
    },
    get enabled(): boolean {
      return !!(this.host && this.from && this.to)
    },
  },

  // Bug reports: the player's text, the auto-collected tech context, the opt-in snapshot.
  maxFeedbackMessageBytes: 4 * 1024,
  maxFeedbackContextBytes: 16 * 1024,
  maxFeedbackAttachmentBytes: 64 * 1024,
} as const

// Only Yandex is supported. The provider abstraction is kept (rather than hardcoded) so another
// provider can be re-added here + in `ProviderName`/`isProviderName` without touching routes.
export type ProviderName = 'yandex'

export function oauthProvider(name: ProviderName): OAuthProviderConfig {
  switch (name) {
    case 'yandex':
      return {
        clientId: req('YANDEX_CLIENT_ID'),
        clientSecret: req('YANDEX_CLIENT_SECRET'),
        // Overridable for the local stand only, where stand/fake-oauth.mjs plays Yandex (README
        // "The local stand"). The authorize URL is opened by the BROWSER, the other two by this
        // server — inside docker they are different hosts, hence two variables.
        authUrl: process.env.OAUTH_YANDEX_AUTHORIZE_URL || 'https://oauth.yandex.ru/authorize',
        tokenUrl: `${process.env.OAUTH_YANDEX_SERVER_URL || 'https://oauth.yandex.ru'}/token`,
        userInfoUrl: `${process.env.OAUTH_YANDEX_INFO_URL || 'https://login.yandex.ru/info'}?format=json`,
        scope: 'login:email login:info',
        // Always ask which account (owner, 2026-10-10): a player with several Yandex accounts was
        // signed in at once with the one the browser held, no choice offered (Misha). Yandex shows
        // its consent page with the account switcher every time; one more tap for everybody else.
        authParams: { force_confirm: 'yes' },
      }
  }
}

export function isProviderName(v: string): v is ProviderName {
  return v === 'yandex'
}

// ─── Host-aware site resolution (domain migration; see wh11ed/MIGRATION.md) ─────────────────
// One process serves both api.wh11ed.ru and api.wh-rules.ru: Caddy passes the user-facing Host
// header through (it did the same as the Yandex API gateway until 2026-10-11), so the auth
// routes derive cookies/redirects/OAuth callback per request instead of from the single
// env-configured domain.
//
// Only Hosts matching the `api.<origin-host>` convention of an https ALLOWED_ORIGINS entry
// are recognised; anything else (localhost dev, direct invocation, unexpected domains) falls
// back to the env default. Never build redirects/cookies from an arbitrary Host — that would
// be an open redirect.
export interface Site {
  apiBaseUrl: string
  appAfterLoginUrl: string
  cookieDomain: string
}

export function siteForHost(host: string | undefined): Site {
  const fallback: Site = {
    apiBaseUrl: config.apiBaseUrl,
    appAfterLoginUrl: config.appAfterLoginUrl,
    cookieDomain: config.cookieDomain,
  }
  if (!host) return fallback
  const h = host.trim().toLowerCase().replace(/:\d+$/, '')
  for (const origin of config.allowedOrigins) {
    if (!origin.startsWith('https://')) continue
    const appHost = new URL(origin).hostname
    if (h !== `api.${appHost}`) continue
    const after = new URL(config.appAfterLoginUrl)
    return {
      apiBaseUrl: `https://${h}`,
      appAfterLoginUrl: `${origin}${after.pathname}${after.search}`,
      // Mirror the default's shape: if COOKIE_DOMAIN is unset (host-only cookies), stay
      // host-only for derived sites too; otherwise scope to the requested api host.
      cookieDomain: config.cookieDomain ? h : '',
    }
  }
  return fallback
}

// The origin a login asked to return to, when it is one of ours (https, allow-listed).
// Plain http is accepted only when this API itself runs on http — the local stand, where every
// "phone" is its own localhost port and must come back to its own tab. A production API is https
// and keeps refusing anything that is not.
export function returnOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  const ok = raw.startsWith('https://') || (raw.startsWith('http://') && config.apiBaseUrl.startsWith('http://'))
  if (!ok) return null
  return config.allowedOrigins.includes(raw) ? raw : null
}

// The post-login page on the site the login started from: the same path, that origin.
export function afterLogin(site: Site, back: string | undefined): string {
  const origin = returnOrigin(back)
  if (!origin) return site.appAfterLoginUrl
  const after = new URL(site.appAfterLoginUrl)
  return `${origin}${after.pathname}${after.search}`
}

export function redirectUri(name: ProviderName, site?: Site): string {
  return `${(site?.apiBaseUrl ?? config.apiBaseUrl)}/auth/${name}/callback`
}

// CORS origin policy (used by app.ts). A disallowed Origin gets the canonical origin back
// instead of no header: when the app omitted Access-Control-Allow-Origin, the Yandex
// gateway/function layer it ran on until 2026-10-11 filled in `*` (+ allow-credentials: true),
// re-opening what the allow-list closed — and any proxy in front can do the same. An explicit mismatching value keeps
// browsers blocking and leaves nothing to fill in. Lives here (not app.ts) so tests can import
// it without the route graph.
export function corsOrigin(origin: string): string {
  const allowed = config.allowedOrigins
  // allowedOrigins is never empty (the getter throws or falls back to localhost), so the
  // `?? origin` arm exists only to satisfy noUncheckedIndexedAccess.
  return allowed.includes(origin) ? origin : (allowed[0] ?? origin)
}
