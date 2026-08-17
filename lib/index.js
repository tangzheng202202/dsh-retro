/* dsh-retro — DeepSeek Harness 复盘插件（方向 A1 原型）。零 npm 依赖。
 * 心智模型：session 事件流 → 每回合轨迹（turns/*.jsonl）+ 会话摘要（sessions/*.json）
 * → 模型在任务收尾时调用 retro_review 提交结构化复盘（retros/*.json）
 * → memoryFacts 尽力推给 OpenViking（若其服务可见）；本地文件始终是权威存储。
 * 安全默认：enabled:false 装上不动作。不记录工具参数、不记录对话正文，只记统计与错误码。 */

import { mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-retro'
export const inject = ['tools']

export const RETRO_SCHEMA_VERSION = 1

// —— 用户纠正启发式：短的人类消息里出现纠错信号词 ——
const CORRECTION_PATTERNS = [
  /(不对|错了|不是|不要|别|停|算了|重新|再来|改成|换一种|有问题|失败|不行|撤销|回滚|恢复|重做)/,
  /\b(no|stop|cancel|wrong|redo|revert|rollback|not that|that's not)\b/i,
]

export function looksLikeCorrection(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 400) return false
  return CORRECTION_PATTERNS.some((re) => re.test(text))
}

// —— 消息文本提取（只取 text 块；工具结果里的文本也归并） ——
export function textOfMessage(message) {
  if (!message || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-result') {
      const inner = Array.isArray(block.content) ? block.content : []
      for (const b of inner) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

// 直接人类输入：source.kind === 'user'。插件注入（agent.inject、记忆召回、心跳）是 'plugin'，不算。
export function isHumanMessage(message) {
  return !!message && message.role === 'user' && message.source && message.source.kind === 'user'
}

// —— 输入消毒（长度上限 + 结构白名单，防脏数据写盘） ——
export function sanitizeStrings(arr, maxLen = 2000) {
  if (!Array.isArray(arr)) return []
  const out = []
  for (const item of arr) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim().slice(0, maxLen))
  }
  return out
}

export function sanitizePitfalls(arr) {
  if (!Array.isArray(arr)) return []
  const out = []
  for (const p of arr) {
    if (p && typeof p === 'object') {
      out.push({
        symptom: String(p.symptom ?? '').slice(0, 1000),
        cause: String(p.cause ?? '').slice(0, 1000),
        fix: String(p.fix ?? '').slice(0, 1000),
      })
    }
  }
  return out.filter((p) => p.symptom || p.cause || p.fix)
}

export function sanitizeSkillCandidates(arr) {
  if (!Array.isArray(arr)) return []
  const out = []
  for (const s of arr) {
    if (s && typeof s === 'object') {
      out.push({
        name: String(s.name ?? '').slice(0, 200),
        trigger: String(s.trigger ?? '').slice(0, 500),
        instructions: String(s.instructions ?? '').slice(0, 4000),
        confidence: typeof s.confidence === 'number' ? Math.min(1, Math.max(0, s.confidence)) : null,
      })
    }
  }
  return out.filter((s) => s.name || s.instructions)
}

const OUTCOMES = new Set(['success', 'partial', 'failed', 'abandoned'])

export function normalizeRetroInput(args) {
  args = args && typeof args === 'object' ? args : {}
  const taskType = typeof args.taskType === 'string' && args.taskType.trim() ? args.taskType.trim().slice(0, 200) : 'unknown'
  const outcome = OUTCOMES.has(args.outcome) ? args.outcome : 'partial'
  return {
    taskType,
    outcome,
    summary: typeof args.summary === 'string' ? args.summary.trim().slice(0, 4000) : '',
    patterns: sanitizeStrings(args.patterns),
    pitfalls: sanitizePitfalls(args.pitfalls),
    skillCandidates: sanitizeSkillCandidates(args.skillCandidates),
    memoryFacts: sanitizeStrings(args.memoryFacts),
  }
}

// —— 会话轨迹跟踪器：把 session 事件流折叠成结构化统计 ——
export class SessionTracker {
  constructor(sessionId, startedAt = Date.now()) {
    this.sessionId = String(sessionId)
    this.startedAt = startedAt
    this.turns = new Map()
    this.turnOrder = []
    this.currentTurn = null
    this.toolTotals = { total: 0, ok: 0, failed: 0, byName: {} }
    this.userMessages = 0
    this.assistantMessages = 0
    this.assistantTokens = 0
    this.corrections = 0
    this.todoWrites = 0
    this.todoLast = null
    this.steps = 0
    this.closedAt = null
  }

  openTurn(turn) {
    if (this.turns.has(turn)) { this.currentTurn = this.turns.get(turn); return this.currentTurn }
    const state = {
      turn,
      startedAt: Date.now(),
      endedAt: null,
      endedBy: null,
      steps: 0,
      pendingTools: new Map(),
      toolCalls: [],
      userMessages: 0,
      corrections: 0,
      assistantTokens: 0,
    }
    this.turns.set(turn, state)
    this.turnOrder.push(turn)
    this.currentTurn = state
    return state
  }

  onStepStart() {
    this.steps += 1
    if (this.currentTurn) this.currentTurn.steps += 1
  }

  onToolCall(name, callId) {
    if (!this.currentTurn) this.openTurn(this.turnOrder.length ? this.turnOrder[this.turnOrder.length - 1] : 1)
    this.currentTurn.pendingTools.set(String(callId), { name: String(name ?? 'unknown'), startedAt: Date.now() })
  }

  onToolResult(callId, { isError = false, errorCode = null } = {}) {
    if (!this.currentTurn) return
    const pending = this.currentTurn.pendingTools.get(String(callId))
    const name = pending ? pending.name : 'unknown'
    const durationMs = pending ? Date.now() - pending.startedAt : null
    this.currentTurn.pendingTools.delete(String(callId))
    this.currentTurn.toolCalls.push({ name, ok: !isError, errorCode: isError ? (errorCode ?? 'UNKNOWN') : null, durationMs })
    this.toolTotals.total += 1
    if (isError) this.toolTotals.failed += 1; else this.toolTotals.ok += 1
    const byName = (this.toolTotals.byName[name] ??= { calls: 0, failed: 0 })
    byName.calls += 1
    if (isError) byName.failed += 1
  }

  onUserMessage(text, isHuman = true) {
    if (!isHuman) return
    this.userMessages += 1
    if (this.currentTurn) this.currentTurn.userMessages += 1
    if (looksLikeCorrection(text)) {
      this.corrections += 1
      if (this.currentTurn) this.currentTurn.corrections += 1
    }
  }

  onAssistantMessage(tokens) {
    this.assistantMessages += 1
    if (typeof tokens === 'number' && Number.isFinite(tokens)) {
      this.assistantTokens += tokens
      if (this.currentTurn) this.currentTurn.assistantTokens += tokens
    }
  }

  onTodoWrite(todos) {
    this.todoWrites += 1
    this.todoLast = Array.isArray(todos) ? todos.map((t) => ({ content: t && t.content, status: t && t.status })) : null
  }

  closeTurn(turn, reasonKind = 'completed') {
    const state = this.turns.get(turn)
    if (!state) return null
    state.endedAt = Date.now()
    state.endedBy = String(reasonKind)
    this.currentTurn = null
    return state
  }

  close() {
    this.closedAt = Date.now()
    return this.closedAt
  }
}

// —— 记录构造器 ——
export function buildTurnTrace(sessionId, tracker, turnState) {
  return {
    kind: 'turn-trace',
    version: RETRO_SCHEMA_VERSION,
    sessionId: String(sessionId),
    turn: turnState.turn,
    startedAt: turnState.startedAt,
    endedAt: turnState.endedAt,
    durationMs: turnState.endedAt ? turnState.endedAt - turnState.startedAt : null,
    endedBy: turnState.endedBy,
    steps: turnState.steps,
    toolCalls: turnState.toolCalls,
    userMessages: turnState.userMessages,
    corrections: turnState.corrections,
    assistantTokens: turnState.assistantTokens,
  }
}

export function buildSessionSummary(sessionId, tracker, config = {}) {
  const turns = tracker.turnOrder.length
  const worthRetro =
    tracker.toolTotals.total >= (config.minToolsForRetro ?? 2) ||
    turns >= (config.minTurnsForRetro ?? 3) ||
    tracker.toolTotals.failed > 0 ||
    tracker.corrections > 0
  return {
    kind: 'session-summary',
    version: RETRO_SCHEMA_VERSION,
    sessionId: String(sessionId),
    createdAt: tracker.startedAt,
    closedAt: tracker.closedAt,
    turns,
    steps: tracker.steps,
    durationMs: tracker.closedAt ? tracker.closedAt - tracker.startedAt : null,
    toolCalls: {
      total: tracker.toolTotals.total,
      ok: tracker.toolTotals.ok,
      failed: tracker.toolTotals.failed,
      byName: tracker.toolTotals.byName,
    },
    userMessages: tracker.userMessages,
    assistantMessages: tracker.assistantMessages,
    corrections: tracker.corrections,
    todoWrites: tracker.todoWrites,
    worthRetro,
  }
}

export function buildRetroRecord({ sessionId, taskType, outcome, summary = '', patterns = [], pitfalls = [], skillCandidates = [], memoryFacts = [] }) {
  const id = String(sessionId) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  return {
    kind: 'retro',
    version: RETRO_SCHEMA_VERSION,
    id,
    sessionId: String(sessionId),
    createdAt: Date.now(),
    taskType,
    outcome,
    summary,
    patterns,
    pitfalls,
    skillCandidates,
    memoryFacts,
  }
}

// —— 本地存储：turns/*.jsonl（追加）、sessions/*.json（覆盖）、retros/*.json、inbox/ + processed/ ——
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160)
}

