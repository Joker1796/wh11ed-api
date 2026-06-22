// Adapter between the Yandex API Gateway "HTTP integration" event/response shape and the
// WHATWG Request/Response that Hono speaks. This is the ONLY Yandex-specific code; everything
// in src/ stays portable.

export interface YcHttpEvent {
  httpMethod: string
  path?: string
  url?: string
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  queryStringParameters?: Record<string, string>
  multiValueQueryStringParameters?: Record<string, string[]>
  body?: string
  isBase64Encoded?: boolean
}

export interface YcHttpResponse {
  statusCode: number
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  body: string
  isBase64Encoded: boolean
}

type FetchLike = (req: Request) => Response | Promise<Response>

function buildUrl(event: YcHttpEvent): string {
  // Yandex API Gateway sends the REAL request path in `event.url`; `event.path` is the matched
  // operation template (e.g. "/{proxy+}" for the greedy proxy route), which must NOT be used for
  // routing. Take the path part of url (drop any query it carries) and rebuild the query from the
  // structured params below for canonical encoding. Fall back to `path` for non-gateway callers/tests.
  const path = (event.url ?? event.path ?? '/').split('?')[0]
  const qs = new URLSearchParams()
  if (event.multiValueQueryStringParameters) {
    for (const [k, vals] of Object.entries(event.multiValueQueryStringParameters)) {
      for (const v of vals) qs.append(k, v)
    }
  } else if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) qs.append(k, v)
  }
  const query = qs.toString()
  // Host is irrelevant to routing; use a stable placeholder origin.
  return `https://api.local${path}${query ? `?${query}` : ''}`
}

function buildHeaders(event: YcHttpEvent): Headers {
  const headers = new Headers()
  if (event.multiValueHeaders) {
    for (const [k, vals] of Object.entries(event.multiValueHeaders)) {
      for (const v of vals) headers.append(k, v)
    }
  } else if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) headers.set(k, v)
  }
  return headers
}

export function eventToRequest(event: YcHttpEvent): Request {
  const method = (event.httpMethod || 'GET').toUpperCase()
  const headers = buildHeaders(event)

  let body: string | Buffer | undefined
  if (event.body !== undefined && event.body !== '' && method !== 'GET' && method !== 'HEAD') {
    body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body
  }
  return new Request(buildUrl(event), { method, headers, body })
}

export async function responseToYc(res: Response): Promise<YcHttpResponse> {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') headers[key] = value
  })

  const multiValueHeaders: Record<string, string[]> = {}
  // getSetCookie() preserves each Set-Cookie as a separate entry (Node 18.14+).
  const setCookies = res.headers.getSetCookie?.() ?? []
  if (setCookies.length) multiValueHeaders['Set-Cookie'] = setCookies

  const buf = Buffer.from(await res.arrayBuffer())
  // Text content types pass through as-is; everything else is base64-encoded for safety.
  const ct = res.headers.get('content-type') ?? ''
  const isText = /json|text|xml|javascript|urlencoded/i.test(ct)
  return {
    statusCode: res.status,
    headers,
    ...(setCookies.length ? { multiValueHeaders } : {}),
    body: isText ? buf.toString('utf8') : buf.toString('base64'),
    isBase64Encoded: !isText,
  }
}

export function adapt(fetchLike: FetchLike) {
  return async (event: YcHttpEvent): Promise<YcHttpResponse> => {
    const request = eventToRequest(event)
    const response = await fetchLike(request)
    return responseToYc(response)
  }
}
