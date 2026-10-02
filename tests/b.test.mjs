import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawn } from 'node:child_process'
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

function findTool(ctx, name) { return ctx.registered.find((t) => t.name === name) }

function bootWithCandidate({ requireJudge = true, autoRollback = true, judgeConsistency = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'retro-b-'))
  mkdirSync(join(dir, 'retros'), { recursive: true })
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  // 先落盘 retro：harvestOnStart 在 apply 时收割候选
  writeFileSync(join(dir, 'retros', 'r-b1.json'), JSON.stringify(CAND))
  const ctx = makeFakeCtx()
  apply(ctx, {
    enabled: true, storageDir: dir, skillsDir: join(dir, 'skills'),
    inbox: false, requireJudge, autoRollback, judgeConsistency,
  })
  return { dir, ctx }
}

const CAND = {
  kind: 'retro', version: 1, id: 'r-b1', sessionId: 's-1', createdAt: Date.now(),
  taskType: 'plugin-dev', outcome: 'success',
  skillCandidates: [{ name: 'b-test-skill', trigger: 'B 系列测试候选，触发场景描述足够长以通过 lint 描述长度检查', instructions: 'B 系列测试候选的指令内容，步骤清晰完整且不含密钥，长度足以通过 lint。', confidence: 0.8 }],
}
const GOOD_JUDGE = { verdict: 'pass', evidence: 'b-test-skill 指令完整可执行，无密钥，具备复用价值，批准晋升', risks: '无' }

test('B1: canary 冒烟通过 → 晋升成功且文件可读', async () => {
  const { dir, ctx } = bootWithCandidate()
  const promote = findTool(ctx, 'skill_promote')
  const r = await promote.execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  assert.equal(r.ok, true, JSON.stringify(r))
  const file = join(dir, 'skills', 'b-test-skill.md')
  assert.equal(existsSync(file), true)
  const content = readFileSync(file, 'utf8')
  assert.match(content, /^name: b-test-skill$/m)
  rmSync(dir, { recursive: true, force: true })
})

test('B0: promote 后 evolution.log 有记录', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const log = readFileSync(join(dir, 'evolution.log.jsonl'), 'utf8')
  assert.match(log, /"event":"promote"/)
  assert.match(log, /"name":"b-test-skill"/)
  rmSync(dir, { recursive: true, force: true })
})

test('B2: 模板化裁判（evidence 未引用候选名）被拒', async () => {
  const { dir, ctx } = bootWithCandidate()
  const r = await findTool(ctx, 'skill_promote').execute({
    name: 'b-test-skill',
    judge: { verdict: 'pass', evidence: '这个候选看起来整体不错，各方面都合格，批准通过，没有发现明显风险', risks: '无' },
  })
  assert.equal(r.ok, false)
  assert.ok(r.issues[0].includes('B2') || r.issues[0].includes('模板化'), JSON.stringify(r))
  rmSync(dir, { recursive: true, force: true })
})

