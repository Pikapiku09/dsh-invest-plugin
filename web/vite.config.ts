import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// 前端产物必须落到「运行目录」而不是仓库里：插件从 <BASE_DIR>/.dsh-invest/web/dist 实时读取
// （no-store，刷新即生效）。BASE_DIR 默认是仓库所在工作区，可用 DSH_INVEST_BASE_DIR / DSH_INVEST_WEB_DIST 覆盖。
const BASE_DIR = process.env.DSH_INVEST_BASE_DIR || resolve(__dirname, '../..');
const OUT_DIR = process.env.DSH_INVEST_WEB_DIST || resolve(BASE_DIR, '.dsh-invest/web/dist');

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: '/dsh-invest/',
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
