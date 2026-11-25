// 前端源码指纹（2026-11-25）
//
// 为什么用哈希而不是比 mtime：CI 是全新 clone，git 会把所有文件写成同一时刻，
// 谁比谁「新」完全取决于文件系统的遍历顺序。v0.79.0 的 CI 就这样假红过一次——
// 本地明明重建过，云端却报「web/src/api.ts 比产物新，需要重新构建」。
//
// 这里把 web/src 下所有文件按相对路径排序后连内容一起做 sha256：
// 同样一份源码永远得到同一个值，和检出时间、操作系统、换行符策略都无关。
// 构建时由 tools/stamp-web-build.js 写进 web-dist/build-manifest.json，
// 测试再算一遍比对——源码改过没重建，就会对不上。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 递归列出目录下所有文件，返回按字典序排好的 posix 相对路径 */
function listSources(dir) {
  const base = path.resolve(dir);
  const out = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile()) continue;
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
}

/** 目录内容的 sha256：路径 + 分隔符 + 字节，顺序固定，可复现 */
function sourceHash(dir) {
  const base = path.resolve(dir);
  const files = listSources(base);
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    // 统一换行再入账：仓库 core.autocrlf=true，Windows 检出是 CRLF、CI 是 LF。
    // 不做这一步，同一份源码在两边会算出两个指纹，CI 又假红一次。
    // latin1 是字节级 1:1 映射，除 CRLF→LF 外不改动任何字节（webp 也安全）。
    const text = fs.readFileSync(path.join(base, rel)).toString('latin1').replace(/\r\n/g, '\n');
    hash.update(Buffer.from(text, 'latin1'));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), files: files.length, paths: files };
}

module.exports = { sourceHash, listSources };
