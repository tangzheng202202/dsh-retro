import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
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
    inject() { return [] },
    get() { return undefined },
  }
}

const CAND = {
  kind: 'retro', version: 1, id: 'r-a3', sessionId: 's-1', createdAt: Date.now(),
  taskType: 'plugin-dev', outcome: 'success',
  skillCandidates: [
    { name: 'a3-test-skill', trigger: '测试 A3 门禁用的候选 skill，触发场景足够长以通过 lint 描述长度检查', instructions: '这是一个用于测试 A3 judge/probe 门禁的候选 skill 指令，内容足够长且不包含任何密钥。', confidence: 0.8 },
  ],
}

function findTool(ctx, name) { return ctx.registered.find((t) => t.name === name) }
const JUDGE_PASS = { verdict: 'pass', evidence: 'a3-test-skill 候选指令完整、命名合规、无密钥特征，具备可执行性，批准晋升', risks: '无' }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a3-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'r-a3.json'), JSON.stringify(CAND))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  return { dir, ctx }
}

test('A3: requireJudge 默认开 → 无 judge 调用被拒', async () => {
  const { dir, ctx } = setup()
  const r = await findTool(ctx, 'skill_promote').execute({ name: 'a3-test-skill' })
  assert.equal(r.ok, false)
  assert.ok(r.issues[0].includes('judge 门拒绝'))
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates[0].status, 'rejected')
  rmSync(dir, { recursive: true, force: true })
})

test('A3: judge.verdict=fail → 拒绝', async () => {
  const { dir, ctx } = setup()
  const r = await findTool(ctx, 'skill_promote').execute({ name: 'a3-test-skill', judge: { verdict: 'fail', evidence: '该候选指令含糊，无法执行，存在歧义，建议重写后再提交' } })
  assert.equal(r.ok, false)
  rmSync(dir, { recursive: true, force: true })
})

test('A3: judge pass + evidence 足够 → 晋升并记录 judge', async () => {
  const { dir, ctx } = setup()
  const r = await findTool(ctx, 'skill_promote').execute({ name: 'a3-test-skill', judge: JUDGE_PASS })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(existsSync(join(dir, 'skills', 'a3-test-skill.md')), true)
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  const c = db.candidates[0]
  assert.equal(c.status, 'promoted')
  assert.equal(c.judge.verdict, 'pass')
  assert.ok(c.judge.at)
  rmSync(dir, { recursive: true, force: true })
})

test('A3: failed probe 阻止晋升', async () => {
  const { dir, ctx } = setup()
  const probe = findTool(ctx, 'skill_probe')
  assert.ok(probe)
  const p = await probe.execute({ name: 'a3-test-skill', task: '按指令试跑', outcome: 'failed', findings: '指令缺步骤导致失败' })
  assert.equal(p.probeStatus, 'failed')
  const r = await findTool(ctx, 'skill_promote').execute({ name: 'a3-test-skill', judge: JUDGE_PASS })
  assert.equal(r.ok, false)
  assert.ok(r.issues[0].includes('probe 门拒绝'))
  rmSync(dir, { recursive: true, force: true })
})

test('A3: passed probe + judge → 晋升并回填 probe', async () => {
  const { dir, ctx } = setup()
  await findTool(ctx, 'skill_probe').execute({ name: 'a3-test-skill', task: '按指令试跑', outcome: 'passed', findings: '对照无 skill 基线，本次执行更快且无需猜测步骤' })
  const r = await findTool(ctx, 'skill_promote').execute({ name: 'a3-test-skill', judge: JUDGE_PASS })
  assert.equal(r.ok, true)
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates[0].probe.status, 'passed')
  assert.ok(db.candidates[0].probe.at)
  rmSync(dir, { recursive: true, force: true })
})

test('A3: requireJudge=false 保持旧行为（无 judge 也可晋升）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a3-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'r-a3.json'), JSON.stringify(CAND))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false, requireJudge: false })
  const r = await findTool(ctx, 'skill_promote').execute({ name: 'a3-test-skill' })
  assert.equal(r.ok, true)
  rmSync(dir, { recursive: true, force: true })
})