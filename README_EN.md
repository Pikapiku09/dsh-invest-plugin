# dsh-invest-plugin

A multi-agent A-share research pipeline plugin for DeepSeek Harness: the **invest_run** tool runs a 4-role analyst team (stock screener / market-news scout / deep-dive analyst / chief strategist) with real-time Tushare data, triple-layer caching, SVG chart rendering, and archived reports.

## Features

- **invest_run tool** — modes: single-stock deep dive / market screening / news scan / full pipeline; preset model routing per role (inherit / budget / balanced / deepseek-only / quality) plus per-role overrides via `routes.json` or call-time `routes` parameter
- **4 analyst roles** — each with its own knowledge module distilled from 3 classic trading books + evidence-backed verified rules (KB_VERIFIED) fed back from LihuQuantify backtests
- **GUI tool card** — staged tabs, reasoning trace, inline SVG charts
- **Hot-pluggable** — mounted via profile package.json bundles + dsh.bundle.patch, no DSH source changes

## Install

From the DSH plugin market (dshmarket) once listed, or manually from this repository — see the Chinese README for the full manual installation walkthrough (peer-link script + profile patch).

## Model routing

Default: all roles inherit the host session model. Override per role in `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/routes.json`:

```json
{
  "选股": "deepseek-official/deepseek-flash@low",
  "消息": "inherit",
  "深度": "deepseek-official/deepseek-v4-pro@high",
  "总判断": "zai-coding-cn/glm-5.3@max|deepseek-official/deepseek-v4-pro@max"
}
```

Format: `provider/model@reasoningEffort`; use `|` for fallback chains; `inherit` = follow host. Priority: preset < plugin config < routes.json < env < per-call parameter.

## Requirements

- Tushare Pro token (set via `{{BASE_DIR}}`-resolved token file or environment)
- DSH runtime >= 0.1.6 (peerDependencies)

## License

MIT
