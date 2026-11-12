// 插件版本号（构建期注入）
//
// 唯一事实来源是 packages/dsh-invest/package.json；vite.config.ts 在构建时把它注入为
// __APP_VERSION__，前端任何地方都不硬编码版本字符串（test/version-sync.test.js 会校验一致性）。
// 未经 vite 构建直接运行源码时变量不存在，退化为 dev，避免 ReferenceError。

declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