function monthFile() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '.jsonl'
}

export class RetroStore {
  constructor(root) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  _dir(sub) {
    const d = join(this.root, sub)
    mkdirSync(d, { recursive: true })
    return d
  }

  appendTurnTrace(record) {
    appendFileSync(join(this._dir('turns'), monthFile()), JSON.stringify(record) + '\n')
  }

  writeSessionSummary(record) {
    writeFileSync(join(this._dir('sessions'), safeName(record.sessionId) + '.json'), JSON.stringify(record, null, 2))
  }

  writeRetro(record) {
    writeFileSync(join(this._dir('retros'), safeName(record.id) + '.json'), JSON.stringify(record, null, 2))
  }

  listTurns() {
    try { return readdirSync(this._dir('turns')).filter((f) => f.endsWith('.jsonl')).sort() } catch { return [] }
  }
}

// —— inbox 导入：任何外部上下文（其他 agent、脚本、手动）都可投递复盘 JSON ——
function ingestInbox(store) {
  const inboxDir = store._dir('inbox')
  const doneDir = store._dir('processed')
  let files = []
  try { files = readdirSync(inboxDir).filter((f) => f.endsWith('.json')) } catch { return 0 }
  let n = 0
  for (const f of files) {
    const src = join(inboxDir, f)
    try {
      const raw = JSON.parse(readFileSync(src, 'utf8'))
      const norm = normalizeRetroInput(raw)
      const record = buildRetroRecord({ sessionId: String(raw.sessionId ?? 'inbox'), ...norm })
      store.writeRetro(record)
      renameSync(src, join(doneDir, f))
      n += 1
    } catch { /* 损坏的投递留在 inbox，下次重试或人工处理 */ }
  }
  return n
}

