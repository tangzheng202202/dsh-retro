import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function mockRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body == null ? '' : String(body) },
  }
}

function ownerConnection(decide) {
  return {
    admit(req) {
      const result = decide(req)
      if (result) return result
      return { peer: { principal: { kind: 'owner' } } }
    },
  }
}

function mount(dir, connection) {
  let route
  const httpCtx = {
    get(name) { return name === 'connection' ? connection : undefined },
    effect(fn) { return fn() },
    webServer: {
      register(r) { route = r; return () => { route = undefined } },
    },
  }
  const ctx = {
    registered: [],
    on() {},
    tools: { register(def) { ctx.registered.push(def) } },
    inject(deps, cb) {
      if (deps.includes('webServer')) cb(httpCtx)
      return []
    },
    get() { return undefined },
  }
  apply(ctx, { enabled: true, storageDir: dir, inbox: false, skillsDir: join(dir, 'skills') })
  assert.ok(route, 'web route was not registered')
  return route
}

function call(route, url, connectionHeaders) {
  const req = { method: 'GET', url, headers: connectionHeaders || {} }
  const res = mockRes()
  route.handler(req, res)
  return res
}

test('GET /retro/state 未鉴权不返回路径和统计', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-http-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'secret.json'), '{"kind":"retro","skillCandidates":[]}')
  try {
    const cases = [
      ['没有 connection', undefined, 401, 'unauthorized'],
      ['admit 401', ownerConnection(() => ({ rejection: 401 })), 401, 'unauthorized'],
      ['admit 403', ownerConnection(() => ({ rejection: 403 })), 403, 'forbidden'],
      ['非 owner', ownerConnection(() => ({ peer: { principal: { kind: 'guest' } } })), 403, 'forbidden'],
      ['admit 抛错', { admit() { throw new Error(dir) } }, 401, 'unauthorized'],
    ]
    for (const [label, connection, status, body] of cases) {
      const route = mount(dir, connection)
      const res = call(route, '/retro/state')
      assert.equal(res.status, status, label)
      assert.equal(res.body, body, label)
      assert.equal(res.body.includes(dir), false, label)
      assert.equal(res.body.includes('storageRoot'), false, label)
      assert.equal(res.body.includes('secret'), false, label)
      const other = call(route, '/retro/other')
      assert.equal(other.status, status, label + ' other')
      assert.equal(other.body.includes(dir), false, label + ' other')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /retro/state 已登录 owner 返回统计，但不带绝对路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-http-ok-'))
  try {
    const route = mount(dir, ownerConnection(() => null))
    const res = call(route, '/retro/state?x=1')
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.counts.pending, 0)
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'storageRoot'), false)
    assert.equal(res.body.includes(dir), false)
    const missing = call(route, '/retro/nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.includes(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
