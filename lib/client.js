/* dsh-retro client half — built. 候选面板（只读 + 刷新）。编辑本文件后需重启 DSH web 生效。 */
window.__ModuleLoader__.load({
  id: 'dsh-retro',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    /**
     * dsh-retro client half — 复盘与技能晋升面板（设置页插件卡片）。
     * 数据来自宿主路由 GET /retro/state。审批动作请在会话中由 agent 执行
     * skill_promote / skill_reject（judge 门需要裁判意见，浏览器不做审批写操作）。
     */
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'dsh-retro'
    const PREFIX = '/retro'

    const zh = {
      nav: '复盘与技能晋升',
      desc: '回合轨迹 + 会话摘要 + 结构化复盘 + skill 候选晋升门（retro_review / retro_inbox / skill_promote / skill_probe / skill_reject）',
      loading: '读取中...',
      refresh: '刷新',
      error: '读取失败',
      counts: '候选账本',
      pending: '待审',
      promoted: '已晋升',
      rejected: '已拒绝',
      deprecated: '已降级',
      retros: '复盘记录',
      turns: '回合轨迹',
      candidates: '候选列表',
      empty: '（无候选）',
      source: '来源',
      judge: '裁判',
      probe: '探针',
      note: '备注',
      hint: '审批请在会话中让 agent 调用 skill_promote / skill_reject（需提供 judge 裁判意见）。',
    }

    const en = {
      nav: 'Retro & Skill Promotion',
      desc: 'Turn traces + session summaries + structured retros + skill candidate promotion gate',
      loading: 'Loading...',
      refresh: 'Refresh',
      error: 'Load failed',
      counts: 'Candidate ledger',
      pending: 'pending',
      promoted: 'promoted',
      rejected: 'rejected',
      deprecated: 'deprecated',
      retros: 'retros',
      turns: 'turns',
      candidates: 'Candidates',
      empty: '(none)',
      source: 'source',
      judge: 'judge',
      probe: 'probe',
      note: 'note',
      hint: 'Approve in-session: ask the agent to run skill_promote / skill_reject (judge opinion required).',
    }

    const css = [
      '.dsh-retro-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}',
      '.dsh-retro-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px}',
      '.dsh-retro-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-retro-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
      '.dsh-retro-counts{display:flex;gap:8px;padding:0 16px 12px;flex-wrap:wrap}',
      '.dsh-retro-count{font-size:12px;line-height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
      '.dsh-retro-count b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-retro-list{display:flex;flex-direction:column;gap:8px;padding:0 16px 14px}',
      '.dsh-retro-item{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-retro-item-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-retro-badge{font-size:11px;line-height:17px;padding:0 8px;border-radius:999px}',
      '.dsh-retro-badge-pending{background:rgba(245,158,11,.14);color:#f59e0b}',
      '.dsh-retro-badge-promoted{background:rgba(16,185,129,.12);color:#10b981}',
      '.dsh-retro-badge-rejected{background:rgba(239,68,68,.12);color:#ef4444}',
      '.dsh-retro-item-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-retro-note{margin-top:6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-retro-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-retro-hint{margin:0 16px 14px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-retro-error{margin:0 16px 14px;font-size:12px;color:var(--dsw-alias-label-error)}',
    ].join('\n')

    function RetroPanel(props) {
      const { t } = props
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(() => {
        fetch(PREFIX + '/state')
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok) { setState(body); setError('') } else { setError((body && body.error && body.error.message) || t('error')) }
          })
          .catch(() => setError(t('error')))
      }, [t])
      useEffect(() => { load() }, [load])

      const counts = (state && state.counts) || {}
      const candidates = (state && state.candidates) || []
      return h('div', { className: 'dsh-retro-card' },
        h('div', { className: 'dsh-retro-head' },
          h('div', null,
            h('div', { className: 'dsh-retro-title' }, t('nav')),
            h('div', { className: 'dsh-retro-desc' }, t('desc')),
          ),
          h('button', { className: 'dsh-retro-btn', onClick: load }, t('refresh')),
        ),
        h('div', { className: 'dsh-retro-counts' },
          h('span', { className: 'dsh-retro-count' }, t('pending') + ': <b>' + (counts.pending || 0) + '</b>'),
          h('span', { className: 'dsh-retro-count' }, t('promoted') + ': <b>' + (counts.promoted || 0) + '</b>'),
          h('span', { className: 'dsh-retro-count' }, t('rejected') + ': <b>' + (counts.rejected || 0) + '</b>'),
          h('span', { className: 'dsh-retro-count' }, t('deprecated') + ': <b>' + (counts.deprecated || 0) + '</b>'),
          h('span', { className: 'dsh-retro-count' }, t('retros') + ': <b>' + (state ? state.retroCount : 0) + '</b>'),
          h('span', { className: 'dsh-retro-count' }, t('turns') + ': <b>' + (state ? state.turnFiles.length : 0) + '</b>'),
        ),
        error ? h('p', { className: 'dsh-retro-error' }, error) : null,
        h('div', { className: 'dsh-retro-list' },
          candidates.length === 0
            ? h('span', { className: 'dsh-retro-note' }, t('empty'))
            : candidates.map((c) => {
              const badges = [
                h('span', { className: 'dsh-retro-badge dsh-retro-badge-' + c.status, key: 's' }, c.status),
                c.judge ? h('span', { className: 'dsh-retro-badge dsh-retro-badge-promoted', key: 'j' }, t('judge') + ': ' + c.judge.verdict) : null,
                c.probe ? h('span', { className: 'dsh-retro-badge ' + (c.probe.status === 'passed' ? 'dsh-retro-badge-promoted' : 'dsh-retro-badge-rejected'), key: 'p' }, t('probe') + ': ' + c.probe.status) : null,
                c.telemetry ? h('span', { className: 'dsh-retro-badge ' + (c.telemetry.verdict === 'deprecated' ? 'dsh-retro-badge-rejected' : c.telemetry.verdict === 'healthy' ? 'dsh-retro-badge-promoted' : 'dsh-retro-badge-pending'), key: 't' }, 'tele: ' + c.telemetry.verdict) : null,
              ]
              return h('div', { className: 'dsh-retro-item', key: c.name },
                h('div', { className: 'dsh-retro-item-head' }, c.name, badges),
                h('div', { className: 'dsh-retro-item-meta' },
                  h('span', { key: 'src' }, t('source') + ': ' + (c.sourceTaskType || '-') + (typeof c.confidence === 'number' ? ' · conf=' + c.confidence : '')),
                  h('span', { key: 'at' }, new Date(c.createdAt).toLocaleString()),
                ),
                c.note ? h('div', { className: 'dsh-retro-note' }, c.note) : null,
              )
            }),
        ),
        h('p', { className: 'dsh-retro-hint' }, t('hint')),
      )
    }

    const inject = ['slots', 'locale', 'connection']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('settings.dshRetro', { zh, en }), 'dsh-retro: locale')
      const connection = ctx.get('connection')
      const t = ctx.locale.bind('settings.dshRetro')

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        id: NS,
        order: 45,
        locale: 'settings.dshRetro',
        inject: () => ({ api: connection.api, t }),
      }, RetroPanel))

      const style = document.createElement('style')
      style.textContent = css
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-retro: css')
    }

    exports.apply = apply
    exports.inject = inject

    return module.exports
  },
})