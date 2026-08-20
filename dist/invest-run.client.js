// 本文件由 tools/build.js 自动生成（node tools/build.js），请勿手动修改
// 用法：将本文件内容作为 cordis_define 的 code.client 函数体
// 生成时间：2026-08-20T08:09:32.892Z

// dsh-invest 纯函数集合（无副作用、无外部依赖，可独立单测）
// 双形态共享：dist 由 tools/build.js 内联；packages/lib/pure.js 由 build.js 转换为 ESM 后 import
// 修改后重新执行 `node tools/build.js` 同步到 dist 与 packages/lib

const z2 = (n) => (n < 10 ? '0' : '') + n

const localYmd = () => {
  const d = new Date()
  return '' + d.getFullYear() + z2(d.getMonth() + 1) + z2(d.getDate())
}

// 从子代理 result 提取纯文本与推理过程（容错：非 JSON / 解析失败时原样当作 text）
function extractBoth(raw) {
  let s = raw
  if (typeof raw !== 'string') s = JSON.stringify(raw)
  try {
    const obj = JSON.parse(s)
    if (obj && Array.isArray(obj.output)) {
      const texts = obj.output.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text)
      const reasons = obj.output.filter((b) => b && b.type === 'reasoning' && b.text).map((b) => b.text)
      if (texts.length) return { text: texts.join('\n'), reasoning: reasons.join('\n') }
    }
  } catch (e) { /* ignore */ }
  return { text: s, reasoning: '' }
}

// 从文本中收集完整绝对路径的 SVG 图表（E:/.../xxx.svg，去重、统一正斜杠）
function collectCharts(t) {
  const re = /E:[\\/][^\s"'<>]+?\.svg/gi
  const set = new Set()
  const m = String(t).match(re)
  if (m) m.forEach((x) => set.add(x.replace(/\\/g, '/')))
  return Array.from(set)
}

// 由角色简码数组构建分组：①选股∥②消息 并行 → ③深度 → ④总判断（缺失角色跳过）
// roleMap 形如 { '选股': {name, persona}, '消息': {...}, '深度': {...}, '总判断': {...} }
function buildGroups(roleCodes, roleMap) {
  const has = (c) => roleCodes.includes(c)
  const groups = []
  const a = []
  if (has('选股')) a.push(roleMap['选股'])
  if (has('消息')) a.push(roleMap['消息'])
  if (a.length) groups.push(a)
  if (has('深度')) groups.push([roleMap['深度']])
  if (has('总判断')) groups.push([roleMap['总判断']])
  return groups
}

// 仅允许 loopback + 同源浏览器访问（常规插件路由安全围栏）
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// 耗时格式化（毫秒 → 秒字符串，空值返回空串）
const fmt = (ms) => (ms === undefined || ms === null || ms === '') ? '' : (ms / 1000).toFixed(1) + 's'

// Markdown 表格分隔行判断（| --- | :---: | 等）
const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))

// 把 Markdown 文本拆成 text/table 块（| 开头的连续行视为表格，分隔行丢弃）
function splitBlocks(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let curText = []
  let curTable = []
  const flushText = () => { if (curText.length) { blocks.push({ kind: 'text', text: curText.join('\n') }); curText = [] } }
  const flushTable = () => { if (curTable.length) { blocks.push({ kind: 'table', rows: curTable }); curTable = [] } }
  for (const line of lines) {
    const t = line.trim()
    if (t.length > 2 && t.charAt(0) === '|' && t.charAt(t.length - 1) === '|') {
      const cells = t.slice(1, -1).split('|').map((c) => c.trim())
      if (isSepRow(cells)) continue
      flushText()
      curTable.push(cells)
    } else {
      flushTable()
      curText.push(line)
    }
  }
  flushText()
  flushTable()
  return blocks
}

