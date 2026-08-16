// 本文件由 tools/build.js 自动生成（node tools/build.js），请勿手动修改
// 用法：将本文件内容作为 cordis_define 的 code.client 函数体
// 生成时间：2026-08-16T10:37:58.204Z

// DSH 动态插件 Client 半部（invest_run 专属工具卡片：阶段进度 + SVG 图表内联渲染）
// 由 tools/build.js 复制为 dist/invest-run.client.js
// 依赖：ctx（Cordis）、React、host、styles、timer（Client 内建/服务）

return {
  name: 'invest-run-card',
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => styles.insert([
      '.invr-card{background:var(--dsw-alias-bg-subtle, rgba(128,128,128,.06));border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));border-radius:10px;padding:10px 12px;margin:2px 0;font-size:13px;line-height:1.5}',
      '.invr-head{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
      '.invr-title{font-weight:600;color:var(--dsw-alias-label-primary, inherit)}',
      '.invr-hint{color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9));font-size:12px}',
      '.invr-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
      '.invr-badge{background:var(--dsw-alias-bg-hover, rgba(128,128,128,.14));border-radius:6px;padding:1px 8px;font-size:12px;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9))}',
      '.invr-badge.ok{color:var(--dsw-alias-state-success-primary, #2f9e44)}',
      '.invr-badge.fail{color:var(--dsw-alias-state-error-primary, #e03131)}',
      '.invr-charts{display:flex;flex-direction:column;gap:8px;margin-top:8px}',
      '.invr-chart{width:100%;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));border-radius:8px;background:#ffffff}',
      '.invr-charterr{color:var(--dsw-alias-state-error-primary, #e03131);font-size:12px}',
      '.invr-body{white-space:pre-wrap;max-height:340px;overflow:auto;margin-top:8px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-base, transparent);border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));font-family:inherit}',
    ].join('\n')))
    const fmt = (ms) => (ms === undefined || ms === null || ms === '') ? '' : (ms / 1000).toFixed(1) + 's'
    function Card(props) {
      const block = props.block
      const [open, setOpen] = React.useState(false)
      const [charts, setCharts] = React.useState([])
      const [prog, setProg] = React.useState(null)
      const isDone = block !== undefined && block !== null && block.kind === 'tool-result'
      React.useEffect(() => {
        if (!isDone) return
        const meta = block.meta
        const paths = (meta && Array.isArray(meta.charts)) ? meta.charts.map((c) => (c && typeof c.path === 'string') ? c.path : null).filter(Boolean) : []
        if (paths.length === 0) return
        setCharts(paths.map((p) => ({ path: p, svg: null, err: null })))
        let dead = false
        paths.forEach((p, i) => {
          host.call('chart-content', { path: p }).then((res) => {
            if (dead) return
            setCharts((prev) => prev.map((c, j) => (j === i ? { path: p, svg: (res && typeof res.svg === 'string') ? res.svg : null, err: (res && res.error) ? String(res.error) : null } : c)))
          }).catch((e) => {
            if (dead) return
            setCharts((prev) => prev.map((c, j) => (j === i ? { path: p, svg: null, err: String(e).slice(0, 140) } : c)))
          })
        })
        return () => { dead = true }
      }, [block, isDone])
      React.useEffect(() => {
        if (isDone) return
        const tick = () => {
          host.call('progress', { callId: props.callId }).then((res) => {
            if (res && !res.none) setProg(res)
          }).catch(() => {})
        }
        tick()
        const stop = ctx.interval(tick, 2000)
        return stop
      }, [isDone, props.callId])
      const meta = (isDone && block.meta && typeof block.meta === 'object') ? block.meta : null
      const stages = (meta && Array.isArray(meta.stages)) ? meta.stages : []
      const modeText = meta && typeof meta.mode === 'string' ? meta.mode : ''
      const bodyText = isDone && Array.isArray(block.content) && block.content[0] && block.content[0].type === 'text' ? block.content[0].text : ''
      const badges = []
      for (const s of stages) {
        badges.push(React.createElement('span', { key: s.stage, className: 'invr-badge ' + (s.ok ? 'ok' : 'fail') },
          s.stage + (s.ok ? ' · ' + fmt(s.elapsedMs) : ' · 失败')))
      }
      const chartNodes = charts.map((c, i) => React.createElement('div', { key: i },
        c.svg !== null ? React.createElement('img', { className: 'invr-chart', alt: c.path, src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(c.svg) })
          : c.err !== null ? React.createElement('div', { className: 'invr-charterr' }, '图表加载失败：' + c.err)
            : React.createElement('div', { className: 'invr-hint' }, '图表加载中…')))
      if (!isDone) {
        let runMode = ''
        try {
          const a = JSON.parse(block.argsRaw || '{}')
          if (a && typeof a.mode === 'string') runMode = a.mode
        } catch (e) { /* ignore */ }
        const doneList = (prog && Array.isArray(prog.done)) ? prog.done : []
        const doneBadges = doneList.map((d, i) => React.createElement('span', { key: 'd' + i, className: 'invr-badge ok' },
          d.stage + ' · ' + fmt(d.ms)))
        const line = (prog && typeof prog.total === 'number' && prog.total > 0)
          ? '进行中 ' + prog.index + '/' + prog.total + '：' + prog.stage
          : '子代理启动中…'
        return React.createElement('div', { className: 'invr-card' },
          React.createElement('div', { className: 'invr-head' },
            React.createElement('span', { className: 'invr-title' }, 'invest_run 投研流水线' + (runMode ? ' · ' + runMode : '')),
            React.createElement('span', { className: 'invr-hint' }, line)),
          doneBadges.length ? React.createElement('div', { className: 'invr-badges' }, doneBadges) : null)
      }
      return React.createElement('div', { className: 'invr-card' },
        React.createElement('div', { className: 'invr-head', onClick: () => setOpen((o) => !o) },
          React.createElement('span', { className: 'invr-title' }, '投研流水线 · ' + modeText),
          React.createElement('span', { className: 'invr-hint' }, open ? '收起' : '展开')),
        badges.length ? React.createElement('div', { className: 'invr-badges' }, badges) : null,
        open ? React.createElement('div', null,
          charts.length ? React.createElement('div', { className: 'invr-charts' }, chartNodes) : null,
          bodyText ? React.createElement('div', { className: 'invr-body' }, bodyText) : null) : null)
    }
    slots.inject('tool.call.toolview', () => slots.register(
      { name: 'tool.call.toolview', key: 'invest_run' },
      (props) => React.createElement(Card, props),
    ))
  },
}

