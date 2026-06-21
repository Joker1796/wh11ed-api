import * as grpc from '@grpc/grpc-js'

// Lightweight replacement for ydb-sdk's MetadataAuthService, which otherwise drags in the whole
// @yandex-cloud/nodejs-sdk. Inside a Cloud Function the attached service account's IAM token is
// available from the instance metadata endpoint; we fetch, cache, and refresh it.

const METADATA_URL =
  'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token'

interface CachedToken {
  token: string
  expiresAt: number // epoch ms
}

export class MetadataTokenAuthService {
  private cached: CachedToken | null = null
  private inflight: Promise<string> | null = null

  async getAuthMetadata(): Promise<grpc.Metadata> {
    const token = await this.getToken()
    const metadata = new grpc.Metadata()
    metadata.add('x-ydb-auth-ticket', token)
    return metadata
  }

  private async getToken(): Promise<string> {
    const now = Date.now()
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token
    if (this.inflight) return this.inflight
    this.inflight = this.fetchToken()
      .then((t) => {
        this.cached = t
        return t.token
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  private async fetchToken(): Promise<CachedToken> {
    const res = await fetch(METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' } })
    if (!res.ok) throw new Error(`Metadata token request failed: ${res.status}`)
    const json = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new Error('Metadata token response missing access_token')
    return {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    }
  }
}
