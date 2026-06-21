import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventToRequest, responseToYc, type YcHttpEvent } from '../adapters/yc-apigw.js'

test('eventToRequest: builds method, path, query and headers', async () => {
  const event: YcHttpEvent = {
    httpMethod: 'GET',
    path: '/games',
    headers: { Authorization: 'Bearer abc' },
    queryStringParameters: { limit: '50' },
  }
  const req = eventToRequest(event)
  assert.equal(req.method, 'GET')
  const url = new URL(req.url)
  assert.equal(url.pathname, '/games')
  assert.equal(url.searchParams.get('limit'), '50')
  assert.equal(req.headers.get('authorization'), 'Bearer abc')
})

test('eventToRequest: decodes base64 body for non-GET', async () => {
  const body = JSON.stringify({ id: 'g1' })
  const event: YcHttpEvent = {
    httpMethod: 'PUT',
    path: '/games/g1',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(body, 'utf8').toString('base64'),
    isBase64Encoded: true,
  }
  const req = eventToRequest(event)
  assert.deepEqual(await req.json(), { id: 'g1' })
})

test('responseToYc: passes JSON through as text and surfaces status', async () => {
  const res = new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
  const yc = await responseToYc(res)
  assert.equal(yc.statusCode, 201)
  assert.equal(yc.isBase64Encoded, false)
  assert.deepEqual(JSON.parse(yc.body), { ok: true })
})

test('responseToYc: collects multiple Set-Cookie headers into multiValueHeaders', async () => {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  headers.append('Set-Cookie', 'a=1; Path=/')
  headers.append('Set-Cookie', 'b=2; Path=/auth')
  const res = new Response('{}', { headers })
  const yc = await responseToYc(res)
  assert.deepEqual(yc.multiValueHeaders?.['Set-Cookie'], ['a=1; Path=/', 'b=2; Path=/auth'])
})
