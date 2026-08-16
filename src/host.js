// DSH 动态插件 Host 半部（invest_run 工具 + 流水线编排）
// 由 tools/build.js 与 src/prompts.js 合并生成 dist/invest-run.host.js（完整函数体）
// 依赖：ctx（Cordis 受限上下文）、harness（DSH Host 内建）、PROMPTS（build 注入的提示词数据）

const { P_SELECT, P_NEWS, P_DEEP, P_FINAL } = PROMPTS

return {
  name: 'invest-run',
  apply(ctx) {
    const text = (s) => [{ type: 'text', text: String(s) }]
    const progressStore = {}
    const CACHE_DIR = 'E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache'
    const TRADE_CACHE = CACHE_DIR + '/last-trade-date.json'
    const REPORTS_DIR = 'E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/reports'
    const z2 = (n) => (n < 10 ? '0' : '') + n
    const localYmd = () => { const d = new Date(); return '' + d.getFullYear() + z2(d.getMonth() + 1) + z2(d.getDate()) }

    // 从子代理 result 提取纯文本（剥离 reasoning）
    const extractText = (raw) => {
      let s = raw
      if (typeof raw !== 'string') s = JSON.stringify(raw)
      try {
        const obj = JSON.parse(s)
        if (obj && Array.isArray(obj.output)) {
          const parts = obj.output.filter(b => b && b.type === 'text' && b.text).map(b => b.text)
          if (parts.length) return parts.join('\n')
        }
      } catch (e) { /* ignore */ }
      return s
    }

    // 从文本中收集完整绝对路径的 SVG 图表
    const collectCharts = (t) => {
      const re = /E:[\\/][^\s"'<>]+?\.svg/gi
      const set = new Set()
      const m = String(t).match(re)
      if (m) m.forEach(x => set.add(x.replace(/\\/g, '/')))
      return Array.from(set)
    }

    // Client→Host：按需读取图表 SVG（路径白名单）
    harness.handle('chart-content', async (args) => {
      const fs = ctx.get('fs')
      if (fs === undefined) return { error: 'fs unavailable' }
      const p = args && typeof args.path === 'string' ? args.path : ''
      if (!/\.svg$/i.test(p) || p.indexOf('.dsh-invest') < 0 || p.indexOf('charts') < 0) return { error: 'denied' }
      try {
        const target = await fs.resolve(p)
        const svg = await fs.readText(target)
        if (svg.length > 160000) return { error: 'too large' }
        return { path: p, svg }
      } catch (e) {
        return { error: String(e).slice(0, 200) }
      }
    })

    // Client→Host：运行中阶段进度（仅返回 JSON 安全字段）
    harness.handle('progress', async (args) => {
      const id = args && typeof args.callId === 'string' ? args.callId : ''
      const p = id ? progressStore[id] : undefined
      if (p === undefined) return { none: true }
      const out = {
        stage: typeof p.stage === 'string' ? p.stage : '',
        index: typeof p.index === 'number' ? p.index : 0,
        total: typeof p.total === 'number' ? p.total : 0,
        status: typeof p.status === 'string' ? p.status : '',
        done: Array.isArray(p.done) ? p.done : [],
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
      }
      if (typeof p.elapsedMs === 'number') out.elapsedMs = p.elapsedMs
      return out
    })

    // 当日交易日锚点缓存（子代理写入，Host 读取注入）
    const readTradeCache = async () => {
      const fs = ctx.get('fs')
      if (fs === undefined) return null
      try {
        const target = await fs.resolve(TRADE_CACHE)
        const raw = await fs.readText(target)
        const obj = JSON.parse(raw)
        if (obj && typeof obj.trade_date === 'string' && /^\d{8}$/.test(obj.trade_date) && obj.date === localYmd()) return obj.trade_date
      } catch (e) { /* ignore */ }
      return null
    }

    const tool = harness.defineTool({
      name: 'invest_run',
      description: '运行多角色投研流水线。mode 取值：选股/消息/深度分析/总判断/all。question 为用户投研问题；context 可选，传入上一轮分析结论或追问背景（记忆与追问）。数据用 Tushare 实时获取。',
      parameters: { type: 'object', properties: { mode: { type: 'string', description: '运行模式' }, question: { type: 'string', description: '用户投研问题' }, context: { type: 'string', description: '可选：上一轮分析结论/追问背景，让本轮分析有记忆' } }, required: ['mode', 'question'] },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          const lines = []
          const outputs = Array.isArray(value.outputs) ? value.outputs : []
          const charts = Array.isArray(value.charts) ? value.charts : []
          const reports = Array.isArray(value.reports) ? value.reports : []
          lines.push('invest_run 模式=' + String(value.mode || '') + ' ｜ 阶段数=' + outputs.length + (charts.length ? ' ｜ 图表=' + charts.length + ' 张' : '') + (reports.length ? ' ｜ 报告已归档' : ''))
          for (const o of outputs) {
            lines.push('')
            lines.push('=== ' + o.stage + (o.ok ? ' ｜ 耗时 ' + (o.elapsedMs / 1000).toFixed(1) + 's' : ' ｜ 失败') + ' ===')
            if (o.error) lines.push('错误：' + o.error)
            if (o.ok && typeof o.text === 'string') {
              const t = o.text
              lines.push(t.length > 4000 ? t.slice(0, 4000) + '\n…（其余省略）' : t)
            }
          }
          if (charts.length) {
            lines.push('')
            lines.push('图表文件：' + charts.join(' , '))
          }
          if (reports.length) {
            lines.push('')
            lines.push('报告归档：' + reports.join(' , '))
          }
          if (value.reportError) lines.push('归档错误：' + value.reportError)
          return text(lines.join('\n'))
        },
        presentationMeta: (args, value) => ({
          mode: String(value.mode || ''),
          charts: (Array.isArray(value.charts) ? value.charts : []).map((p) => ({ path: String(p) })),
          stages: (Array.isArray(value.outputs) ? value.outputs : []).map((o) => ({ stage: o.stage, ok: o.ok === true, elapsedMs: o.elapsedMs })),
        }),
      },
      async execute(args, exec) {
        const mode = args.mode
        const question = args.question
        const context = typeof args.context === 'string' && args.context.trim() ? args.context.trim().slice(0, 4000) : ''
        const callId = String(exec.callId || '')
        const subs = ctx.get('subagents')
        if (subs === undefined) return { error: 'subagents not mounted' }
        const R = (name, persona) => ({ name, persona })
        // 分组编排：A 组（选股+消息并行）→ B 组（深度）→ C 组（总判断）
        let groups = []
        switch (mode) {
          case '选股': groups = [[R('选股分析师', P_SELECT)]]; break
          case '消息': groups = [[R('市场重点消息获取师', P_NEWS)]]; break
          case '深度分析': groups = [[R('选股分析师', P_SELECT)], [R('股票深度分析师', P_DEEP)]]; break
          case '总判断': groups = [[R('选股分析师', P_SELECT), R('市场重点消息获取师', P_NEWS)], [R('股票深度分析师', P_DEEP)], [R('总判断师', P_FINAL)]]; break
          default: groups = [[R('选股分析师', P_SELECT), R('市场重点消息获取师', P_NEWS)], [R('股票深度分析师', P_DEEP)], [R('总判断师', P_FINAL)]]
        }
        const setProgress = (p) => { progressStore[callId] = Object.assign({ updatedAt: Date.now() }, p) }
        setProgress({ stage: '', index: 0, total: groups.length, status: 'init', done: [] })
        const anchor = await readTradeCache()
        const anchorLine = anchor
          ? '【已缓存锚定】真实最新交易日 = ' + anchor + '（由流水线缓存提供，跳过 index_daily 锚定步骤，直接按此日期取数）'
          : '【交易日缓存为空】按日期锚定铁律完成 index_daily 锚定后，用 pwsh 执行 node -e 把 JSON {"date":"' + localYmd() + '","trade_date":"你的锚定结果YYYYMMDD"} 写入 ' + TRADE_CACHE + '（目录不存在先创建），供本日后续运行复用'
        const history = []
        const outputs = []
        const allCharts = new Set()
        const runStage = async (s) => {
          const t0 = Date.now()
          const parts = ['用户问题：' + question]
          if (context) parts.push('【对话上下文（记忆）】' + context + '\n请结合上述上下文继续分析，保持口径一致。')
          parts.push(anchorLine)
          for (const h of history) {
            parts.push('【' + h.stage + ' 产出（请基于其继续，勿重复取数已覆盖内容）】\n' + h.text)
          }
          parts.push('请按你的角色职责完成分析并输出完整结果。')
          const basePrompt = parts.join('\n\n')
          let lastErr = ''
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const promptText = lastErr ? basePrompt + '\n\n【上次执行失败，错误信息】' + lastErr + '\n请修正后重试。' : basePrompt
              const run = await subs.start('spawn', {
                label: s.name + (attempt > 1 ? '(重试)' : ''),
                prompt: [{ type: 'text', text: promptText }],
                parent: exec.agent,
                signal: exec.signal,
                persona: s.persona,
              })
              const result = await run.result
              const outText = extractText(result)
              const full = String(outText)
              collectCharts(full).forEach(c => allCharts.add(c))
              return { stage: s.name, ok: true, elapsedMs: Date.now() - t0, text: full.slice(0, 9000) }
            } catch (e) {
              lastErr = String(e).slice(0, 600)
              // 失败分类：权限/频率类错误重试无意义，直接失败；其余（网络/超时/模型）重试
              const nonRetryable = /40203|无权限|权限不足|超限|频率|quota|forbidden|unauthorized|unauthenticated/i.test(lastErr)
              if (nonRetryable || attempt === 2) {
                return { stage: s.name, ok: false, error: lastErr, elapsedMs: Date.now() - t0, retried: attempt > 1 }
              }
            }
          }
          return { stage: s.name, ok: false, error: '未知失败', elapsedMs: Date.now() - t0 }
        }
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi]
          const groupLabel = g.map(x => x.name).join(' + ')
          setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: 'running', done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs })) })
          const results = await Promise.all(g.map(s => runStage(s)))
          for (const r of results) {
            outputs.push(r)
            if (r.ok) history.push({ stage: r.stage, text: r.text })
          }
          setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: 'done', elapsedMs: results.reduce((a, r) => Math.max(a, r.elapsedMs || 0), 0), done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs })) })
        }
        setProgress({ stage: '', index: groups.length, total: groups.length, status: 'final', done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs })) })
        // 报告归档（显式携带会话 sandboxPolicy，否则 workspace-write 默认根不含工作区）
        const reports = []
        let reportError = ''
        const fs = ctx.get('fs')
        const sp = ctx.get('sandboxPolicy')
        const policy = (sp !== undefined && exec.agent !== undefined) ? sp.resolve({ session: exec.agent.session }) : undefined
        if (fs !== undefined) {
          try {
            const d = new Date()
            const stamp = localYmd() + '_' + z2(d.getHours()) + z2(d.getMinutes())
            const qkey = String(question).replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 16) || 'query'
            const reportPath = REPORTS_DIR + '/' + stamp + '_' + qkey + '.md'
            const lines = []
            lines.push('# 投研流水线报告')
            lines.push('')
            lines.push('- 模式：' + mode)
            lines.push('- 时间：' + stamp)
            lines.push('- 问题：' + question)
            if (context) { lines.push('- 上下文：' + context.slice(0, 200).replace(/\n/g, ' ')) }
            for (const o of outputs) {
              lines.push('')
              lines.push('## ' + o.stage + (o.ok ? '（耗时 ' + (o.elapsedMs / 1000).toFixed(1) + 's' + (o.retried ? '，含重试' : '') + '）' : '（失败）'))
              lines.push('')
              lines.push(o.ok ? o.text : ('错误：' + o.error))
            }
            if (allCharts.size) {
              lines.push('')
              lines.push('## 图表')
              for (const c of Array.from(allCharts)) lines.push('- ' + c)
            }
            lines.push('')
            lines.push('---')
            lines.push('仅供参考，不构成投资建议。')
            const target = await fs.resolve(reportPath)
            await fs.writeText(target, lines.join('\n'), undefined, undefined, policy)
            reports.push(reportPath)
          } catch (e) {
            reportError = String(e).slice(0, 300)
          }
        } else {
          reportError = 'fs unavailable'
        }
        return { mode, stages: outputs.map(o => o.stage), charts: Array.from(allCharts), reports, reportError, outputs }
      },
    })
    harness.registerTool(ctx, tool)
  },
}
