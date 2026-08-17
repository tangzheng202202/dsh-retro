import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function makeFakeCtx() {
  const handlers = new Map()
  const registered = []
  return {
    registered,
    emit(name, ...args) { for (const h of handlers.get(name) || []) h(...args) },
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]) },
    tools: { register(def) { registered.push(def) } },
    get() { return undefined },
    inject() { return [] },
  }
}

const T0 = 1_700_000_000_000
const BEFORE = T0 - 86_400_000
const AFTER = T0 + 86_400_000

function sessionSummary(sessionId, closedAt, total, failed, corrections, userMessages) {
  return {
    kind: 'session-summary', version: 1, sessionId, createdAt: closedAt - 1000, closedAt,
    turns: 1, steps: total,
    toolCalls: { total, ok: total - failed, failed, byName: {} },
    userMessages, assistantMessages: 1, corrections, todoWrites: 0, worthRetro: true,
  }
}

function retroRecord(sessionId, taskType) {
  return { kind: 'retro', version: 1, id: 'r-' + sessionId, sessionId, createdAt: T0, taskType, outcome: 'success', skillCandidates: [] }
}

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a4-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  return dir
}

function promotedCandidate(extra = {}) {
  return {
    candidates: [{
      name: 'a4-skill', description: 'A4 遥测测试候选，描述足够长以通过 lint 描述长度检查', whenToUse: 'x',
      instructions: 'A4 遥测测试用的候选技能指令，内容足够长。', confidence: 0.8,
      sourceRetroId: 'r-s-b1', sourceSessionId: 's-b1', sourceTaskType: 'plugin-dev',
      status: 'promoted', createdAt: T0 - 1000, decidedAt: T0, note: '', promotedPath: null, judge: null, probe: null,
      ...extra,
    }],
  }
}

function boot(afterFail) {
  const dir = makeDir()
  const retroSessions = ['s-b1', 's-b2', 's-b3', 's-a1', 's-a2', 's-a3']
  for (const sid of retroSessions) writeFileSync(join(dir, 'retros', 'r-' + sid + '.json'), JSON.stringify(retroRecord(sid, 'plugin-dev')))
  const before = ['s-b1', 's-b2', 's-b3'].map((sid, i) => sessionSummary(sid, BEFORE + i * 1000, 10, 1, 0, 3))
  const after = ['s-a1', 's-a2', 's-a3'].map((sid, i) => sessionSummary(sid, AFTER + i * 1000, 10, Math.round(afterFail * 10), 0, 3))
  for (const s of [...before, ...after]) writeFileSync(join(dir, 'sessions', s.sessionId + '.json'), JSON.stringify(s))
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(promotedCandidate()))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  const telemetry = ctx.registered.find((t) => t.name === 'retro_telemetry')
  return { dir, ctx, telemetry }
}

test('A4: after 恶化（failRate 0.1→0.6，样本≥3）→ deprecated 且自动降级', async () => {
  const { dir, telemetry } = boot(0.6)
  const r = await telemetry.execute({})
  assert.equal(r.summary.deprecated, 1)
  assert.equal(r.skills[0].verdict, 'deprecated')
  assert.equal(r.skills[0].samplesBefore, 3)
  assert.equal(r.skills[0].samplesAfter, 3)
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates[0].status, 'deprecated')
  assert.match(db.candidates[0].note, /telemetry 自动降级/)
  assert.ok(db.candidates[0].telemetry.checkedAt)
  assert.equal(db.candidates[0].telemetry.verdict, 'deprecated') // telemetry 已持久化到账本
  rmSync(dir, { recursive: true, force: true })
})

test('A4: after 持平（0.1→0.1）→ healthy，不降级', async () => {
  const { dir, telemetry } = boot(0.1)
  const r = await telemetry.execute({})
  assert.equal(r.summary.healthy, 1)
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates[0].status, 'promoted')
  rmSync(dir, { recursive: true, force: true })
})

test('A4: after 样本不足（<3）→ insufficient', async () => {
  const dir = makeDir()
  for (const sid of ['s-b1', 's-a1']) writeFileSync(join(dir, 'retros', 'r-' + sid + '.json'), JSON.stringify(retroRecord(sid, 'plugin-dev')))
  writeFileSync(join(dir, 'sessions', 's-b1.json'), JSON.stringify(sessionSummary('s-b1', BEFORE, 10, 1, 0, 3)))
  writeFileSync(join(dir, 'sessions', 's-a1.json'), JSON.stringify(sessionSummary('s-a1', AFTER, 10, 6, 0, 3)))
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(promotedCandidate()))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  const telemetry = ctx.registered.find((t) => t.name === 'retro_telemetry')
  const r = await telemetry.execute({})
  assert.equal(r.summary.insufficient, 1)
  assert.equal(r.skills[0].verdict, 'insufficient')
  rmSync(dir, { recursive: true, force: true })
})

test('A4: retro_review 提交后自动刷新遥测并降级', async () => {
  const { dir, ctx } = boot(0.6)
  const retro = ctx.registered.find((t) => t.name === 'retro_review')
  await retro.execute({ taskType: 'plugin-dev', outcome: 'success' })
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates[0].status, 'deprecated')
  rmSync(dir, { recursive: true, force: true })
})