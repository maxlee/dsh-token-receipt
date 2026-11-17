import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createReceiptService, PACKAGE_VERSION } from '../index.js'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const client = readFileSync(new URL('client.js', root), 'utf8')

function fakeRes() {
  let body = ''
  let statusCode = 0
  let headers = {}
  return {
    writeHead(code, value) { statusCode = code; headers = value || {} },
    end(chunk) { body = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
    get statusCode() { return statusCode },
    get headers() { return headers },
    get text() { return body },
  }
}

test('client version constant matches package version', () => {
  const match = /const CLIENT_VERSION = '([^']+)'/.exec(client)
  assert.ok(match, 'client.js must declare CLIENT_VERSION')
  assert.equal(match[1], pkg.version)
  assert.equal(PACKAGE_VERSION, pkg.version)
})

test('version probe answers the installed package version', async () => {
  const service = createReceiptService({ get: () => undefined })
  const res = fakeRes()
  await service.handler({ method: 'GET', url: '/api/token-receipt?version=1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.text), { ok: true, version: pkg.version })
  service.dispose()
})

test('version probe rejects non-GET methods like the receipt endpoint', async () => {
  const service = createReceiptService({ get: () => undefined })
  const res = fakeRes()
  await service.handler({ method: 'POST', url: '/api/token-receipt?version=1' }, res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
  service.dispose()
})
