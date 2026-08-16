// 构建脚本：把 src/ 模块合并为 dist/ 完整函数体（可直接粘贴到 cordis_define 的 code.host / code.client）
// 用法：node tools/build.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const prompts = require(path.join(root, 'src', 'prompts.js'))

const banner = '// 本文件由 tools/build.js 自动生成（node tools/build.js），请勿手动修改\n// 用法：将本文件内容作为 cordis_define 的 code.host 函数体\n// 生成时间：' + new Date().toISOString() + '\n'

const hostBody = banner + '\nconst PROMPTS = ' + JSON.stringify(prompts, null, 2) + ';\n\n' +
  fs.readFileSync(path.join(root, 'src', 'host.js'), 'utf8') + '\n'
fs.writeFileSync(path.join(root, 'dist', 'invest-run.host.js'), hostBody)

const clientBanner = banner.replace('code.host', 'code.client')
const clientBody = clientBanner + '\n' +
  fs.readFileSync(path.join(root, 'src', 'client.js'), 'utf8') + '\n'
fs.writeFileSync(path.join(root, 'dist', 'invest-run.client.js'), clientBody)

console.log('build ok -> dist/invest-run.host.js, dist/invest-run.client.js')