// DSH 动态插件 Client 半部（invest_run 专属工具卡片：分阶段标签页 + 推理过程折叠 + 图表渲染/放大 + Markdown 表格）
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
      '.invr-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '.invr-tab{background:var(--dsw-alias-bg-hover, rgba(128,128,128,.14));border:1px solid transparent;border-radius:6px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9));cursor:pointer;user-select:none}',
      '.invr-tab:hover{border-color:var(--dsw-alias-border-l1, rgba(128,128,128,.4))}',
      '.invr-tab.active{background:var(--dsw-alias-bg-active, rgba(128,128,128,.24));color:var(--dsw-alias-label-primary, inherit);font-weight:600}',
      '.invr-tab.ok{color:var(--dsw-alias-state-success-primary, #2f9e44)}',
      '.invr-tab.fail{color:var(--dsw-alias-state-error-primary, #e03131)}',
      '.invr-charts{display:flex;flex-direction:column;gap:8px;margin-top:8px}',
      '.invr-chart{width:100%;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));border-radius:8px;background:#ffffff;cursor:zoom-in}',
      '.invr-charterr{color:var(--dsw-alias-state-error-primary, #e03131);font-size:12px}',
      '.invr-zoom{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;cursor:zoom-out}',
      '.invr-zoomimg{max-width:94vw;max-height:90vh;background:#ffffff;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.4)}',
      '.invr-table{border-collapse:collapse;width:100%;margin:6px 0;font-size:12px}',
      '.invr-table th,.invr-table td{border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));padding:3px 8px;text-align:left}',
      '.invr-table th{background:var(--dsw-alias-bg-hover, rgba(128,128,128,.12));font-weight:600}',
      '.invr-text{white-space:pre-wrap;margin:6px 0}',
      '.invr-reason{margin-top:8px;border:1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.35));border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-base, transparent)}',
      '.invr-reason summary{cursor:pointer;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9));font-size:12px;user-select:none}',
      '.invr-stagehead{font-weight:600;margin:8px 0 2px;color:var(--dsw-alias-label-primary, inherit)}',
    ].join('\n')))
    const fmt = (ms) => (ms === undefined || ms === null || ms === '') ? '' : (ms / 1000).toFixed(1) + 's'
    const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
    // 把 Markdown 文本拆成 text/table 块（| 开头的连续行视为表格）
    function splitBlocks(text) {
      const lines = String(text).split('\n')
      const blocks = []
      let curText = []
      let curTable = []
      const flushText = () => { if (curText.length) { blocks.push({ kind: 'text', text: curText.join('\n') }); curText = [] } }
      const flushTable = () => { if (curTable.length) { blocks.push({ kind: 'table', rows: curTable }); curTable = [] } }
      for (const line of lines) {
        const t = line.trim()
        if (t.length > 2 && t.charAt(0) === '|' && t.charAt(t.length - 1) === '|') {
          const cells = t.slice(1, -1).split('|').map((c) => c.trim())
          if (isSepRow(cells)) continue
          flushText()
          curTable.push(cells)
        } else {
          flushTable()
          curText.push(line)
        }
      }
      flushText()
      flushTable()
      return blocks
    }
    function TableView(props) {
      const rows = props.rows
      const header = rows[0]
      const body = rows.slice(1)
      const ths = header.map((c, i) => React.createElement('th', { key: i }, c))
      const trs = body.map((r, i) => React.createElement('tr', { key: i }, r.map((c, j) => React.createElement('td', { key: j }, c))))
      return React.createElement('table', { className: 'invr-table' },
        React.createElement('thead', null, React.createElement('tr', null, ths)),
        React.createElement('tbody', null, trs))
    }
    function StageBody(props) {
      const text = props.text
      const reasoning = props.reasoning
      const blocks = text ? splitBlocks(text).map((b, i) => b.kind === 'table'
        ? React.createElement(TableView, { key: i, rows: b.rows })
        : React.createElement('div', { key: i, className: 'invr-text' }, b.text)) : []
      const reasonNode = (reasoning && reasoning.trim())
        ? React.createElement('details', { className: 'invr-reason' },
            React.createElement('summary', null, '💭 推理过程（思考内容，' + String(reasoning.length) + ' 字符）'),
            React.createElement('div', { className: 'invr-text' }, reasoning))
        : null
      return React.createElement('div', null, blocks, reasonNode)
    }
    function Card(props) {
      const block = props.block
      const [open, setOpen] = React.useState(false)
      const [charts, setCharts] = React.useState([])
      const [prog, setProg] = React.useState(null)
      const [zoomIdx, setZoomIdx] = React.useState(-1)
      const [stageIdx, setStageIdx] = React.useState(0)
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
      // 分节优先 meta.stages（阶段名/顺序/文本来自 tool-private 完整报告，可信）；
      // 旧调用无 meta 时回退到 render 文本按 === 阶段名 === 分界切分
      const sections = []
      if (stages.length) {
        for (let i = 0; i < stages.length; i++) {
          const st = stages[i]
          if (st && typeof st.stage === 'string') sections.push({ key: st.stage, text: (typeof st.text === 'string' && st.text) ? st.text : '' })
        }
      }
      if (!sections.length) {
        const re = /=== ([^=\n]+?) ｜ [^=]*? ===\n/g
        let m
        let lastIdx = -1
        let lastKey = null
        const raw = bodyText
        while ((m = re.exec(raw)) !== null) {
          if (lastKey !== null) sections.push({ key: lastKey, text: raw.slice(lastIdx, m.index) })
          lastKey = m[1]
          lastIdx = m.index + m[0].length
        }
        if (lastKey !== null) sections.push({ key: lastKey, text: raw.slice(lastIdx) })
      }
      const chartNodes = charts.map((c, i) => React.createElement('div', { key: i },
        c.svg !== null ? React.createElement('img', { className: 'invr-chart', alt: c.path, src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(c.svg), onClick: () => setZoomIdx(i) })
          : c.err !== null ? React.createElement('div', { className: 'invr-charterr' }, '图表加载失败：' + c.err)
            : React.createElement('div', { className: 'invr-hint' }, '图表加载中…')))
      const safeIdx = sections.length > 0 ? Math.min(Math.max(stageIdx, 0), sections.length - 1) : 0
      const tabs = sections.map((s, i) => {
        const st = stages[i]
        const cls = 'invr-tab ' + (i === safeIdx ? 'active' : '') + (st ? (st.ok ? ' ok' : ' fail') : '')
        return React.createElement('span', { key: i, className: cls, onClick: () => setStageIdx(i) },
          (i + 1) + '. ' + s.key + (st ? ' · ' + fmt(st.elapsedMs) : ''))
      })
      const curSection = sections[safeIdx]
      // 优先使用 meta 携带的完整报告文本（tool-private，不进模型 token）；旧调用回退到 render 文本
      const metaText = stages[safeIdx] && typeof stages[safeIdx].text === 'string' && stages[safeIdx].text ? stages[safeIdx].text : ''
      const curText = metaText || (curSection ? curSection.text : '')
      const curReasoning = stages[safeIdx] && typeof stages[safeIdx].reasoning === 'string' ? stages[safeIdx].reasoning : ''
      if (!isDone) {
        let runMode = ''
        try {
          const a = JSON.parse(block.argsRaw || '{}')
          if (a && typeof a.mode === 'string') runMode = a.mode
        } catch (e) { /* ignore */ }
        const doneList = (prog && Array.isArray(prog.done)) ? prog.done : []
        const doneBadges = doneList.map((d, i) => React.createElement('span', { key: 'd' + i, className: 'invr-tab ok' },
          d.stage + ' · ' + fmt(d.ms)))
        const line = (prog && typeof prog.total === 'number' && prog.total > 0)
          ? '进行中 ' + prog.index + '/' + prog.total + '：' + prog.stage
          : '子代理启动中…'
        return React.createElement('div', { className: 'invr-card' },
          React.createElement('div', { className: 'invr-head' },
            React.createElement('span', { className: 'invr-title' }, 'invest_run 投研流水线' + (runMode ? ' · ' + runMode : '')),
            React.createElement('span', { className: 'invr-hint' }, line)),
          doneBadges.length ? React.createElement('div', { className: 'invr-tabs' }, doneBadges) : null)
      }
      return React.createElement('div', { className: 'invr-card' },
        React.createElement('div', { className: 'invr-head', onClick: () => setOpen((o) => !o) },
          React.createElement('span', { className: 'invr-title' }, '投研流水线 · ' + modeText + '（' + sections.length + ' 个阶段，点击标签查看每个 Agent 输出）'),
          React.createElement('span', { className: 'invr-hint' }, open ? '收起' : '展开')),
        tabs.length ? React.createElement('div', { className: 'invr-tabs' }, tabs) : null,
        open ? React.createElement('div', null,
          charts.length ? React.createElement('div', { className: 'invr-charts' }, chartNodes) : null,
          curSection ? React.createElement('div', null,
            React.createElement('div', { className: 'invr-stagehead' }, '【' + curSection.key + '】完整报告'),
            React.createElement(StageBody, { text: curText, reasoning: curReasoning })) : null) : null,
        zoomIdx >= 0 && charts[zoomIdx] && charts[zoomIdx].svg !== null ? React.createElement('div', { className: 'invr-zoom', onClick: () => setZoomIdx(-1) },
          React.createElement('img', { className: 'invr-zoomimg', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(charts[zoomIdx].svg), alt: charts[zoomIdx].path })) : null)
    }
    slots.inject('tool.call.toolview', () => slots.register(
      { name: 'tool.call.toolview', key: 'invest_run' },
      (props) => React.createElement(Card, props),
    ))
  },
}

