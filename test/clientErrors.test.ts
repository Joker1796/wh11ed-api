import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { browserOf, compareVersions, fingerprint, isOpen, normalizeMessage, normalizeRoute, parseClientErrors, topFrame, ClientErrorsTooLarge, MAX_BODY_BYTES } from '../src/domain/clientErrors.js'

const chrome = `TypeError: Cannot read properties of undefined (reading 'units')
    at loadArmy (https://wh-rules.ru/assets/RosterEditorView-BJ-1xCnO.js:12:345)
    at async x (https://wh-rules.ru/assets/index-Ca3rswaK.js:1:2)`

describe('client errors: the same error is one row', () => {
  it('ignores the chunk hash, the line and the column', () => {
    const later = chrome.replace('BJ-1xCnO', 'Zz9-YyQq').replace(':12:345', ':14:9')
    assert.equal(topFrame(chrome), 'loadArmy@RosterEditorView.js')
    assert.equal(fingerprint({ kind: 'error', msg: 'x', stack: chrome }), fingerprint({ kind: 'error', msg: 'x', stack: later }))
  })
  it('reads a Safari / Firefox frame', () => {
    assert.equal(topFrame('loadArmy@https://wh-rules.ru/assets/RosterEditorView-BJ-1xCnO.js:12:345'), 'loadArmy@RosterEditorView.js')
  })
  it('folds numbers, ids and addresses in the message', () => {
    assert.equal(normalizeMessage('Failed to fetch https://wh-rules.ru/a.js at 12'), 'Failed to fetch <url> at N')
    assert.equal(normalizeMessage('roster 1a2b3c4d-1111-2222-3333-444455556666 gone'), 'roster <id> gone')
  })
  it('keeps different errors apart', () => {
    assert.notEqual(fingerprint({ kind: 'error', msg: 'a', stack: chrome }), fingerprint({ kind: 'rejection', msg: 'a', stack: chrome }))
    assert.notEqual(fingerprint({ kind: 'error', msg: 'a' }), fingerprint({ kind: 'error', msg: 'b' }))
  })
})

describe('client errors: nothing about the sender is kept', () => {
  it('drops the query and the hash of a route and folds ids', () => {
    assert.equal(normalizeRoute('/ru/roster/shared#r=1.abcdef'), '/ru/roster/shared')
    assert.equal(normalizeRoute('/ru/roster/1a2b3c4d-1111-2222-3333-444455556666/view?x=1'), '/ru/roster/:id/view')
  })
  it('keeps a browser family and a system, not the user agent', () => {
    assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1'), 'Safari iOS')
    assert.equal(browserOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 YaBrowser/24.1 Safari/537.36'), 'Yandex Windows')
    assert.equal(browserOf('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Chrome Android')
    assert.equal(browserOf(undefined), 'unknown')
  })
})

describe('client errors: the payload', () => {
  const ok = { channel: 'prod', appVersion: '2.9.1', errors: [{ kind: 'error', msg: 'boom', stack: chrome }] }
  it('takes a batch, and a hello with no errors', () => {
    assert.equal(parseClientErrors(JSON.stringify(ok)).errors.length, 1)
    assert.deepEqual(parseClientErrors(JSON.stringify({ channel: 'beta', appVersion: '2.9.1', hello: true })).errors, [])
  })
  it('refuses another channel, a bad version, too many errors, an overlong message, a big body', () => {
    assert.throws(() => parseClientErrors(JSON.stringify({ ...ok, channel: 'dev' })))
    assert.throws(() => parseClientErrors(JSON.stringify({ ...ok, appVersion: 'latest' })))
    assert.throws(() => parseClientErrors(JSON.stringify({ ...ok, errors: Array(11).fill(ok.errors[0]) })))
    assert.throws(() => parseClientErrors(JSON.stringify({ ...ok, errors: [{ kind: 'error', msg: 'x'.repeat(501) }] })))
    assert.throws(() => parseClientErrors('x'.repeat(MAX_BODY_BYTES + 1)), ClientErrorsTooLarge)
  })
})

describe('client errors: versions', () => {
  it('compares as numbers', () => {
    assert.ok(compareVersions('2.10.0', '2.9.1') > 0)
    assert.equal(compareVersions('2.9.1', '2.9.1'), 0)
  })
  it('an error sent by a version after its fix is open again', () => {
    assert.equal(isOpen({ app_version: '2.9.1', resolved_in: '2.9.2' }), false)
    assert.equal(isOpen({ app_version: '2.10.0', resolved_in: '2.9.2' }), true)
    assert.equal(isOpen({ app_version: '2.9.1', resolved_in: null }), true)
  })
})
