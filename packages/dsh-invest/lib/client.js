// dsh-invest Client 半部：invest_run 专属工具卡片（分阶段标签 + 推理折叠 + SVG 图表内联/放大）
// 注册方式与 @linxin666/dsh-ssh 一致：window.__ModuleLoader__.load({ id, factory })
// factory 内用 require() 取依赖（react），CJS 导出 { name, inject, apply }
// 与 Host 的通信走 /api/dsh-invest/* 路由（浏览器 fetch）

window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 完全一致，也必须与 cordis.patch.yml 的 Loader 行名一致：
  // dsh-client-modules 的 resolveMeta() 用「行名」推出期望包名，nearestPackage() 要求
  // 找到的 package.json 的 name 严格等于它，否则判为「不是客户端包」，dsh.client 根本不被扫描。
  // 历史坑：行名 dsh-invest / 包名 @pikapiku09/dsh-invest / bundle id dsh-invest 三者不一致，
  // 导致客户端半部（工具卡片 + 侧栏入口）从未加载。v0.49.2 起三者统一为 dsh-invest。
  id: "dsh-invest",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");

    const name = "invest";

    const inject = ["slots", "timer"];

    /** 卡片样式（浏览器环境注入 <style>） */
    const CARD_CSS = [
      ".invr-card{background:var(--dsw-alias-bg-subtle, rgba(128,128,128,.06));border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));border-radius:10px;padding:10px 12px;margin:2px 0;font-size:13px;line-height:1.5}",
      ".invr-head{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}",
      ".invr-title{font-weight:600;color:var(--dsw-alias-label-primary, inherit)}",
      ".invr-hint{color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9));font-size:12px}",
      ".invr-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}",
      ".invr-tab{background:var(--dsw-alias-bg-hover, rgba(128,128,128,.14));border:1px solid transparent;border-radius:6px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9));cursor:pointer;user-select:none}",
      ".invr-tab:hover{border-color:var(--dsw-alias-border-l1, rgba(128,128,128,.4))}",
      ".invr-tab.active{background:var(--dsw-alias-bg-active, rgba(128,128,128,.24));color:var(--dsw-alias-label-primary, inherit);font-weight:600}",
      ".invr-tab.ok{color:var(--dsw-alias-state-success-primary, #2f9e44)}",
      ".invr-tab.fail{color:var(--dsw-alias-state-error-primary, #e03131)}",
      ".invr-charts{display:flex;flex-direction:column;gap:8px;margin-top:8px}",
      ".invr-chart{width:100%;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));border-radius:8px;background:#ffffff;cursor:zoom-in}",
      ".invr-charterr{color:var(--dsw-alias-state-error-primary, #e03131);font-size:12px}",
      ".invr-zoom{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;cursor:zoom-out}",
      ".invr-zoomimg{max-width:94vw;max-height:90vh;background:#ffffff;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.4)}",
      ".invr-table{border-collapse:collapse;width:100%;margin:6px 0;font-size:12px}",
      ".invr-table th,.invr-table td{border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));padding:3px 8px;text-align:left}",
      ".invr-table th{background:var(--dsw-alias-bg-hover, rgba(128,128,128,.12));font-weight:600}",
      ".invr-text{white-space:pre-wrap;margin:6px 0}",
      ".invr-reason{margin-top:8px;border:1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.35));border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-base, transparent)}",
      ".invr-reason summary{cursor:pointer;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9));font-size:12px;user-select:none}",
      ".invr-stagehead{font-weight:600;margin:8px 0 2px;color:var(--dsw-alias-label-primary, inherit)}",
      // 投研工作台内嵌面板（v0.49.0）
      ".invr-wb{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base, transparent)}",
      ".invr-wb-bar{display:flex;align-items:center;gap:10px;padding:6px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))}",
      ".invr-wb-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary, inherit)}",
      ".invr-wb-hint{font-size:12px;margin-right:auto;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9))}",
      ".invr-wb-btn{font-size:12px;padding:2px 10px;cursor:pointer;border-radius:6px;color:var(--dsw-alias-label-secondary, inherit);background:var(--dsw-alias-bg-hover, rgba(128,128,128,.14));border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))}",
      ".invr-wb-btn:hover{background:var(--dsw-alias-bg-active, rgba(128,128,128,.24))}",
      ".invr-wb-frame{flex:1 1 auto;width:100%;min-height:0;border:0;background:transparent}",
    ].join("\n");

    // ===== 投研工作台面板（v0.49.0）：把工作台内嵌进 DSH 主面板 =====
    // DSH 原生机制（dsh-client-ui-sidebar / -layout 的 slot 契约）：
    //   ① sidebar.panellist（list, root）注册左侧图标入口，id 即主面板 key；
    //   ② main（keyed, root）用同一个 key 注册主面板组件。
    // 点左侧图标即把主面板切成工作台，不必再手输端口号。
    // 缺这两个 seat 的旧版 DSH 上静默跳过，不影响工具卡片。
    const WB_PANEL_ID = "invest-workbench";
    const WB_URL = "/dsh-invest/app";

    /** 侧栏入口图标：走马灯式走势线，active 时加粗（owner props: size, active） */
    function WorkbenchIcon(props) {
      const size = (props && typeof props.size === "number") ? props.size : 18;
      const active = !!(props && props.active);
      return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: active ? 2.2 : 1.7,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
      }, React.createElement("path", { d: "M4 19V5M4 19h16M7 15l4-4 3 2 5-7" }));
    }

    /** 主面板：iframe 载入工作台 SPA（同源，复用其全部功能） */
    function WorkbenchPanel() {
      const [nonce, setNonce] = React.useState(0);
      return React.createElement("div", { className: "invr-wb" },
        React.createElement("div", { className: "invr-wb-bar" },
          React.createElement("span", { className: "invr-wb-title" }, "投研工作台"),
          React.createElement("span", { className: "invr-wb-hint" }, "判断质量 · 持仓 · 个股知识库 · 一键任务"),
          React.createElement("button", {
            className: "invr-wb-btn", type: "button", onClick: () => setNonce(nonce + 1), title: "重新载入工作台",
          }, "刷新"),
          React.createElement("button", {
            className: "invr-wb-btn", type: "button", title: "在新窗口打开（便于并排看盘）",
            onClick: () => { try { window.open(WB_URL, "_blank", "noopener") } catch (e) { /* 弹窗被拦时忽略 */ } },
          }, "新窗口"),
        ),
        React.createElement("iframe", {
          key: nonce, className: "invr-wb-frame", src: WB_URL,
          title: "投研工作台", allow: "clipboard-write",
        }),
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === void 0) return;
      // 样式注入（浏览器环境），fiber 卸载时移除
      ctx.effect(() => {
        const styleEl = document.createElement("style");
        styleEl.setAttribute("data-dsh-invest", "1");
        styleEl.textContent = CARD_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl) };
      }, "dsh-invest: styles");

      const fmt = (ms) => (ms === void 0 || ms === null || ms === "") ? "" : (ms / 1000).toFixed(1) + "s";
      const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
      function splitBlocks(text) {
        const lines = String(text).split("\n");
        const blocks = [];
        let curText = [];
        let curTable = [];
        const flushText = () => { if (curText.length) { blocks.push({ kind: "text", text: curText.join("\n") }); curText = [] } };
        const flushTable = () => { if (curTable.length) { blocks.push({ kind: "table", rows: curTable }); curTable = [] } };
        for (const line of lines) {
          const t = line.trim();
          if (t.length > 2 && t.charAt(0) === "|" && t.charAt(t.length - 1) === "|") {
            const cells = t.slice(1, -1).split("|").map((c) => c.trim());
            if (isSepRow(cells)) continue;
            flushText();
            curTable.push(cells);
          } else {
            flushTable();
            curText.push(line);
          }
        }
        flushText();
        flushTable();
        return blocks;
      }
      function TableView(props) {
        const rows = props.rows;
        const header = rows[0];
        const body = rows.slice(1);
        const ths = header.map((c, i) => React.createElement("th", { key: i }, c));
        const trs = body.map((r, i) => React.createElement("tr", { key: i }, r.map((c, j) => React.createElement("td", { key: j }, c))));
        return React.createElement("table", { className: "invr-table" },
          React.createElement("thead", null, React.createElement("tr", null, ths)),
          React.createElement("tbody", null, trs));
      }
      function StageBody(props) {
        const text = props.text;
        const reasoning = props.reasoning;
        const blocks = text ? splitBlocks(text).map((b, i) => b.kind === "table"
          ? React.createElement(TableView, { key: i, rows: b.rows })
          : React.createElement("div", { key: i, className: "invr-text" }, b.text)) : [];
        const reasonNode = (reasoning && reasoning.trim())
          ? React.createElement("details", { className: "invr-reason" },
              React.createElement("summary", null, "💭 推理过程（思考内容，" + String(reasoning.length) + " 字符）"),
              React.createElement("div", { className: "invr-text" }, reasoning))
          : null;
        return React.createElement("div", null, blocks, reasonNode);
      }
      function Card(props) {
        const block = props.block;
        const [open, setOpen] = React.useState(false);
        const [charts, setCharts] = React.useState([]);
        const [prog, setProg] = React.useState(null);
        const [zoomIdx, setZoomIdx] = React.useState(-1);
        const [stageIdx, setStageIdx] = React.useState(0);
        const isDone = block !== void 0 && block !== null && block.kind === "tool-result";
        React.useEffect(() => {
          if (!isDone) return;
          const meta = block.meta;
          const paths = (meta && Array.isArray(meta.charts)) ? meta.charts.map((c) => (c && typeof c.path === "string") ? c.path : null).filter(Boolean) : [];
          if (paths.length === 0) return;
          setCharts(paths.map((p) => ({ path: p, svg: null, err: null })));
          let dead = false;
          paths.forEach((p, i) => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 10000);
            fetch("/api/dsh-invest/chart?path=" + encodeURIComponent(p), { signal: ac.signal }).then((r) => r.json()).then((res) => {
              if (dead) return;
              setCharts((prev) => prev.map((c, j) => (j === i ? { path: p, svg: (res && typeof res.svg === "string") ? res.svg : null, err: (res && res.error) ? String(res.error) : null } : c)));
            }).catch((e) => {
              if (dead) return;
              setCharts((prev) => prev.map((c, j) => (j === i ? { path: p, svg: null, err: (e && e.name === "AbortError") ? "图表加载超时" : String(e).slice(0, 140) } : c)));
            }).finally(() => clearTimeout(timer));
          });
          return () => { dead = true };
        }, [block, isDone]);
        React.useEffect(() => {
          if (isDone) return;
          const tick = () => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 10000);
            fetch("/api/dsh-invest/progress?callId=" + encodeURIComponent(props.callId), { signal: ac.signal }).then((r) => r.json()).then((res) => {
              if (res && !res.none) setProg(res);
            }).catch(() => {}).finally(() => clearTimeout(timer));
          };
          tick();
          const stop = ctx.interval(tick, 2000);
          return stop;
        }, [isDone, props.callId]);
        const meta = (isDone && block.meta && typeof block.meta === "object") ? block.meta : null;
        const stages = (meta && Array.isArray(meta.stages)) ? meta.stages : [];
        const modeText = meta && typeof meta.mode === "string" ? meta.mode : "";
        const bodyText = isDone && Array.isArray(block.content) && block.content[0] && block.content[0].type === "text" ? block.content[0].text : "";
        // 分节优先 meta.stages（阶段名/顺序/文本来自 tool-private 完整报告，可信）；
        // 旧调用无 meta 时回退到 render 文本按 === 阶段名 === 分界切分
        const sections = [];
        if (stages.length) {
          for (let i = 0; i < stages.length; i++) {
            const st = stages[i];
            if (st && typeof st.stage === "string") sections.push({ key: st.stage, text: (typeof st.text === "string" && st.text) ? st.text : "" });
          }
        }
        if (!sections.length) {
          const re = /=== ([^=\n]+?) ｜ [^=]*? ===\n/g;
          let m;
          let lastIdx = -1;
          let lastKey = null;
          const raw = bodyText;
          while ((m = re.exec(raw)) !== null) {
            if (lastKey !== null) sections.push({ key: lastKey, text: raw.slice(lastIdx, m.index) });
            lastKey = m[1];
            lastIdx = m.index + m[0].length;
          }
          if (lastKey !== null) sections.push({ key: lastKey, text: raw.slice(lastIdx) });
        }
        const chartNodes = charts.map((c, i) => React.createElement("div", { key: i },
          c.svg !== null ? React.createElement("img", { className: "invr-chart", alt: c.path, src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(c.svg), onClick: () => setZoomIdx(i) })
            : c.err !== null ? React.createElement("div", { className: "invr-charterr" }, "图表加载失败：" + c.err)
              : React.createElement("div", { className: "invr-hint" }, "图表加载中…")));
        const safeIdx = sections.length > 0 ? Math.min(Math.max(stageIdx, 0), sections.length - 1) : 0;
        const tabs = sections.map((s, i) => {
          const st = stages[i];
          const cls = "invr-tab " + (i === safeIdx ? "active" : "") + (st ? (st.ok ? " ok" : " fail") : "");
          return React.createElement("span", { key: i, className: cls, onClick: () => setStageIdx(i) },
            (i + 1) + ". " + s.key + (st ? (st.route ? " · " + String(st.route).split("/").pop() : "") + " · " + fmt(st.elapsedMs) : ""));
        });
        const curSection = sections[safeIdx];
        const metaText = stages[safeIdx] && typeof stages[safeIdx].text === "string" && stages[safeIdx].text ? stages[safeIdx].text : "";
        const curText = metaText || (curSection ? curSection.text : "");
        const curReasoning = stages[safeIdx] && typeof stages[safeIdx].reasoning === "string" ? stages[safeIdx].reasoning : "";
        if (!isDone) {
          let runMode = "";
          try {
            const a = JSON.parse(block.argsRaw || "{}");
            if (a && typeof a.mode === "string") runMode = a.mode;
          } catch (e) { /* ignore */ }
          const doneList = (prog && Array.isArray(prog.done)) ? prog.done : [];
          const doneBadges = doneList.map((d, i) => React.createElement("span", { key: "d" + i, className: "invr-tab ok" },
            d.stage + (d.route ? " · " + String(d.route).split("/").pop() : "") + " · " + fmt(d.ms)));
          const line = (prog && typeof prog.total === "number" && prog.total > 0)
            ? "进行中 " + prog.index + "/" + prog.total + "：" + prog.stage
            : "子代理启动中…";
          return React.createElement("div", { className: "invr-card" },
            React.createElement("div", { className: "invr-head" },
              React.createElement("span", { className: "invr-title" }, "invest_run 投研流水线" + (runMode ? " · " + runMode : "")),
              React.createElement("span", { className: "invr-hint" }, line)),
            doneBadges.length ? React.createElement("div", { className: "invr-tabs" }, doneBadges) : null);
        }
        return React.createElement("div", { className: "invr-card" },
          React.createElement("div", { className: "invr-head", onClick: () => setOpen((o) => !o) },
            React.createElement("span", { className: "invr-title" }, "投研流水线 · " + modeText + "（" + sections.length + " 个阶段，点击标签查看每个 Agent 输出）"),
            React.createElement("span", { className: "invr-hint" }, open ? "收起" : "展开")),
          tabs.length ? React.createElement("div", { className: "invr-tabs" }, tabs) : null,
          open ? React.createElement("div", null,
            charts.length ? React.createElement("div", { className: "invr-charts" }, chartNodes) : null,
            curSection ? React.createElement("div", null,
              React.createElement("div", { className: "invr-stagehead" }, "【" + curSection.key + "】完整报告" + (stages[safeIdx] && stages[safeIdx].route ? " · " + String(stages[safeIdx].route).split("/").pop() : "")),
              React.createElement(StageBody, { text: curText, reasoning: curReasoning })) : null) : null,
          zoomIdx >= 0 && charts[zoomIdx] && charts[zoomIdx].svg !== null ? React.createElement("div", { className: "invr-zoom", onClick: () => setZoomIdx(-1) },
            React.createElement("img", { className: "invr-zoomimg", src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(charts[zoomIdx].svg), alt: charts[zoomIdx].path })) : null);
      }
      // 三个注册彼此隔离：任一失败（如动态插件已认领同一 key）不连累其余。
      try {
        slots.inject("tool.call.toolview", () => slots.register(
          { name: "tool.call.toolview", key: "invest_run" },
          (props) => React.createElement(Card, props),
        ));
      } catch (e) { /* 已由动态插件提供同一卡片时忽略 */ }

      // 左侧栏入口 + 主面板（v0.49.0）。声明感知：DSH 版本没有这两个 seat 时不会注册，也不报错。
      try {
        ctx.effect(() => slots.inject("sidebar.panellist", () => slots.register(
          { name: "sidebar.panellist", id: WB_PANEL_ID, order: 50, label: "投研工作台" },
          (props) => React.createElement(WorkbenchIcon, props),
        )), "dsh-invest: workbench entry");
      } catch (e) { /* 旧版 DSH 没有 sidebar.panellist */ }
      try {
        ctx.effect(() => slots.inject("main", () => slots.register(
          { name: "main", key: WB_PANEL_ID },
          () => React.createElement(WorkbenchPanel, null),
        )), "dsh-invest: workbench panel");
      } catch (e) { /* 旧版 DSH 没有 main 的 keyed 席位 */ }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
