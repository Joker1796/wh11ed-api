import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { siteForHost, redirectUri } from '../src/config.js'

// config reads env lazily per access (see config.ts), so plain assignment is enough.
beforeEach(() => {
  process.env.ALLOWED_ORIGINS = 'https://wh11ed.ru,https://wh-rules.ru'
  process.env.API_BASE_URL = 'https://api.wh11ed.ru'
  process.env.APP_AFTER_LOGIN_URL = 'https://wh11ed.ru/tracker/auth-callback'
  process.env.COOKIE_DOMAIN = 'api.wh11ed.ru'
})

test('siteForHost: the new domain derives its own cookie/redirect/callback config', () => {
  assert.deepEqual(siteForHost('api.wh-rules.ru'), {
    apiBaseUrl: 'https://api.wh-rules.ru',
    appAfterLoginUrl: 'https://wh-rules.ru/tracker/auth-callback',
    cookieDomain: 'api.wh-rules.ru',
  })
})

test('siteForHost: the old domain matches the env default', () => {
  assert.deepEqual(siteForHost('api.wh11ed.ru'), {
    apiBaseUrl: 'https://api.wh11ed.ru',
    appAfterLoginUrl: 'https://wh11ed.ru/tracker/auth-callback',
    cookieDomain: 'api.wh11ed.ru',
  })
})

test('siteForHost: unknown/localhost/absent Hosts fall back to the env default', () => {
  const fallback = {
    apiBaseUrl: 'https://api.wh11ed.ru',
    appAfterLoginUrl: 'https://wh11ed.ru/tracker/auth-callback',
    cookieDomain: 'api.wh11ed.ru',
  }
  assert.deepEqual(siteForHost('api.evil.example'), fallback) // never reflect arbitrary Hosts
  assert.deepEqual(siteForHost('wh-rules.ru'), fallback) // app host, not the api.<host> form
  assert.deepEqual(siteForHost('localhost:8787'), fallback)
  assert.deepEqual(siteForHost(undefined), fallback)
})

test('siteForHost: port and case are normalized away', () => {
  assert.equal(siteForHost('API.WH-RULES.RU:443').apiBaseUrl, 'https://api.wh-rules.ru')
})

test('siteForHost: host-only cookies (empty COOKIE_DOMAIN) stay host-only when derived', () => {
  process.env.COOKIE_DOMAIN = ''
  assert.equal(siteForHost('api.wh-rules.ru').cookieDomain, '')
})

test('redirectUri: follows the site, defaults to the env base', () => {
  assert.equal(redirectUri('yandex'), 'https://api.wh11ed.ru/auth/yandex/callback')
  assert.equal(
    redirectUri('yandex', siteForHost('api.wh-rules.ru')),
    'https://api.wh-rules.ru/auth/yandex/callback',
  )
})
