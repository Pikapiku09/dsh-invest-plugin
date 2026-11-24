// 「悟道」条目库纯逻辑（v0.78.0）
//
// 这些规则看起来琐碎，但每一条都会影响模型：标签选错 → 纪律注入到不相干的角色；
// 预算写错 → prompt 被几条长文占满；排序写错 → 置顶的纪律排在新条后面没人看。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DAO_MAX_ITEMS, DAO_ITEM_IN_BLOCK_CHARS,
  normalizeDaoStore, sanitizeDaoItem, upsertDaoItem, deleteDaoItem,
  selectDaoEntries, buildDaoBlock, buildDaoBlocks, daoStats,
  buildCoachPrompt, buildDistillPrompt, parseDistillJson, draftFromText,
} from '../packages/dsh-invest/lib/dao.js'

const T1 = '2026-11-20T01:00:00.000Z'
const T2 = '2026-11-22T01:00:00.000Z'
const T3 = '2026-11-24T01:00:00.000Z'

const entry = (over) => Object.assign({
  title: '财报前不开新仓',
  body: '季报前一周不新开仓，等业绩落地再说。',
  kind: '纪律',
  tags: ['深度'],
  pinned: false,
}, over)

test('空值与坏结构归一化后是空库，不抛', () => {
  for (const bad of [null, undefined, {}, { items: 'nope' }, { items: [null, 3, 'x'] }]) {
    const store = normalizeDaoStore(bad)
    assert.equal(store.version, 1)
    assert.deepEqual(store.items, [])
  }
})

test('脏条目被丢弃，能救的字段被修正', () => {
  const store = normalizeDaoStore({
    items: [
      { id: 'a', body: '', title: '没有正文' },
      entry({ id: 'b', tags: ['深度', '深度', '火星', '通用'], kind: '瞎写' }),
      entry({ id: 'b', title: '重复 id 的第二条' }),
      entry({ id: 'c', created_at: T1, updated_at: T2 }),
    ],
  })
  const ids = store.items.map((item) => item.id)
  assert.deepEqual(ids.sort(), ['b', 'c'])
  const b = store.items.find((item) => item.id === 'b')
  assert.deepEqual(b.tags, ['通用'], '通用收敛成单标签')
  assert.equal(b.kind, '心得', '非法类型回落心得')
  const c = store.items.find((item) => item.id === 'c')
  assert.equal(c.created_at, T1, '归一化不得刷新已有时间')
  assert.equal(c.updated_at, T2)
})

test('缺正文拒绝入库，标题空则取正文前 20 字', () => {
  assert.throws(() => sanitizeDaoItem({ body: '   ' }), /正文不能为空/)
  const item = sanitizeDaoItem({ body: 'a'.repeat(40) })
  assert.equal(item.title, 'a'.repeat(20))
  assert.equal(item.kind, '心得')
  assert.deepEqual(item.tags, [])
  assert.equal(item.source, 'manual')
})

test('新增与更新：id 复用、created_at 保留、updated_at 刷新、置顶排最前', () => {
  const created = upsertDaoItem(null, entry({ pinned: true }), T1)
  assert.equal(created.item.created_at, T1)
  assert.equal(created.item.updated_at, T1)
  const second = upsertDaoItem(created.store, entry({ title: '每日复盘' }), T2)
  assert.equal(second.store.items.length, 2)
  assert.equal(second.store.items[0].id, created.item.id, '置顶条目排第一')

  const updated = upsertDaoItem(second.store, entry({ id: created.item.id, title: '财报前不开新仓（改）' }), T3)
  const item = updated.store.items.find((one) => one.id === created.item.id)
  assert.equal(item.title, '财报前不开新仓（改）')
  assert.equal(item.created_at, T1, 'created_at 不被覆盖')
  assert.equal(item.updated_at, T3)
  assert.equal(updated.store.items.length, 2)
  assert.equal(updated.store.updated_at, T3)
})

test('更新不存在的 id 要报错，避免前端把已删条目写回来', () => {
  assert.throws(() => upsertDaoItem(null, entry({ id: 'dao_ghost' }), T1), /不存在或已被删除/)
})

