// 工作台静态服务路径校验测试（v0.21.0）
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isSafeServePath } = require('../src/lib/pure.js')

test('isSafeServePath：根目录内的合法路径放行', () => {
  assert.equal(isSafeServePath('E:/w/.dsh-invest/reports/20261104_x.md', 'E:/w/.dsh-invest/reports'), true)
  assert.equal(isSafeServePath('E:/w/invest-outputs/20261104_x/报告.md', 'E:/w/invest-outputs'), true)
})

test('isSafeServePath：目录穿越 / 根外 / 空值一律拒绝', () => {
  assert.equal(isSafeServePath('E:/w/.dsh-invest/reports/../持仓.json', 'E:/w/.dsh-invest/reports'), false)
  assert.equal(isSafeServePath('E:/other/evil.md', 'E:/w/.dsh-invest/reports'), false)
  assert.equal(isSafeServePath('', 'E:/w/.dsh-invest/reports'), false)
  assert.equal(isSafeServePath(undefined, 'E:/w/.dsh-invest/reports'), false)
})