// —— 配置 ——
// ============ A2：skill 候选 inbox + 晋升门 ============
function candidatesFile(root) { return join(root, 'candidates.json') }

function loadCandidates(root) {
  try { return JSON.parse(readFileSync(candidatesFile(root), 'utf8')) } catch { return { candidates: [] } }
}

function saveCandidates(root, db) {
  writeFileSync(candidatesFile(root), JSON.stringify(db, null, 2))
}

// 从 retros/*.json 收割 skillCandidates → 按 name 去重入账（pending）
function harvestCandidates(store) {
  const db = loadCandidates(store.root)
  let added = 0
  const retroDir = store._dir('retros')
  let files = []
  try { files = readdirSync(retroDir).filter((f) => f.endsWith('.json')) } catch { return 0 }
  for (const f of files) {
    let retro
    try { retro = JSON.parse(readFileSync(join(retroDir, f), 'utf8')) } catch { continue }
    const cands = Array.isArray(retro.skillCandidates) ? retro.skillCandidates : []
    for (const c of cands) {
      if (!c || typeof c !== 'object' || !c.name) continue
      const name = String(c.name).trim()
      if (db.candidates.some((x) => x.name === name)) continue
      db.candidates.push({
        name,
        description: String(c.trigger || c.name || '').slice(0, 300),
        whenToUse: String(c.trigger || '').slice(0, 500),
        instructions: String(c.instructions || '').slice(0, 8000),
        confidence: typeof c.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : null,
        sourceRetroId: retro.id || '',
        sourceSessionId: retro.sessionId || '',
        sourceTaskType: retro.taskType || '',
        status: 'pending',
        createdAt: Date.now(),
        decidedAt: null,
        note: '',
        promotedPath: null,
        judge: null,
        probe: null,
      })
      added += 1
    }
  }
  if (added > 0) saveCandidates(store.root, db)
  return added
}

// ============ A4：skill 遥测闭环（代理指标）+ 自动降级 ============
// 说明：DSH 暂无"skill 被模型加载"事件，A4 用代理指标——skill 覆盖的 taskType
// 在晋升前后的会话质量对比（工具失败率 / 用户纠错率）。verdict 三态：
//   healthy（有足够后置样本且未恶化）/ deprecated（恶化超阈值）/ insufficient（样本不足）
function telemetryForSkill(store, cand) {
  const taskTypeBySession = new Map()
  try {
    for (const rf of readdirSync(store._dir('retros')).filter((x) => x.endsWith('.json'))) {
      try {
        const retro = JSON.parse(readFileSync(join(store.root, 'retros', rf), 'utf8'))
        if (retro && retro.sessionId && retro.taskType) taskTypeBySession.set(retro.sessionId, retro.taskType)
      } catch {}
    }
  } catch {}
  const t = cand.sourceTaskType || ''
  const samples = { before: [], after: [] }
  try {
    for (const sf of readdirSync(store._dir('sessions')).filter((x) => x.endsWith('.json'))) {
      const sessionId = sf.slice(0, -'.json'.length)
      if (!t || taskTypeBySession.get(sessionId) !== t) continue
      try {
        const s = JSON.parse(readFileSync(join(store.root, 'sessions', sf), 'utf8'))
        if (!s || s.kind !== 'session-summary') continue
        const closedAt = s.closedAt || 0
        const promotedAt = (cand.decidedAt || cand.createdAt || 0)
        ;(closedAt < promotedAt ? samples.before : samples.after).push(s)
      } catch {}
    }
  } catch {}
  const failStats = (arr) => {
    const valid = arr.filter((s) => s.toolCalls && s.toolCalls.total > 0)
    if (valid.length === 0) return null
    const failed = valid.reduce((acc, s) => acc + (s.toolCalls.failed || 0), 0)
    const total = valid.reduce((acc, s) => acc + (s.toolCalls.total || 0), 0)
    return { rate: total > 0 ? failed / total : null, n: valid.length }
  }
  const corrStats = (arr) => {
    const valid = arr.filter((s) => s.userMessages > 0)
    if (valid.length === 0) return null
    const c = valid.reduce((acc, s) => acc + (s.corrections || 0), 0)
    const u = valid.reduce((acc, s) => acc + (s.userMessages || 0), 0)
    return { rate: u > 0 ? c / u : null, n: valid.length }
  }
  const fb = failStats(samples.before)
  const fa = failStats(samples.after)
  const cb = corrStats(samples.before)
  const ca = corrStats(samples.after)
  let verdict = 'insufficient'
  if (samples.after.length >= 3) {
    const worseFail = fa && fa.rate !== null && fb && fb.rate !== null && fa.rate > fb.rate * 1.2
    const worseCorr = ca && ca.rate !== null && cb && cb.rate !== null && ca.rate > cb.rate * 1.2
    verdict = (worseFail || worseCorr) ? 'deprecated' : 'healthy'
  }
  return {
    coveredTaskType: t,
    samplesBefore: samples.before.length,
    samplesAfter: samples.after.length,
    failRateBefore: fb && fb.rate !== null ? fb.rate : null,
    failRateAfter: fa && fa.rate !== null ? fa.rate : null,
    correctionRateBefore: cb && cb.rate !== null ? cb.rate : null,
    correctionRateAfter: ca && ca.rate !== null ? ca.rate : null,
    verdict,
    checkedAt: Date.now(),
  }
}

