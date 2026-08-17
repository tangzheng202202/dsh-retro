import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SessionTracker, buildTurnTrace, buildSessionSummary, buildRetroRecord,
  normalizeRetroInput, looksLikeCorrection, sanitizeStrings, sanitizePitfalls,
  sanitizeSkillCandidates, isHumanMessage, textOfMessage,
} from '../lib/index.js'

test('looksLikeCorrection: 中文纠错信号', () => {
  assert.equal(looksLikeCorrection('不对，重来'), true)
  assert.equal(looksLikeCorrection('这个方案不行'), true)
  assert.equal(looksLikeCorrection('很好，继续'), false)
  assert.equal(looksLikeCorrection(''), false)
  assert.equal(looksLikeCorrection('x'.repeat(500)), false)
})

test('textOfMessage 提取文本块与工具结果内嵌文本', () => {
  const msg = { content: [
    { type: 'text', text: 'hello' },
    { type: 'tool-result', content: [{ type: 'text', text: 'world' }] },
  ] }
  assert.equal(textOfMessage(msg), 'hello\nworld')
  assert.equal(textOfMessage(null), '')
})

test('isHumanMessage 只认 user 来源', () => {
  assert.equal(isHumanMessage({ role: 'user', source: { kind: 'user' }, content: [] }), true)
  assert.equal(isHumanMessage({ role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [] }), false)
  assert.equal(isHumanMessage({ role: 'assistant', source: { kind: 'model' } }), false)
})

test('sanitize* 结构白名单与长度截断', () => {
  assert.deepEqual(sanitizeStrings([' a ', 42, null, 'b']), ['a', 'b'])
  assert.deepEqual(sanitizeStrings(['x'.repeat(3000)], 100), ['x'.repeat(100)])
  assert.deepEqual(sanitizePitfalls([{ symptom: 's', cause: 'c', fix: 'f', junk: 1 }]), [{ symptom: 's', cause: 'c', fix: 'f' }])
  assert.deepEqual(sanitizeSkillCandidates([{ name: 'n', confidence: 5 }]), [{ name: 'n', trigger: '', instructions: '', confidence: 1 }])
})

test('normalizeRetroInput 默认值与枚举约束', () => {
  const n = normalizeRetroInput({ outcome: 'bogus' })
  assert.equal(n.taskType, 'unknown')
  assert.equal(n.outcome, 'partial')
  const ok = normalizeRetroInput({ taskType: '  plugin-dev  ', outcome: 'success', patterns: ['p'], memoryFacts: ['f'] })
  assert.equal(ok.taskType, 'plugin-dev')
  assert.equal(ok.outcome, 'success')
  assert.deepEqual(ok.patterns, ['p'])
})

test('SessionTracker 全流程：工具成败/纠正/todo/回合统计', () => {
  const t = new SessionTracker('sess-1', 1000)
  t.openTurn(1)
  t.onStepStart()
  t.onToolCall('bash', 'c1')
  t.onToolResult('c1', { isError: false })
  t.onToolCall('bash', 'c2')
  t.onToolResult('c2', { isError: true, errorCode: 'E_BAD' })
  t.onUserMessage('不对，重新做', true)
  t.onAssistantMessage(123)
  t.onTodoWrite([{ content: 'a', status: 'done' }])
  const state = t.closeTurn(1, 'completed')

  const trace = buildTurnTrace('sess-1', t, state)
  assert.equal(trace.toolCalls.length, 2)
  assert.equal(trace.toolCalls[1].ok, false)
  assert.equal(trace.toolCalls[1].errorCode, 'E_BAD')
  assert.equal(trace.corrections, 1)
  assert.equal(trace.assistantTokens, 123)

  t.close()
  const summary = buildSessionSummary('sess-1', t, { minToolsForRetro: 2, minTurnsForRetro: 3 })
  assert.equal(summary.toolCalls.total, 2)
  assert.equal(summary.toolCalls.failed, 1)
  assert.equal(summary.corrections, 1)
  assert.equal(summary.worthRetro, true) // failed>0 也触发
  assert.equal(summary.todoWrites, 1)
})

test('buildSessionSummary worthRetro 阈值', () => {
  const t = new SessionTracker('s', 0)
  t.openTurn(1); t.closeTurn(1, 'completed')
  t.close()
  assert.equal(buildSessionSummary('s', t, { minToolsForRetro: 2, minTurnsForRetro: 3 }).worthRetro, false)
  const t2 = new SessionTracker('s2', 0)
  t2.openTurn(1); t2.closeTurn(1); t2.openTurn(2); t2.closeTurn(2); t2.openTurn(3); t2.closeTurn(3)
  t2.close()
  assert.equal(buildSessionSummary('s2', t2, { minToolsForRetro: 2, minTurnsForRetro: 3 }).worthRetro, true)
})

test('buildRetroRecord 结构完整', () => {
  const r = buildRetroRecord({ sessionId: 's', taskType: 'x', outcome: 'success', memoryFacts: ['f'] })
  assert.equal(r.kind, 'retro')
  assert.equal(r.version, 1)
  assert.ok(r.id.startsWith('s-'))
  assert.equal(r.memoryFacts[0], 'f')
})
