import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('设置页挂到 0.2.0-rc.2 的槽，并兼容旧的 keyed 槽', () => {
  assert.match(src, /mountCard\('settings\.plugins\.tab', false\)/)
  assert.match(src, /mountCard\('plugins\.detail\.section', false\)/)
  assert.match(src, /mountCard\('settings\.plugin\.item', true\)/)
  assert.match(src, /options\.key = NS/)
})

test('401/403 不调用 response.json', () => {
  assert.match(src, /if \(!response\.ok\)/)
  assert.match(src, /response\.status === 401/)
  assert.match(src, /response\.status === 403/)
  const okBranch = src.split('if (!response.ok)')[1].split('return response.json()')[0]
  assert.equal(okBranch.includes('response.json'), false)
})
