import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// 前端产物落到「包内」packages/dsh-invest/web-dist/：
// 别人 clone 或从 npm 安装后，Host 端直接读包内产物即可出界面，不必再装 vite/Node 依赖。
// （Host 端解析顺序：DSH_INVEST_WEB_DIST → 包内 web-dist → 工作区 .dsh-invest/web/dist 兼容旧装）
// 开发期若想输出到别处：DSH_INVEST_WEB_DIST=<dir>。
const PKG_DIR = resolve(__dirname, '../packages/dsh-invest');
const OUT_DIR = process.env.DSH_INVEST_WEB_DIST || resolve(PKG_DIR, 'web-dist');

// 版本号唯一事实来源 = packages/dsh-invest/package.json（test/version-sync.test.js 保证各处一致）。
// 构建时注入为 __APP_VERSION__，界面上只负责显示，不在前端硬编码任何版本字符串。
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../packages/dsh-invest/package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'dev';
  } catch {
    return 'dev';
  }
})();

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: '/dsh-invest/',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'workbench.js',
        chunkFileNames: 'workbench.js',
        inlineDynamicImports: true,
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith('.css') ? 'workbench.css' : '[name][extname]',
      },
    },
  },
});
