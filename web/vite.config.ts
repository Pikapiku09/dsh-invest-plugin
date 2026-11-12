import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// 前端产物必须落到「运行目录」而不是仓库里：插件从 <BASE_DIR>/.dsh-invest/web/dist 实时读取
// （no-store，刷新即生效）。BASE_DIR 默认是仓库所在工作区，可用 DSH_INVEST_BASE_DIR / DSH_INVEST_WEB_DIST 覆盖。
const BASE_DIR = process.env.DSH_INVEST_BASE_DIR || resolve(__dirname, '../..');
const OUT_DIR = process.env.DSH_INVEST_WEB_DIST || resolve(BASE_DIR, '.dsh-invest/web/dist');

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