test('条目数有上限', () => {
  let store = null
  for (let i = 0; i < DAO_MAX_ITEMS; i += 1) {
    store = upsertDaoItem(store, entry({ title: '第 ' + i + ' 条' }), T1).store
  }
  assert.equal(store.items.length, DAO_MAX_ITEMS)
  assert.throws(() => upsertDaoItem(store, entry({ title: '溢出' }), T2), /上限/)
})

test('删除：命中计 1，未命中计 0', () => {
  const made = upsertDaoItem(null, entry({}), T1)
  const gone = deleteDaoItem(made.store, made.item.id)
  assert.equal(gone.removed, 1)
  assert.equal(gone.store.items.length, 0)
  assert.equal(deleteDaoItem(gone.store, 'dao_ghost').removed, 0)
})

test('按角色挑选：通用与空标签对所有角色生效，专属标签只给对应角色', () => {
  let store = null
  store = upsertDaoItem(store, entry({ title: '通用条', tags: [] }), T1).store
  store = upsertDaoItem(store, entry({ title: '通用标签条', tags: ['通用'] }), T1).store
  store = upsertDaoItem(store, entry({ title: '深度条', tags: ['深度'] }), T2).store
  store = upsertDaoItem(store, entry({ title: '选股条', tags: ['选股'] }), T3).store

  const deep = selectDaoEntries(store, '深度').map((item) => item.title)
  assert.deepEqual(deep.sort(), ['深度条', '通用条', '通用标签条'].sort())
  const news = selectDaoEntries(store, '消息').map((item) => item.title)
  assert.deepEqual(news.sort(), ['通用条', '通用标签条'].sort())
})

test('挑选：置顶优先，其次最近更新；条数与字数双封顶且第一条必收', () => {
  let store = null
  store = upsertDaoItem(store, entry({ title: '新条', tags: [], body: '正文' }), T3).store
  store = upsertDaoItem(store, entry({ title: '置顶旧条', tags: [], pinned: true }), T1).store
  const picked = selectDaoEntries(store, '深度').map((item) => item.title)
  assert.equal(picked[0], '置顶旧条')

  const huge = entry({ title: '超长', tags: [], body: '字'.repeat(4000) })
  const one = upsertDaoItem(null, huge, T1).store
  const tight = selectDaoEntries(one, '深度', { maxChars: 50 })
  assert.equal(tight.length, 1, '第一条即使超预算也收，避免空块')

  let many = null
  for (let i = 0; i < 12; i += 1) {
    many = upsertDaoItem(many, entry({ title: '条目' + i, tags: [] }), T1).store
  }
  assert.equal(selectDaoEntries(many, '深度').length, 8, '默认最多 8 条')
  assert.equal(selectDaoEntries(many, '深度', { maxItems: 3 }).length, 3)
})

test('注入块：空条目不产生块；非空包含角色、条数、置顶标记与日期', () => {
  assert.equal(buildDaoBlock([], '深度'), '')
  assert.equal(buildDaoBlock(null, '深度'), '')

  const store = upsertDaoItem(null, entry({
    title: '财报前不开新仓', body: '季报前一周不新开仓。\n\n等落地再说。', pinned: true, tags: ['深度'],
  }), '2026-11-20T10:00:00.000Z').store
  const block = buildDaoBlock(selectDaoEntries(store, '深度'), '深度')
  assert.match(block, /我的悟道·交易纪律/)
  assert.match(block, /命中角色「深度」，共 1 条/)
  assert.match(block, /\[纪律·置顶\] 财报前不开新仓/)
  assert.match(block, /2026-11-20/, '按本地日期展示')
  assert.match(block, /以数据为准/, '冲突处理条款必须在')
  assert.ok(!block.includes('\n\n\n'), '正文换行被压成空格')
})

test('注入块正文摘要截断到 160 字，长文不挤占预算', () => {
  const store = upsertDaoItem(null, entry({ body: '甲'.repeat(200), tags: [] }), T1).store
  const block = buildDaoBlock(selectDaoEntries(store, '深度'), '深度')
  const line = block.split('\n').find((one) => one.trim().startsWith('甲'))
  assert.equal(line.trim().length, DAO_ITEM_IN_BLOCK_CHARS)
  assert.ok(!block.includes('甲'.repeat(170)))
})

