// 源码指纹工具（2026-11-25）
//
// 起因：CI 在 v0.79.0 假红过一次——「前端产物与前端源码是否同步」用 mtime 判断，
// 而全新 clone 时所有文件的写入时间几乎一样，谁比谁「新」全看遍历顺序。
// 改成内容指纹后，这里把它的边界钉死：换行符、目录顺序、平台差异都不许影响结果，
// 只有源码内容真的变了，指纹才允许变。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sourceHash, listSources } = require('../tools/source-hash.js');

/** 建一个临时目录，按 { 相对路径: 内容 } 落盘 */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-src-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

test('源码指纹：同一份源码永远算出同一个值', () => {
  const a = fixture({ 'main.ts': 'export const a = 1;\n', 'dao.css': '.a { color: red }\n' });
  const b = fixture({ 'main.ts': 'export const a = 1;\n', 'dao.css': '.a { color: red }\n' });
  try {
    assert.equal(sourceHash(a).hash, sourceHash(b).hash);
    assert.equal(sourceHash(a).files, 2);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('源码指纹：CRLF 与 LF 必须算成同一个值（CI 假红的根因之一）', () => {
  // 仓库 core.autocrlf=true：Windows 检出是 CRLF，GitHub Actions 是 LF。
  // 不做换行归一化，两边指纹永远对不上。
  const crlf = fixture({ 'main.ts': 'line one\r\nline two\r\n' });
  const lf = fixture({ 'main.ts': 'line one\nline two\n' });
  try {
    assert.equal(sourceHash(crlf).hash, sourceHash(lf).hash);
  } finally {
    fs.rmSync(crlf, { recursive: true, force: true });
    fs.rmSync(lf, { recursive: true, force: true });
  }
});

test('源码指纹：内容变了、文件改名了、加了文件，都要变', () => {
  const base = fixture({ 'main.ts': 'export const a = 1;\n' });
  const changed = fixture({ 'main.ts': 'export const a = 2;\n' });
  const renamed = fixture({ 'index.ts': 'export const a = 1;\n' });
  const added = fixture({ 'main.ts': 'export const a = 1;\n', 'extra.ts': '' });
  try {
    const origin = sourceHash(base).hash;
    assert.notEqual(sourceHash(changed).hash, origin, '改了内容必须变');
    assert.notEqual(sourceHash(renamed).hash, origin, '路径也参与指纹，改名必须变');
    assert.notEqual(sourceHash(added).hash, origin, '多一个文件必须变');
  } finally {
    for (const dir of [base, changed, renamed, added]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('源码指纹：文件列表按路径排序、用正斜杠（跨平台同一结果）', () => {
  const dir = fixture({ 'b/z.ts': '', 'a.ts': '', 'a/y.css': '' });
  try {
    assert.deepEqual(listSources(dir), ['a.ts', 'a/y.css', 'b/z.ts']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('构建清单存在时，指纹必须和当前源码一致（改了前端要重建）', () => {
  const root = path.join(__dirname, '..');
  const manifestPath = path.join(root, 'packages', 'dsh-invest', 'web-dist', 'build-manifest.json');
  if (!fs.existsSync(manifestPath)) return; // 新克隆没构建过，跳过
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(manifest.sourceHash, 'build-manifest.json 缺 sourceHash');
  assert.equal(
    sourceHash(path.join(root, 'web', 'src')).hash,
    manifest.sourceHash,
    '前端源码和产物对不上：cd web && npm run build',
  );
});
