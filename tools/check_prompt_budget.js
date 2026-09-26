// 提示词长度预算检查：单角色 >8000 字（硬限 10000）警告/失败
// 用法：node tools/check_prompt_budget.js（CI 或 build 后手动跑）
const prompts = require('../src/prompts.js')

const BUDGET_WARN = 8000, BUDGET_FAIL = 10000
const roles = ['P_SELECT', 'P_NEWS', 'P_DEEP', 'P_FINAL']

let bad = 0
console.log('角色        字数    状态')
for (const r of roles) {
  const n = prompts[r].length
  const s = n > BUDGET_FAIL ? 'FAIL' : n > BUDGET_WARN ? 'WARN' : 'OK'
  if (s !== 'OK') bad++
  console.log(r.padEnd(10), String(n).padStart(6), s)
}
// KB 模块单模块上限 700
for (const k of ['KB_PSY', 'KB_VERIFIED']) {
  const n = prompts[k].length
  const s = n > 700 ? 'WARN(>700)' : 'OK'
  if (n > 700) bad++
  console.log(k.padEnd(10), String(n).padStart(6), s)
}
if (bad > 0) { console.error(`\n${bad} 项超预算——按 docs 提示词预算规则处理（新条目1进1出/压缩旧条目）`); process.exit(1) }
console.log('\n全部在预算内')