test('统计：总数、置顶数、按角色与类型计数（空标签算通用）', () => {
  let store = null
  store = upsertDaoItem(store, entry({ tags: [], pinned: true, kind: '反思' }), T1).store
  store = upsertDaoItem(store, entry({ tags: ['通用', '深度'] }), T1).store
  store = upsertDaoItem(store, entry({ tags: ['深度', '选股'], kind: '复盘' }), T2).store
  const stats = daoStats(store)
  assert.equal(stats.total, 3)
  assert.equal(stats.pinned, 1)
  // 「通用 + 深度」在归一化时收敛成只剩通用：通用本就覆盖所有角色，留着专属标签只会让统计重复计数
  assert.equal(stats.byRole['通用'], 2)
  assert.equal(stats.byRole['深度'], 1)
  assert.equal(stats.byRole['选股'], 1)
  assert.equal(stats.byKind['反思'], 1)
  assert.equal(stats.byKind['复盘'], 1)
})

test('按角色批量拼块：只给本次运行的角色，未命中角色的块为空串', () => {
  let store = null
  store = upsertDaoItem(store, entry({ title: '通用纪律', tags: [] }), T1).store
  store = upsertDaoItem(store, entry({ title: '深度专属', tags: ['深度'] }), T2).store
  const { blocks, counts } = buildDaoBlocks(store, ['选股', '深度'])
  assert.equal(counts['选股'], 1)
  assert.equal(counts['深度'], 2)
  assert.match(blocks['深度'], /深度专属/)
  assert.ok(!blocks['选股'].includes('深度专属'))
  assert.equal(blocks['消息'], undefined, '未参与本次运行的角色不拼块')
})

test('教练提示词：身份、条目、历史、问题齐全；空历史不留空标题', () => {
  const store = upsertDaoItem(null, entry({ tags: [], body: '不要追高' }), T1).store
  const entries = selectDaoEntries(store, '深度')
  const prompt = buildCoachPrompt({ personaName: '悟道教练', entries, messages: [{ role: 'user', text: '我昨天又追高了' }], question: '怎么改' })
  assert.match(prompt, /「悟道」交易教练/)
  assert.match(prompt, /我的悟道条目/)
  assert.match(prompt, /对话历史/)
  assert.match(prompt, /我：我昨天又追高了/)
  assert.match(prompt, /本轮问题】怎么改/)
  assert.match(prompt, /不编造行情/)

  const lean = buildCoachPrompt({ personaName: '深度分析师', entries: [], messages: [], question: '聊聊仓位' })
  assert.match(lean, /深度/)
  assert.ok(!lean.includes('【我的悟道条目'), '无条目时不留空标题')
  assert.ok(!lean.includes('【对话历史】'), '无历史时不留空标题')
})

test('沉淀提示词：要求只回 JSON 并限定标签', () => {
  const prompt = buildDistillPrompt({ personaName: '总判断', messages: [{ role: 'assistant', text: '仓位别一次打满' }] })
  assert.match(prompt, /只输出 JSON/)
  assert.match(prompt, /来源人格：总判断/)
  assert.match(prompt, /选股\/消息\/深度\/总判断\/波段\/通用/)
})

test('解析沉淀 JSON：容忍前后废话与代码块，非法字段回落', () => {
  const wrapped = '好的，这是结果：\n```json\n{"title":"财报前不开仓","body":"季报前一周不新开仓。","kind":"纪律","tags":["深度","火星"]}\n```\n以上。'
  const draft = parseDistillJson(wrapped)
  assert.equal(draft.title, '财报前不开仓')
  assert.equal(draft.kind, '纪律')
  assert.deepEqual(draft.tags, ['深度'])

  const weird = parseDistillJson('{"title":"x","body":"y","kind":"乱写","tags":"深度"}')
  assert.equal(weird.kind, '心得')
  assert.deepEqual(weird.tags, [])

  assert.equal(parseDistillJson('模型今天不想输出 JSON'), null)
  assert.equal(parseDistillJson(''), null)
  assert.equal(parseDistillJson('{坏 json}'), null)
})

test('模型输出不可解析时的兜底草稿：首行做标题，全文做正文', () => {
  const draft = draftFromText('## 不要追高\n\n追高的本质是怕错过。\n')
  assert.equal(draft.title, '不要追高')
  assert.equal(draft.kind, '心得')
  assert.match(draft.body, /追高的本质/)
  assert.equal(draftFromText('   '), null)
})
