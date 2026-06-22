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

  ydb: {
    get endpoint(): string {
      // ydb-sdk's Driver needs a scheme; Yandex's `ydb_api_endpoint` (injected by Terraform) comes
      // as a bare "host:port", so default to grpcs:// when no scheme is present.
      const e = req('YDB_ENDPOINT')
      return /^grpcs?:\/\//.test(e) ? e : `grpcs://${e}`
    },
    get database(): string {
      return req('YDB_DATABASE')
    },
    get accessToken(): string {
      return opt('YDB_ACCESS_TOKEN')
    },
  },

  // Per-game payload cap and per-user game cap (defence-in-depth limits).
  maxGameBytes: 64 * 1024,
  maxGamesPerUser: 500,
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
        authUrl: 'https://oauth.yandex.ru/authorize',
        tokenUrl: 'https://oauth.yandex.ru/token',
        userInfoUrl: 'https://login.yandex.ru/info?format=json',
        scope: 'login:email login:info',
      }
  }
}

export function isProviderName(v: string): v is ProviderName {
  return v === 'yandex'
}

export function redirectUri(name: ProviderName): string {
  return `${config.apiBaseUrl}/auth/${name}/callback`
}