// 刷新全部 promoted 候选的遥测；verdict=deprecated → 自动降级（status=deprecated）
function refreshTelemetry(store) {
  const db = loadCandidates(store.root)
  for (const cand of db.candidates) {
    if (cand.status !== 'promoted') continue
    cand.telemetry = telemetryForSkill(store, cand)
    if (cand.telemetry.verdict === 'deprecated' && cand.status === 'promoted') {
      cand.status = 'deprecated'
      cand.decidedAt = Date.now()
      if (!String(cand.note || '').includes('telemetry 自动降级')) {
        cand.note = (cand.note ? cand.note + '; ' : '') + 'telemetry 自动降级: failRate ' + fmtRate(cand.telemetry.failRateBefore) + '→' + fmtRate(cand.telemetry.failRateAfter)
      }
    }
  }
  saveCandidates(store.root, db) // 总是落盘：telemetry 字段也要持久化
  return db
}
function fmtRate(v) {
  return v === null || v === undefined ? '-' : (v * 100).toFixed(0) + '%'
}

// lint 门：机械检查，拦截明显不合格候选
function lintCandidate(c) {
  const issues = []
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.name)) issues.push('name 必须 kebab-case（小写字母数字+连字符）')
  if (!c.description || c.description.length < 10) issues.push('description 缺失或过短（需 ≥10 字符）')
  if (!c.instructions || c.instructions.length < 20) issues.push('instructions 缺失或过短（需 ≥20 字符）')
  if (c.instructions && c.instructions.length > 8000) issues.push('instructions 超长（>8000 字符）')
  const secret = /(sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*\S|password\s*[:=]\s*\S|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)/i
  const hay = (c.description + '\n' + (c.whenToUse || '') + '\n' + c.instructions).slice(0, 12000)
  if (secret.test(hay)) issues.push('疑似包含密钥/口令（拒绝写入）')
  return issues
}

function skillFileFor(skillsDir, name) { return join(skillsDir, name + '.md') }

// JSON.stringify 的转义与 YAML 双引号标量兼容
function yamlStr(s) { return JSON.stringify(String(s)) }

function writeSkill(skillsDir, c) {
  const front = [
    '---',
    'name: ' + c.name,
    'description: ' + yamlStr(c.description || c.whenToUse || c.name),
    ...(c.whenToUse ? ['whenToUse: ' + yamlStr(c.whenToUse)] : []),
    'version: 0.1.0',
    '---',
    '',
    '# ' + c.name,
    '',
    c.instructions || '',
    '',
  ].join('\n')
  const file = skillFileFor(skillsDir, c.name)
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(file, front)
  return file
}

function formatInbox(v) {
  const list = Array.isArray(v.candidates) ? v.candidates : []
  if (list.length === 0) return '（无候选）'
  return list.map((c) => [
    '[' + c.status + '] ' + c.name + (typeof c.confidence === 'number' ? ' (conf=' + c.confidence + ')' : ''),
    '  触发: ' + (c.whenToUse || '-'),
    '  来源: ' + (c.sourceRetroId || '-') + (c.note ? ' 备注: ' + c.note : ''),
  ].join('\n')).join('\n\n')
}

function formatTelemetry(v) {
  const lines = ['retro_telemetry: ' + (v.summary ? JSON.stringify(v.summary) : '{}')]
  for (const s of (v.skills || [])) {
    lines.push('  [' + s.verdict + '] ' + s.name + ' (' + s.status + ') taskType=' + (s.coveredTaskType || '-') + ' after=' + s.samplesAfter)
    if (s.failRateBefore !== null && s.failRateBefore !== undefined) {
      lines.push('    failRate: ' + fmtRate(s.failRateBefore) + ' → ' + fmtRate(s.failRateAfter))
    }
  }
  return lines.join('\n')
}
function formatPromote(v) {
  if (v.ok) return 'skill_promote: ' + v.skillName + ' → ' + v.path
  return 'skill_promote 拒绝: ' + v.skillName + '\n' + (Array.isArray(v.issues) ? v.issues.join('\n') : String(v.issues || ''))
}