test('B2: judgeConsistency=false 时模板化裁判放行（向后兼容）', async () => {
  const { dir, ctx } = bootWithCandidate({ judgeConsistency: false })
  const r = await findTool(ctx, 'skill_promote').execute({
    name: 'b-test-skill',
    judge: { verdict: 'pass', evidence: '这个候选看起来整体不错，各方面都合格，批准通过，没有发现明显风险', risks: '无' },
  })
  assert.equal(r.ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('B3: telemetry 恶化只建议回滚；默认预览、确认归档、预览恢复、确认恢复', async () => {
  const { dir, ctx } = bootWithCandidate()
  // 先晋升
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const skillsDir = join(dir, 'skills')
  // 造恶化数据：晋升后 3 个高失败率会话
  const T0 = Date.now()
  const retroSessions = ['s-a1', 's-a2', 's-a3']
  for (const sid of retroSessions) {
    writeFileSync(join(dir, 'retros', 'r-' + sid + '.json'), JSON.stringify({ kind: 'retro', id: 'r-' + sid, sessionId: sid, createdAt: T0, taskType: 'plugin-dev', outcome: 'success', skillCandidates: [] }))
    writeFileSync(join(dir, 'sessions', sid + '.json'), JSON.stringify({
      kind: 'session-summary', version: 1, sessionId: sid, createdAt: T0 + 1000, closedAt: T0 + 2000,
      turns: 1, steps: 10, toolCalls: { total: 10, ok: 4, failed: 6, byName: {} },
      userMessages: 3, assistantMessages: 1, corrections: 0, todoWrites: 0, worthRetro: true,
    }))
  }
  // 候选 decidedAt 必须早于 after 样本
  const dbPath = join(dir, 'candidates.json')
  const db = JSON.parse(readFileSync(dbPath, 'utf8'))
  db.candidates[0].decidedAt = T0 - 100000
  writeFileSync(dbPath, JSON.stringify(db))
  const active = join(skillsDir, 'b-test-skill.md')
  const archived = join(dir, 'skills-archive', 'b-test-skill.md')
  const ledgerBefore = readFileSync(dbPath)
  const skillBefore = readFileSync(active)
  const logBefore = readFileSync(join(dir, 'evolution.log.jsonl'))
  const telemetry = await findTool(ctx, 'retro_telemetry').execute({})
  assert.equal(telemetry.skills[0].verdict, 'deprecated')
  assert.equal(telemetry.skills[0].rollbackRecommended, true)
  assert.deepEqual(readFileSync(dbPath), ledgerBefore)
  assert.deepEqual(readFileSync(active), skillBefore)
  assert.deepEqual(readFileSync(join(dir, 'evolution.log.jsonl')), logBefore)
  assert.equal(existsSync(archived), false)

  const rollback = findTool(ctx, 'skill_rollback')
  const preview = await rollback.execute({ name: 'b-test-skill' })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.destination, archived)
  assert.equal(existsSync(active), true)
  assert.deepEqual(readFileSync(dbPath), ledgerBefore)

  const moved = await rollback.execute({ name: 'b-test-skill', confirm: true })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  assert.equal(existsSync(active), false)
  assert.deepEqual(readFileSync(archived), skillBefore)
  assert.equal(JSON.parse(readFileSync(dbPath, 'utf8')).candidates[0].status, 'deprecated')
  assert.match(readFileSync(join(dir, 'evolution.log.jsonl'), 'utf8'), /"event":"rollback"/)
  assert.equal((await findTool(ctx, 'retro_telemetry').execute({})).skills[0].verdict, 'deprecated')

  const restore = findTool(ctx, 'skill_restore')
  const restorePreview = await restore.execute({ name: 'b-test-skill' })
  assert.equal(restorePreview.dryRun, true)
  assert.equal(existsSync(active), false)
  const restored = await restore.execute({ name: 'b-test-skill', confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.deepEqual(readFileSync(active), skillBefore)
  assert.equal(existsSync(archived), false)
  assert.equal(JSON.parse(readFileSync(dbPath, 'utf8')).candidates[0].status, 'promoted')
  assert.match(readFileSync(join(dir, 'evolution.log.jsonl'), 'utf8'), /"event":"restore"/)
  rmSync(dir, { recursive: true, force: true })
})

test('B3: 目标归档文件已存在时拒绝覆盖', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const archiveDir = join(dir, 'skills-archive')
  mkdirSync(archiveDir)
  const archived = join(archiveDir, 'b-test-skill.md')
  writeFileSync(archived, 'existing archive')
  const r = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /拒绝覆盖/)
  assert.equal(readFileSync(archived, 'utf8'), 'existing archive')
  assert.equal(existsSync(join(dir, 'skills', 'b-test-skill.md')), true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8')).candidates[0].status, 'promoted')
  rmSync(dir, { recursive: true, force: true })
})

test('B3: 目标是悬空符号链接时也拒绝覆盖', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const archiveDir = join(dir, 'skills-archive')
  mkdirSync(archiveDir)
  const archived = join(archiveDir, 'b-test-skill.md')
  symlinkSync(join(archiveDir, 'missing-target.md'), archived)
  assert.equal(existsSync(archived), false)
  const before = readFileSync(join(dir, 'candidates.json'))
  const r = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /拒绝覆盖/)
  assert.equal(lstatSync(archived).isSymbolicLink(), true)
  assert.equal(existsSync(join(dir, 'skills', 'b-test-skill.md')), true)
  assert.deepEqual(readFileSync(join(dir, 'candidates.json')), before)
  rmSync(dir, { recursive: true, force: true })
})

test('B3: 检查目标后竞争进程创建文件，归档和恢复都不覆盖', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const active = join(dir, 'skills', 'b-test-skill.md')
  const archived = join(dir, 'skills-archive', 'b-test-skill.md')
  mkdirSync(join(dir, 'skills-archive'))
  const skillBefore = readFileSync(active)
  const ledgerBefore = readFileSync(join(dir, 'candidates.json'))

  async function race(destination, tool) {
    const original = fs.lstatSync
    let injected = false
    fs.lstatSync = function (file, ...rest) {
      if (file === destination && !injected) {
        injected = true
        writeFileSync(destination, 'competing writer')
        const err = new Error('destination was absent at check time')
        err.code = 'ENOENT'
        throw err
      }
      return original.call(this, file, ...rest)
    }
    syncBuiltinESMExports()
    try {
      const result = await tool.execute({ name: 'b-test-skill', confirm: true })
      assert.equal(injected, true)
      assert.equal(result.ok, false)
      assert.match(result.error, /拒绝覆盖/)
      assert.equal(readFileSync(destination, 'utf8'), 'competing writer')
    } finally {
      fs.lstatSync = original
      syncBuiltinESMExports()
    }
  }

  await race(archived, findTool(ctx, 'skill_rollback'))
  assert.deepEqual(readFileSync(active), skillBefore)
  assert.deepEqual(readFileSync(join(dir, 'candidates.json')), ledgerBefore)
  rmSync(archived)
  assert.equal((await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })).ok, true)
  await race(active, findTool(ctx, 'skill_restore'))
  assert.deepEqual(readFileSync(archived), skillBefore)
  assert.equal(JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8')).candidates[0].status, 'deprecated')
  rmSync(dir, { recursive: true, force: true })
})

