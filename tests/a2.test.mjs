import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
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

const RETRO_WITH_CANDIDATES = {
  kind: 'retro', version: 1, id: 'r-1', sessionId: 's-1', createdAt: Date.now(),
  taskType: 'plugin-dev', outcome: 'success',
  skillCandidates: [
    { name: 'dsh-plugin-zero-dep', trigger: '写 DSH 宿主插件时', instructions: '单文件 lib/index.js + raw JSON Schema 工具注册 + ctx.on 事件监听 + cordis.patch.yml insert；默认 enabled:false', confidence: 0.9 },
    { name: 'Bad Name!', trigger: '非法命名', instructions: '这个候选的名字不符合 kebab-case，用于测试 lint 拒绝', confidence: 0.5 },
  ],
}

function findTool(ctx, name) { return ctx.registered.find((t) => t.name === name) }

test('A2: 启动收割 → inbox 列出 pending 候选（含去重）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a2-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'r-1.json'), JSON.stringify(RETRO_WITH_CANDIDATES))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })

  const inbox = findTool(ctx, 'retro_inbox')
  assert.ok(inbox)
  const v = await inbox.execute({ status: 'pending' })
  assert.equal(v.count, 2)
  assert.ok(v.candidates.some((c) => c.name === 'dsh-plugin-zero-dep'))

  // 重复收割不重复入账（幂等）
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates.filter((c) => c.name === 'dsh-plugin-zero-dep').length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('A2: skill_promote lint 拒绝非法命名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a2-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'r-1.json'), JSON.stringify(RETRO_WITH_CANDIDATES))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  const promote = findTool(ctx, 'skill_promote')
  const r = await promote.execute({ name: 'Bad Name!' })
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.includes('kebab-case')))
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates.find((c) => c.name === 'Bad Name!').status, 'rejected')
  rmSync(dir, { recursive: true, force: true })
})

test('A2: skill_promote 成功 → 写技能文件 + 记账 promoted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a2-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'r-1.json'), JSON.stringify(RETRO_WITH_CANDIDATES))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  const promote = findTool(ctx, 'skill_promote')
  const r = await promote.execute({ name: 'dsh-plugin-zero-dep', judge: { verdict: 'pass', evidence: '候选完整且通过机械检查，指令可执行，无密钥风险', risks: '无' } })
  assert.equal(r.ok, true, JSON.stringify(r))
  const file = join(dir, 'skills', 'dsh-plugin-zero-dep.md')
  assert.equal(existsSync(file), true)
  const content = readFileSync(file, 'utf8')
  assert.match(content, /^name: dsh-plugin-zero-dep$/m)
  assert.match(content, /^description: "写 DSH 宿主插件时"$/m)
  assert.match(content, /单文件 lib\/index\.js/)
  const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
  assert.equal(db.candidates.find((c) => c.name === 'dsh-plugin-zero-dep').status, 'promoted')
  rmSync(dir, { recursive: true, force: true })
})

test('A2: skill_promote 冲突保护与 overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a2-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'r-1.json'), JSON.stringify(RETRO_WITH_CANDIDATES))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  const promote = findTool(ctx, 'skill_promote')
  await promote.execute({ name: 'dsh-plugin-zero-dep', judge: { verdict: 'pass', evidence: '候选完整且通过机械检查，指令可执行，无密钥风险', risks: '无' } })
  // 已 promoted → 拒绝重复
  const again = await promote.execute({ name: 'dsh-plugin-zero-dep', judge: { verdict: 'pass', evidence: '候选完整且通过机械检查，指令可执行，无密钥风险', risks: '无' } })
  assert.equal(again.ok, false)
  assert.ok(again.issues.some((i) => i.includes('已晋升过')))
  rmSync(dir, { recursive: true, force: true })
})

test('A2: skill_reject 与 restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a2-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  writeFileSync(join(dir, 'retros', 'r-1.json'), JSON.stringify(RETRO_WITH_CANDIDATES))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  const reject = findTool(ctx, 'skill_reject')
  let r = await reject.execute({ name: 'dsh-plugin-zero-dep', reason: '重复' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'rejected')
  r = await reject.execute({ name: 'dsh-plugin-zero-dep', restore: true })
  assert.equal(r.status, 'pending')
  rmSync(dir, { recursive: true, force: true })
})

test('A2: retro_review 提交后自动收割新候选', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-a2-'))
  const ctx = makeFakeCtx()
  apply(ctx, { enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'), inbox: false })
  const retro = findTool(ctx, 'retro_review')
  await retro.execute({
    taskType: 'x', outcome: 'success',
    skillCandidates: [{ name: 'fresh-skill', trigger: 't', instructions: '做一件事的步骤说明，足够长以通过 lint' }],
  })
  const inbox = findTool(ctx, 'retro_inbox')
  const v = await inbox.execute({ status: 'pending' })
  assert.equal(v.count, 1)
  assert.equal(v.candidates[0].name, 'fresh-skill')
  rmSync(dir, { recursive: true, force: true })
})