// —— 配置 ——
const DEFAULTS = {
  enabled: false,
  storageDir: '',
  minToolsForTurnTrace: 1,
  minToolsForRetro: 2,
  minTurnsForRetro: 3,
  remind: false,
  pushToViking: true,
  inbox: true,
  inboxIntervalMs: 60000,
  skillsDir: '',
  harvestOnStart: true,
  skillGate: true,
  requireJudge: true,
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const RETRO_REMINDER_TEXT = [
  '[dsh-retro] 长任务收尾约定：当一次多步骤任务（调用过多个工具，或已 完成/失败/放弃）结束时，',
  '调用 retro_review 提交结构化复盘：taskType（任务类型）、outcome（结果）、patterns（可复用做法，每条一句话）、pitfalls（踩坑：现象/根因/修复）、skillCandidates（值得沉淀为 skill 的做法）、memoryFacts（应进入长期记忆的事实）。这是系统自进化（L3 复盘层）的素材，请认真填写，不要编造；不确定的字段留空即可。',
].join('\n')

function formatRetroResult(value) {
  const v = value || {}
  const lines = [
    'retro_review 已提交：' + (v.retroId || '?'),
    '存储位置：' + (v.storedAt || '?'),
    'OpenViking 推送：' + (v.pushedToViking || 0) + ' 条' + (v.vikingNote ? '（' + v.vikingNote + '）' : ''),
  ]
  return lines.join('\n')
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = (...args) => console.log('[dsh-retro]', ...args)

  if (!config.enabled) {
    log('installed but disabled (enabled:false) — set enabled:true to start capture')
    return
  }

  const root = config.storageDir || join(dshHome(), 'storages', 'dsh-retro')
  const store = new RetroStore(root)
  if (config.harvestOnStart) { try { harvestCandidates(store) } catch (err) { log('harvest failed:', err && err.message) } }
  const trackers = new Map()

  function trackerFor(session) {
    const id = String((session && session.id) || 'unknown')
    let t = trackers.get(id)
    if (!t) {
      t = new SessionTracker(id, (session && session.header && session.header.createdAt) || Date.now())
      trackers.set(id, t)
    }
    return t
  }

  // —— 事件捕获：把 session 事件流折叠进 tracker ——
  ctx.on('session/event', (session, event) => {
    const tracker = trackerFor(session)
    const data = (event && event.data) || {}
    switch (event && event.type) {
      case 'turn/start':
        tracker.openTurn(Number(data.turn));
        break
      case 'step/start':
        tracker.onStepStart();
        break
      case 'tool/call':
        tracker.onToolCall(data.name, data.callId);
        break
      case 'tool/result': {
        const block = (data.message && data.message.content && data.message.content[0]) || {}
        const callId = (data.message && data.message.source && data.message.source.callId) || block.toolCallId || ''
        const isError = block.isError === true || !!data.error
        tracker.onToolResult(callId, { isError, errorCode: data.error && data.error.code });
        break
      }
      case 'user/message': {
        const message = data.message;
        if (isHumanMessage(message)) tracker.onUserMessage(textOfMessage(message), true);
        break
      }
      case 'assistant/message':
        tracker.onAssistantMessage((data.usage && (data.usage.total_tokens ?? data.usage.totalTokens)) || 0);
        break
      case 'todo/write':
        tracker.onTodoWrite(data.todos);
        break
      case 'turn/end': {
        const turn = Number(data.turn);
        const reasonKind = (data.reason && data.reason.kind) || 'completed';
        const state = tracker.closeTurn(turn, reasonKind);
        if (state && state.toolCalls.length >= config.minToolsForTurnTrace) {
          store.appendTurnTrace(buildTurnTrace(tracker.sessionId, tracker, state));
        }
        break
      }
    }
  });

  function finalize(session) {
    const tracker = trackers.get(String((session && session.id) || 'unknown'));
    if (!tracker) return;
    tracker.close();
    store.writeSessionSummary(buildSessionSummary(tracker.sessionId, tracker, config));
  }

  ctx.on('session/flush', (session) => { finalize(session) });
  ctx.on('session/disposed', (session) => {
    finalize(session);
    trackers.delete(String((session && session.id) || 'unknown'));
  });

  // —— retro_review 工具：模型在任务收尾时提交结构化复盘 ——
  ctx.tools.register({
    name: 'retro_review',
    description:
      '提交结构化任务复盘（长任务收尾时调用）。记录 patterns（可复用做法）、pitfalls（踩坑：现象/根因/修复）、skillCandidates（值得沉淀为 skill 的做法）、memoryFacts（应进入长期记忆的事实）。这是系统自进化（复盘→技能沉淀）的素材输入。',
    parameters: {
      type: 'object',
      properties: {
        taskType: { type: 'string', description: '任务类型，如 plugin-dev / deploy / image-gen / voice-pipeline / research' },
        outcome: { type: 'string', enum: ['success', 'partial', 'failed', 'abandoned'], description: '任务最终结果' },
        summary: { type: 'string', description: '一段话总结：做了什么、关键决策、最终状态' },
        patterns: { type: 'array', items: { type: 'string' }, description: '可复用的做法，每条一句话' },
        pitfalls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              symptom: { type: 'string', description: '现象' },
              cause: { type: 'string', description: '根因' },
              fix: { type: 'string', description: '修复或规避方法' },
            },
            additionalProperties: false,
          },
          description: '踩坑记录'
        },
        skillCandidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '建议的 skill 名' },
              trigger: { type: 'string', description: '什么场景触发' },
              instructions: { type: 'string', description: '可执行步骤' },
              confidence: { type: 'number', description: '0-1 置信度' },
            },
            additionalProperties: false,
          },
          description: '值得沉淀为 skill 的做法'
        },
        memoryFacts: { type: 'array', items: { type: 'string' }, description: '希望进入长期记忆的事实/决策/偏好' },
      },
      required: ['taskType', 'outcome'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          retroId: { type: 'string' },
          storedAt: { type: 'string' },
          pushedToViking: { type: 'integer' },
          vikingNote: { type: 'string' },
        },
        required: ['retroId', 'storedAt', 'pushedToViking'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: formatRetroResult(value) }],
    },
    async execute(args, exec) {
      const session = exec && exec.agent ? exec.agent.session : undefined;
      const sessionId = String((session && session.id) || 'external');
      const norm = normalizeRetroInput(args);
      const record = buildRetroRecord({ sessionId, ...norm });
      store.writeRetro(record);
      harvestCandidates(store);
      try { refreshTelemetry(store) } catch (err) { log('telemetry refresh failed:', err && err.message) }

      let pushed = 0;
      let note = '';
      if (config.pushToViking && record.memoryFacts.length > 0) {
        try {
          const viking = ctx.get('openvikingMemory');
          if (viking && typeof viking.stateFor === 'function' && viking.client && typeof viking.client.addMessage === 'function') {
            const state = viking.stateFor(session);
            if (typeof viking.ensureState === 'function') await viking.ensureState(state);
            if (state && state.ready) {
              for (const fact of record.memoryFacts) {
                await viking.client.addMessage(state.ovSessionId, {
                  role: 'user',
                  parts: [{ type: 'text', text: '[dsh-retro] ' + fact }],
                }, state.config && state.config.peerId);
                pushed += 1;
              }
            } else {
              note = 'OpenViking 未就绪（服务不可达），memoryFacts 仅存本地';
            }
          } else {
            note = '未发现 openvikingMemory 服务（被内存插件 isolate，跨插件不可见），可改用 viking_remember 工具自行沉淀';
          }
        } catch (err) {
          note = 'OpenViking 推送失败：' + ((err && err.message) || err);
        }
      }
      if (pushed === 0 && !note) note = '未推送（memoryFacts 为空或 pushToViking=false）';
      return {
        retroId: record.id,
        storedAt: new Date(record.createdAt).toISOString(),
        pushedToViking: pushed,
        vikingNote: note,
      };
    },
  });

  // —— 可选：把收尾约定注入 system prompt ——
  if (config.remind) {
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next();
      result.sections.push({ name: 'dsh-retro:guidance', text: RETRO_REMINDER_TEXT });
      return result;
    });
  }

  // —— A2：skill 候选 inbox + 晋升门工具 ——
  ctx.tools.register({
    name: 'retro_inbox',
    description:
      '查看 dsh-retro 收割到的 skill 候选清单（pending/approved/rejected/promoted），用于人工或代理审批晋升。先看它，再用 skill_promote / skill_reject 决定去留。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'promoted', 'all'], description: '按状态过滤；默认 pending' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          candidates: { type: 'array' },
        },
        required: ['count'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: formatInbox(value) }],
    },
    async execute(args) {
      const db = loadCandidates(root)
      const status = (args && args.status) || 'pending'
      const list = db.candidates.filter((c) => status === 'all' ? true : c.status === status)
      return { count: list.length, candidates: list }
    },
  });

  ctx.tools.register({
    name: 'skill_promote',
    description:
      '把 retro_inbox 里的 pending skill 候选晋升为可加载的 DSH skill：过 lint 门（kebab-case 命名/描述/指令完整/无密钥）→ 写入 ~/.dsh/skills/<name>.md → 记账。skill 目录被监听，写入后无需重启即可被 skill 工具发现。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '候选 skill 名（kebab-case，见 retro_inbox）' },
        description: { type: 'string', description: '覆盖自动派生的描述（可选）' },
        whenToUse: { type: 'string', description: '覆盖触发场景（可选）' },
        overwrite: { type: 'boolean', description: '同名 skill 已存在时是否覆盖（默认 false）' },
        judge: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['pass', 'fail'], description: '裁判结论' },
            evidence: { type: 'string', description: '裁判证据：为什么合格（≥20 字符）' },
            risks: { type: 'string', description: '风险与规避' },
          },
          additionalProperties: false,
          description: '独立裁判意见（requireJudge=true 时必填，verdict=pass 才放行）'
        },
        probe: {
          type: 'object',
          properties: {
            outcome: { type: 'string', enum: ['passed', 'failed'], description: '探针任务结果' },
            task: { type: 'string', description: '探针任务描述' },
            findings: { type: 'string', description: '有 skill 对照结果' },
          },
          additionalProperties: false,
          description: '探针验证记录（可选）：晋升时附带真实试跑结果'
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          skillName: { type: 'string' },
          path: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: formatPromote(value) }],
    },
    async execute(args) {
      const name = String((args && args.name) || '').trim()
      const db = loadCandidates(root)
      const cand = db.candidates.find((c) => c.name === name)
      if (!cand) return { ok: false, skillName: name, issues: ['候选不存在：先运行 retro_inbox 查看（确认 retros/ 已收割）'] }
      if (cand.status === 'promoted') return { ok: false, skillName: name, issues: ['已晋升过（status=promoted），如需覆盖请先处理文件或传 overwrite:true'] }
      const candidate = { ...cand, description: (args && args.description) || cand.description, whenToUse: (args && args.whenToUse) || cand.whenToUse }
      const judge = (args && args.judge) || {}
      const probe = (args && args.probe) || null
      const issues = config.skillGate ? lintCandidate(candidate) : []
      if (issues.length > 0) {
        cand.status = 'rejected'
        cand.decidedAt = Date.now()
        cand.note = 'lint 拒绝: ' + issues.join('; ')
        saveCandidates(root, db)
        return { ok: false, skillName: name, issues, note: cand.note }
      }
      // —— A3 probe 门：已有 failed 探针的候选禁止晋升 ——
      if (cand.probe && cand.probe.status === 'failed') {
        cand.status = 'rejected'
        cand.decidedAt = Date.now()
        cand.note = 'probe 门拒绝: 已有 failed 探针记录'
        saveCandidates(root, db)
        return { ok: false, skillName: name, issues: ['probe 门拒绝：该候选的探针验证结果为 failed，先修复候选或 skill_probe 重新验证'] }
      }
      // —— A3 judge 门：requireJudge 时必须有裁判意见（verdict=pass + 证据）——
      if (config.requireJudge) {
        const jv = judge && judge.verdict
        const ev = String((judge && judge.evidence) || '').trim()
        if (jv !== 'pass' || ev.length < 20) {
          cand.status = 'rejected'
          cand.decidedAt = Date.now()
          cand.judge = judge || null
          cand.note = 'judge 门拒绝: 需要 verdict=pass 且 evidence≥20 字符（独立裁判意见）'
          saveCandidates(root, db)
          return { ok: false, skillName: name, issues: ['judge 门拒绝：请提供独立裁判意见（judge.verdict=pass + judge.evidence≥20 字符，含合格理由与风险）'] }
        }
      }
      const skillsDir = config.skillsDir || join(dshHome(), 'skills')
      const target = skillFileFor(skillsDir, name)
      if (!(args && args.overwrite) && existsSync(target)) {
        cand.status = 'rejected'
        cand.decidedAt = Date.now()
        cand.note = '目标已存在且 overwrite=false'
        saveCandidates(root, db)
        return { ok: false, skillName: name, issues: ['目标已存在：' + target + '（传 overwrite:true 覆盖，或 skill_reject 拒绝）'] }
      }
      const path = writeSkill(skillsDir, candidate)
      cand.status = 'promoted'
      cand.decidedAt = Date.now()
      cand.note = 'promoted → ' + path
      cand.promotedPath = path
      if (judge && judge.verdict) cand.judge = { verdict: judge.verdict, evidence: String(judge.evidence || '').slice(0, 2000), risks: String(judge.risks || '').slice(0, 1000), at: Date.now() }
      if (probe && probe.outcome) cand.probe = { status: probe.outcome, task: String(probe.task || '').slice(0, 500), findings: String(probe.findings || '').slice(0, 2000), at: Date.now() }
      saveCandidates(root, db)
      return { ok: true, skillName: name, path, issues: [] }
    },
  });

  ctx.tools.register({
    name: 'skill_probe',
    description:
      '对一个 skill 候选执行探针验证并回填记录（A3 probe 门）：调用者真实试跑候选的 instructions 后提交对照结果；status=failed 会阻止该候选晋升。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '候选 skill 名' },
        task: { type: 'string', description: '探针任务描述（用候选 instructions 做的对照测试）' },
        outcome: { type: 'string', enum: ['passed', 'failed'], description: '探针结果' },
        findings: { type: 'string', description: '对照发现（有 skill 与无 skill 的差异）' },
      },
      required: ['name', 'task', 'outcome'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          probeStatus: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: 'skill_probe: ' + JSON.stringify(value) }],
    },
    async execute(args) {
      const db = loadCandidates(root)
      const cand = db.candidates.find((c) => c.name === (args && args.name))
      if (!cand) return { ok: false, name: (args && args.name) || '', error: '候选不存在' }
      cand.probe = {
        status: args.outcome,
        task: String(args.task || '').slice(0, 500),
        findings: String(args.findings || '').slice(0, 2000),
        at: Date.now(),
      }
      saveCandidates(root, db)
      return { ok: true, name: cand.name, probeStatus: cand.probe.status }
    },
  });

  ctx.tools.register({
    name: 'retro_telemetry',
    description:
      '生成 skill 投资回报表（A4 遥测）：按 skill 覆盖的 taskType 聚合晋升前后的会话质量（工具失败率/用户纠错率），verdict=healthy/deprecated/insufficient；verdict=deprecated 的 skill 会被自动降级（status=deprecated）。',
    parameters: {
      type: 'object',
      properties: {
        taskType: { type: 'string', description: '按 taskType 过滤（可选）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          generatedAt: { type: 'string' },
          summary: { type: 'object', additionalProperties: true },
          skills: { type: 'array' },
        },
        required: ['generatedAt', 'summary'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: formatTelemetry(value) }],
    },
    async execute(args) {
      const db = refreshTelemetry(store)
      const filter = (args && args.taskType) || ''
      const skills = db.candidates
        .filter((c) => c.status === 'promoted' || c.status === 'deprecated')
        .filter((c) => !filter || c.telemetry && c.telemetry.coveredTaskType === filter)
        .map((c) => ({
          name: c.name,
          status: c.status,
          coveredTaskType: c.telemetry && c.telemetry.coveredTaskType,
          verdict: c.telemetry && c.telemetry.verdict,
          samplesBefore: c.telemetry && c.telemetry.samplesBefore,
          samplesAfter: c.telemetry && c.telemetry.samplesAfter,
          failRateBefore: c.telemetry && c.telemetry.failRateBefore,
          failRateAfter: c.telemetry && c.telemetry.failRateAfter,
          correctionRateBefore: c.telemetry && c.telemetry.correctionRateBefore,
          correctionRateAfter: c.telemetry && c.telemetry.correctionRateAfter,
        }))
      const summary = { healthy: 0, deprecated: 0, insufficient: 0 }
      for (const s of skills) summary[s.verdict] = (summary[s.verdict] || 0) + 1
      return { generatedAt: new Date().toISOString(), summary, skills }
    },
  });

  ctx.tools.register({
    name: 'skill_reject',
    description:
      '拒绝 retro_inbox 里的一条 skill 候选（记入 ledger，不再晋升）；或把已拒绝的恢复为 pending。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '候选 skill 名' },
        reason: { type: 'string', description: '拒绝原因' },
        restore: { type: 'boolean', description: '把 rejected 恢复为 pending（true）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: 'skill_reject: ' + JSON.stringify(value) }],
    },
    async execute(args) {
      const db = loadCandidates(root)
      const cand = db.candidates.find((c) => c.name === (args && args.name))
      if (!cand) return { ok: false, name: (args && args.name) || '', error: '候选不存在' }
      cand.status = (args && args.restore) ? 'pending' : 'rejected'
      cand.decidedAt = Date.now()
      if (args && args.reason) cand.note = 'reject: ' + String(args.reason).slice(0, 500)
      saveCandidates(root, db)
      return { ok: true, name: cand.name, status: cand.status }
    },
  });