test('B3: 另一进程持有账本锁时拒绝写入，解锁后读取其更新', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const active = join(dir, 'skills', 'b-test-skill.md')
  const archived = join(dir, 'skills-archive', 'b-test-skill.md')
  const worker = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); const path = require('node:path');
    const root = process.argv[1]; const lock = path.join(root, '.candidates.lock');
    const fd = fs.openSync(lock, 'wx');
    const ledger = path.join(root, 'candidates.json');
    const db = JSON.parse(fs.readFileSync(ledger));
    db.candidates[0].probe = { status: 'passed', task: 'other process' };
    const temp = path.join(root, '.other-writer.json');
    fs.writeFileSync(temp, JSON.stringify(db)); fs.renameSync(temp, ledger);
    process.stdout.write('locked\\n');
    process.stdin.resume(); process.stdin.on('end', () => {
      fs.closeSync(fd); fs.unlinkSync(lock);
    });
  `, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', (chunk) => chunk.toString().includes('locked') ? resolve() : reject(new Error('worker did not lock')))
      worker.once('error', reject)
      worker.once('exit', (code) => reject(new Error('worker exited before lock: ' + code)))
    })
    const blocked = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /账本锁/)
    assert.equal(existsSync(active), true)
    assert.equal(existsSync(archived), false)
    worker.stdin.end()
    await new Promise((resolve, reject) => worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('worker exit ' + code))))
    const moved = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    const db = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))
    assert.equal(db.candidates[0].probe.task, 'other process')
    assert.equal(db.candidates[0].status, 'deprecated')
  } finally {
    if (worker.exitCode === null) worker.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B3: 遗留锁保留并报告持锁记录，人工核查后可重试', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const lock = join(dir, '.candidates.lock')
  const active = join(dir, 'skills', 'b-test-skill.md')
  const ledgerBefore = readFileSync(join(dir, 'candidates.json'))
  writeFileSync(lock, JSON.stringify({ pid: 12345, at: 'test-stale' }))
  try {
    const result = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
    assert.equal(result.ok, false)
    assert.match(result.error, /12345/)
    assert.equal(existsSync(lock), true)
    assert.equal(existsSync(active), true)
    assert.deepEqual(readFileSync(join(dir, 'candidates.json')), ledgerBefore)
  } finally {
    rmSync(lock)
  }
  assert.equal((await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })).ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('B3: 损坏的候选账本保持原样，拒绝归档', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const ledger = join(dir, 'candidates.json')
  const active = join(dir, 'skills', 'b-test-skill.md')
  const archived = join(dir, 'skills-archive', 'b-test-skill.md')
  writeFileSync(ledger, '{broken')
  const result = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
  assert.equal(result.ok, false)
  assert.equal(readFileSync(ledger, 'utf8'), '{broken')
  assert.equal(existsSync(active), true)
  assert.equal(existsSync(archived), false)
  assert.equal(existsSync(join(dir, '.candidates.lock')), false)
  rmSync(dir, { recursive: true, force: true })
})

test('B3: 归档和恢复拒绝目录及符号链接源', async () => {
  for (const restore of [false, true]) {
    for (const kind of ['directory', 'symlink']) {
      const { dir, ctx } = bootWithCandidate()
      await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
      if (restore) assert.equal((await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })).ok, true)
      const source = join(dir, restore ? 'skills-archive' : 'skills', 'b-test-skill.md')
      const destination = join(dir, restore ? 'skills' : 'skills-archive', 'b-test-skill.md')
      rmSync(source)
      const victim = join(dir, 'victim.md')
      writeFileSync(victim, 'victim')
      if (kind === 'directory') mkdirSync(source)
      else symlinkSync(victim, source)
      const ledgerBefore = readFileSync(join(dir, 'candidates.json'))
      const result = await findTool(ctx, restore ? 'skill_restore' : 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
      assert.equal(result.ok, false)
      assert.match(result.error, /源路径不是普通文件/)
      assert.equal(existsSync(destination), false)
      assert.deepEqual(readFileSync(join(dir, 'candidates.json')), ledgerBefore)
      assert.equal(readFileSync(victim, 'utf8'), 'victim')
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('B3: 跨卷回退经目标目录临时文件完成，竞争目标仍不覆盖', async () => {
  for (const competing of [false, true]) {
    const { dir, ctx } = bootWithCandidate()
    await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
    const source = join(dir, 'skills', 'b-test-skill.md')
    const destination = join(dir, 'skills-archive', 'b-test-skill.md')
    const skillBefore = readFileSync(source)
    mkdirSync(join(dir, 'skills-archive'))
    const original = fs.linkSync
    let first = true
    fs.linkSync = function (from, to, ...rest) {
      if (to === destination && first) {
        first = false
        const err = new Error('simulated cross-device link')
        err.code = 'EXDEV'
        throw err
      }
      if (to === destination && competing) writeFileSync(destination, 'competing writer')
      return original.call(this, from, to, ...rest)
    }
    syncBuiltinESMExports()
    try {
      const result = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
      assert.equal(first, false)
      assert.equal(result.ok, !competing, JSON.stringify(result))
      assert.equal(readdirSync(join(dir, 'skills-archive')).some((name) => name.startsWith('.skill-move-')), false)
      if (competing) {
        assert.equal(readFileSync(destination, 'utf8'), 'competing writer')
        assert.deepEqual(readFileSync(source), skillBefore)
        assert.equal(JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8')).candidates[0].status, 'promoted')
      } else {
        assert.deepEqual(readFileSync(destination), skillBefore)
        assert.equal(existsSync(source), false)
      }
    } finally {
      fs.linkSync = original
      syncBuiltinESMExports()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('B3: 账本写入失败时旧 JSON 完整且技能文件复位', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const active = join(dir, 'skills', 'b-test-skill.md')
  const archived = join(dir, 'skills-archive', 'b-test-skill.md')
  mkdirSync(join(dir, 'skills-archive'))
  const ledgerBefore = readFileSync(join(dir, 'candidates.json'))
  const skillBefore = readFileSync(active)
  const original = fs.renameSync
  fs.renameSync = function (from, to, ...rest) {
    if (to === join(dir, 'candidates.json') && String(from).includes('.candidates-')) {
      const err = new Error('injected ledger replacement failure')
      err.code = 'EACCES'
      throw err
    }
    return original.call(this, from, to, ...rest)
  }
  syncBuiltinESMExports()
  try {
    const result = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
    assert.equal(result.ok, false)
    assert.equal(result.restored, true, JSON.stringify(result))
    assert.match(result.error, /账本写入失败/)
    assert.deepEqual(readFileSync(join(dir, 'candidates.json')), ledgerBefore)
    assert.deepEqual(readFileSync(active), skillBefore)
    assert.equal(existsSync(archived), false)
    assert.equal(readdirSync(dir).some((name) => name.startsWith('.candidates-')), false)
  } finally {
    fs.renameSync = original
    syncBuiltinESMExports()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B3: 账本失败且源路径被竞争进程占用时，复位不覆盖任何一侧', async () => {
  const { dir, ctx } = bootWithCandidate()
  await findTool(ctx, 'skill_promote').execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  const active = join(dir, 'skills', 'b-test-skill.md')
  const archived = join(dir, 'skills-archive', 'b-test-skill.md')
  const ledger = join(dir, 'candidates.json')
  const ledgerBefore = readFileSync(ledger)
  const skillBefore = readFileSync(active)
  const original = fs.renameSync
  fs.renameSync = function (from, to, ...rest) {
    if (to === ledger && String(from).includes('.candidates-')) {
      writeFileSync(active, 'competing writer')
      const err = new Error('injected ledger replacement failure')
      err.code = 'EACCES'
      throw err
    }
    return original.call(this, from, to, ...rest)
  }
  syncBuiltinESMExports()
  try {
    const result = await findTool(ctx, 'skill_rollback').execute({ name: 'b-test-skill', confirm: true })
    assert.equal(result.ok, false)
    assert.equal(result.restored, false)
    assert.match(result.error, /账本写入失败/)
    assert.equal(readFileSync(active, 'utf8'), 'competing writer')
    assert.deepEqual(readFileSync(archived), skillBefore)
    assert.deepEqual(readFileSync(ledger), ledgerBefore)
  } finally {
    fs.renameSync = original
    syncBuiltinESMExports()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B0: 日志写入失败在工具结果和渲染文本中可见', async () => {
  const { dir, ctx } = bootWithCandidate()
  mkdirSync(join(dir, 'evolution.log.jsonl')) // appendFileSync 遇目录会失败
  const promote = findTool(ctx, 'skill_promote')
  const originalError = console.error
  const errors = []
  console.error = (...parts) => errors.push(parts.join(' '))
  let result
  try {
    result = await promote.execute({ name: 'b-test-skill', judge: GOOD_JUDGE })
  } finally {
    console.error = originalError
  }
  assert.equal(result.ok, true)
  assert.match(result.logError, /evolution log write failed/)
  assert.match(promote.output.render({}, result)[0].text, /evolution log write failed/)
  assert.match(errors.join('\n'), /evolution log write failed/)
  rmSync(dir, { recursive: true, force: true })
})
