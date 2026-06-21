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
    return opt('ALLOWED_ORIGINS', 'http://localhost:5173')
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
      return req('YDB_ENDPOINT')
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

export type ProviderName = 'google' | 'yandex'

export function oauthProvider(name: ProviderName): OAuthProviderConfig {
  switch (name) {
    case 'google':
      return {
        clientId: req('GOOGLE_CLIENT_ID'),
        clientSecret: req('GOOGLE_CLIENT_SECRET'),
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        scope: 'openid email profile',
      }
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
  return v === 'google' || v === 'yandex'
}

export function redirectUri(name: ProviderName): string {
  return `${config.apiBaseUrl}/auth/${name}/callback`
}
