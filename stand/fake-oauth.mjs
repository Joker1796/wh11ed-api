// A stand-in for Yandex OAuth on the local stand — no account, no internet, no secrets.
//
// It answers the three requests the API makes of Yandex, in Yandex's own shapes, so the API runs
// its PRODUCTION sign-in code end to end (src/auth/oauth.ts, routes/auth.ts): the browser is sent
// to /authorize and picks a test player, the API trades the code at /token and reads the player at
// /info. Nothing in the API knows it is talking to a fake; config.ts only lets the stand point the
// three URLs here (OAUTH_YANDEX_*), and production never sets them.
//
// Players come from stand/players.json (the same file the seed fills the database from), plus any
// name typed into the form — a fresh empty account each time a new name is used.
//
// No dependencies: node stand/fake-oauth.mjs. Port 8790 (FAKE_OAUTH_PORT).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.FAKE_OAUTH_PORT || 8790)
const players = JSON.parse(readFileSync(new URL('./players.json', import.meta.url), 'utf8'))

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// A typed name becomes a stable id, so signing in as "Гоша" twice is the same account.
const customId = (name) => `c-${Buffer.from(name, 'utf8').toString('base64url')}`
function playerFor(id) {
  const known = players.find((p) => p.id === id)
  if (known) return known
  if (!id.startsWith('c-')) return null
  const name = Buffer.from(id.slice(2), 'base64url').toString('utf8')
  return name ? { id, name, email: `${id}@stand.local` } : null
}

// Only the stand's own API may be sent a code: the redirect must go back to localhost.
function allowedRedirect(raw) {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

function page(params) {
  const back = (code) => {
    const u = new URL(params.get('redirect_uri'))
    u.searchParams.set('code', code)
    u.searchParams.set('state', params.get('state') || '')
    return u.toString()
  }
  const cancel = new URL(params.get('redirect_uri'))
  cancel.searchParams.set('error', 'access_denied')
  cancel.searchParams.set('state', params.get('state') || '')
  const rows = players
    .map((p) => `<a class="p" href="${esc(back(p.id))}"><b>${esc(p.name)}</b><span>${esc(p.about || '')}</span></a>`)
    .join('')
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Стенд: вход</title>
<style>
  body{font:16px/1.4 system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;background:#f4f4f2;color:#111}
  h1{font-size:1.2rem} .note{color:#666;font-size:.85rem}
  .p{display:block;padding:.8rem 1rem;margin:.5rem 0;background:#fff;border:1px solid #ccc;color:inherit;text-decoration:none}
  .p:hover{border-color:#111} .p span{display:block;color:#666;font-size:.85rem}
  form{display:flex;gap:.5rem;margin:1rem 0} input{flex:1;padding:.6rem;font:inherit} button{padding:.6rem 1rem;font:inherit}
</style></head><body>
<h1>Вход на локальном стенде</h1>
<p class="note">Это не Яндекс — поддельный вход стенда (wh11ed-api/stand/fake-oauth.mjs). Выберите тестового игрока.</p>
${rows}
<form method="get" action="/authorize/custom">
  ${[...params].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
  <input name="player_name" placeholder="Или любое имя — новый пустой аккаунт" required maxlength="40">
  <button>Войти</button>
</form>
<p><a href="${esc(cancel.toString())}">Отказаться (как «Отмена» у Яндекса)</a></p>
</body></html>`
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return new URLSearchParams(raw)
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/authorize') {
    if (!allowedRedirect(url.searchParams.get('redirect_uri'))) return json(res, 400, { error: 'invalid_redirect_uri' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(page(url.searchParams))
  }

  if (req.method === 'GET' && url.pathname === '/authorize/custom') {
    const redirect = url.searchParams.get('redirect_uri')
    const name = (url.searchParams.get('player_name') || '').trim().slice(0, 40)
    if (!allowedRedirect(redirect) || !name) return json(res, 400, { error: 'invalid_request' })
    const u = new URL(redirect)
    u.searchParams.set('code', customId(name))
    u.searchParams.set('state', url.searchParams.get('state') || '')
    res.writeHead(302, { Location: u.toString() })
    return res.end()
  }

  // The code IS the player id: the stand has nothing to protect, and a readable code makes the
  // API's logs say who signed in.
  if (req.method === 'POST' && url.pathname === '/token') {
    const body = await readBody(req)
    const player = playerFor(body.get('code') || '')
    if (!player) return json(res, 400, { error: 'invalid_grant' })
    return json(res, 200, { access_token: `stand-${player.id}`, token_type: 'bearer', expires_in: 3600 })
  }

  if (req.method === 'GET' && url.pathname === '/info') {
    const auth = req.headers.authorization || ''
    const player = playerFor(auth.replace(/^OAuth stand-/, ''))
    if (!player) return json(res, 401, { error: 'invalid_token' })
    return json(res, 200, { id: player.id, login: player.id, default_email: player.email, display_name: player.name })
  }

  json(res, 404, { error: 'not_found' })
}).listen(PORT, () => console.log(`fake Yandex OAuth on http://localhost:${PORT}`))
