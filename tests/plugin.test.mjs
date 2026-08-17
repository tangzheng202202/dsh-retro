import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function makeFakeCtx() {
  const handlers = new Map()
  const registered = []
  return {
    registered,
    emit(name, ...args) {
      for (const h of handlers.get(name) || []) h(...args)
    },
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]) },
    tools: { register(def) { registered.push(def) } },
    inject() { return [] },
    get() { return undefined },
  }
}

const SESSION = { id: 'smoke-sess', header: { createdAt: 1000 } }

test('enabled:false → 不注册工具', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-off-'))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(ctx.registered.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('enabled:true → 事件流产出 turn-trace 与 session-summary，retro_review 可写复盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-on-'))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, inbox: false })

  assert.equal(ctx.registered.length, 6) // retro_review + retro_inbox + skill_promote + skill_reject + skill_probe + retro_telemetry
  assert.equal(ctx.registered[0].name, 'retro_review')

  const emit = (type, data) => ctx.emit('session/event', SESSION, { type, data, time: Date.now() })

  emit('turn/start', { turn: 1 })
  emit('step/start', { turn: 1, step: 1 })
  emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
  emit('tool/result', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c1' } } })
  emit('user/message', { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不对，重来' }] } })
  emit('todo/write', { todos: [{ content: 'x', status: 'pending' }] })
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.emit('session/flush', SESSION)

  const turnsFiles = readdirSync(join(dir, 'turns'))
  assert.equal(turnsFiles.length, 1)
  const trace = JSON.parse(readFileSync(join(dir, 'turns', turnsFiles[0]), 'utf8'))
  assert.equal(trace.kind, 'turn-trace')
  assert.equal(trace.toolCalls.length, 1)
  assert.equal(trace.toolCalls[0].ok, true)
  assert.equal(trace.corrections, 1)

  const summary = JSON.parse(readFileSync(join(dir, 'sessions', 'smoke-sess.json'), 'utf8'))
  assert.equal(summary.kind, 'session-summary')
  assert.equal(summary.toolCalls.total, 1)
  assert.equal(summary.todoWrites, 1)

  const tool = ctx.registered[0]
  const result = await tool.execute({
    taskType: 'plugin-dev', outcome: 'success', summary: '冒烟',
    patterns: ['用 fake ctx 测插件'],
    pitfalls: [{ symptom: 's', cause: 'c', fix: 'f' }],
    memoryFacts: ['fake ctx 冒烟事实'],
  })
  assert.equal(result.pushedToViking, 0)
  assert.ok(result.retroId.startsWith('external-')) // fake ctx 无 agent → session 缺省为 external

  // exec.agent 路径：session 应归属调用 agent 的会话
  const result2 = await tool.execute({ taskType: 'x', outcome: 'success' }, { agent: { session: SESSION } })
  assert.ok(result2.retroId.startsWith('smoke-sess-'))
  const retroFile = readdirSync(join(dir, 'retros')).find((f) => f.endsWith('.json'))
  const retro = JSON.parse(readFileSync(join(dir, 'retros', retroFile), 'utf8'))
  assert.equal(retro.taskType, 'plugin-dev')
  assert.equal(retro.memoryFacts.length, 1)

  rmSync(dir, { recursive: true, force: true })
})

test('inbox 投递在 apply 启动扫描时被摄入并移动到 processed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-inbox-'))
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  writeFileSync(join(dir, 'inbox', 'manual.json'), JSON.stringify({ sessionId: 'ext-1', taskType: 'deploy', outcome: 'failed', pitfalls: [{ symptom: 'a', cause: 'b', fix: 'c' }] }))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, inbox: true, inboxIntervalMs: 600000 })

  const retroFiles = readdirSync(join(dir, 'retros')).filter((f) => f.endsWith('.json'))
  assert.equal(retroFiles.length, 1)
  assert.equal(readdirSync(join(dir, 'processed')).length, 1)
  const retro = JSON.parse(readFileSync(join(dir, 'retros', retroFiles[0]), 'utf8'))
  assert.equal(retro.sessionId, 'ext-1')
  assert.equal(retro.outcome, 'failed')

  rmSync(dir, { recursive: true, force: true })
})