// —— web client 数据路由：GET /retro/state → 候选账本 + 统计 ——
function handleRetroHttp(root, req, res) {
  const url = new URL(req.url || '/', 'http://dsh-retro.local')
  const send = (status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  try {
    if (req.method === 'GET' && url.pathname === '/retro/state') {
      const db = loadCandidates(root)
      const list = db.candidates.map((c) => ({
        name: c.name, status: c.status, confidence: c.confidence,
        sourceTaskType: c.sourceTaskType, sourceRetroId: c.sourceRetroId,
        judge: c.judge ? { verdict: c.judge.verdict } : null,
        telemetry: c.telemetry || null,
        probe: c.probe ? { status: c.probe.status } : null,
        note: c.note, createdAt: c.createdAt, decidedAt: c.decidedAt,
      }))
      const counts = { pending: 0, promoted: 0, rejected: 0, deprecated: 0 }
      for (const c of db.candidates) counts[c.status] = (counts[c.status] ?? 0) + 1
      let turnFiles = []
      try { turnFiles = readdirSync(join(root, 'turns')).filter((f) => f.endsWith('.jsonl')).sort() } catch {}
      let retroCount = 0
      try { retroCount = readdirSync(join(root, 'retros')).filter((f) => f.endsWith('.json')).length } catch {}
      send(200, { ok: true, candidates: list, counts, turnFiles, retroCount, storageRoot: root })
      return
    }
    send(404, { ok: false, error: { code: 'not-found', message: url.pathname } })
  } catch (err) {
    send(500, { ok: false, error: { code: 'internal', message: (err && err.message) || String(err) } })
  }
}
  // —— inbox 轮询：外部投递的复盘 JSON ——
  if (config.inbox) {
    const scan = () => ingestInbox(store);
    try { scan(); } catch (err) { log('inbox scan failed:', err && err.message) }
    const timer = setInterval(scan, Math.max(10_000, Number(config.inboxIntervalMs) || 60_000));
    if (typeof timer.unref === 'function') timer.unref();
    ctx.on('dispose', () => clearInterval(timer));
  }

  // —— web client 数据源：路由在 webServer 服务出现后注册，消失时自动注销 ——
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'prefix',
      path: '/retro',
      handler: (req, res) => handleRetroHttp(root, req, res),
    }), 'dsh-retro: webserver')
  })
  log('started: root=' + root + ' remind=' + (config.remind ? 'on' : 'off') + ' viking=' + (config.pushToViking ? 'on' : 'off') + ' inbox=' + (config.inbox ? 'on' : 'off'));
}
