import { emptyState, errorState, jobStatusBadge, pageHeader, sectionHeading } from './components';
import { runsSection } from './runs';
import { escapeHtml, formatDateTime, formatDuration, truncate } from './format';
import { icon } from './icons';
import type { AppState, TaskDraft } from './state';
import type { Job, JobProgress, TaskTemplate } from './types';

export const NAME_INPUT_TEMPLATES = new Set(['stock-review', 'stock-quick']);

function templateIcon(template: TaskTemplate): string {
  const text = `${template.id} ${template.name}`;
  if (/日检/.test(text)) return 'clock';
  if (/组合|持仓/.test(text)) return 'wallet';
  if (/早盘|异动/.test(text)) return 'chart';
  if (/波段|周检/.test(text)) return 'runs';
  if (/财报/.test(text)) return 'file';
  return 'code';
}

/** 观察仓日检状态条：常驻一键任务页顶部（开关 / 收盘后定时 / 立即运行 / 上次结果） */
function watchDailyBar(state: AppState): string {
  const d = state.watchDaily;
  if (!d) {
    return `<section class="panel watch-daily-bar" id="watch-daily-panel">${sectionHeading('观察仓日检', '每日自动刷新观察仓并判断是否买入')}<p class="muted compact">日检接口未就绪：后端改动后需重启 DSH GUI 才会出现该能力。</p></section>`;
  }
  const statusText = d.lastStatus === 'fired' ? `已触发 ${d.lastTriggered.length} 只，排队深度判断`
    : d.lastStatus === 'no-trigger' ? '本次无触发'
      : d.lastStatus === 'error' ? '上次执行失败'
        : '尚未执行';
  const triggerLabel: Record<string, string> = { boot: '开机补跑', close: '收盘定时', manual: '手动' };
  const tone = d.enabled ? 'on' : 'off';
  const triggered = d.lastTriggered.length
    ? ` · ${d.lastTriggered.slice(0, 5).map((code) => `<span class="mono">${escapeHtml(code)}</span>`).join(' ')}`
    : '';
  const lastLine = d.lastRunAt
    ? `${escapeHtml(triggerLabel[d.lastTrigger] || '上次')} · ${escapeHtml(formatDateTime(d.lastRunAt, true))} · ${escapeHtml(statusText)}${triggered}`
    : '尚未执行过日检';
  // 进度条：规则层刷新中 / LLM 任务排队或运行中 → 实时进度；已归档 → 直接给报告入口
  const job = d.lastJobId ? state.jobs.find((item) => item.id === d.lastJobId) : undefined;
  const jobLive = Boolean(job && (job.status === 'queued' || job.status === 'running'));
  let progressHtml = '';
  if (state.watchDailyRunning || jobLive) {
    // 新一轮日检进行中时，上一轮的已归档任务不能拿来冒充当前进度
    const live = jobLive ? job : undefined;
    const info = live ? progressDetails(live.progress, live) : { label: `正在刷新 ${d.watchCount} 只观察仓现价并比对买区…`, percent: null as number | null };
    const percent = info.percent === null ? null : Math.max(0, Math.min(100, info.percent));
    progressHtml = `<div class="watch-daily-progress"><div class="job-progress-copy"><span>${escapeHtml(info.label)}</span><small>${live ? 'JOB ' + escapeHtml(live.id) : '规则层 · 不消耗 token'}</small></div><div class="progress-track ${percent === null ? 'indeterminate' : ''}">${percent !== null ? `<i style="width:${percent}%"></i>` : '<i></i>'}</div></div>`;
  } else if (job) {
    progressHtml = `<div class="watch-daily-progress done"><span>${jobStatusBadge(job.status)}${job.status === 'done' ? '上次日检报告已归档' : '上次日检任务失败'}${job.error ? '：' + escapeHtml(truncate(job.error, 60)) : ''}</span>${job.status === 'done' ? `<button class="text-button" data-action="open-job-report" data-id="${escapeHtml(job.id)}">${icon('file', 14)}查看报告</button>` : ''}</div>`;
  }
  return `<section class="panel watch-daily-bar" id="watch-daily-panel">
    <div class="watch-daily-head"><span class="watch-daily-dot ${tone}"></span><div class="watch-daily-copy"><h2>观察仓日检</h2><p>开机补跑 + 每天 <b>${escapeHtml(d.at)}</b> 收盘后各跑一次：先跑规则层刷新 <b>${d.watchCount}</b> 只观察仓的现价与买区，只有<b>进入买区 / 跌破失效价</b>的标的才排队深度判断，其余不烧 token。</p></div></div>
    <div class="watch-daily-meta"><span class="watch-daily-chip ${tone}">${d.enabled ? '已开启' : '已暂停'}</span><span>${lastLine}</span>${d.running ? '<span class="watch-daily-chip running">运行中…</span>' : ''}</div>
    <div class="watch-daily-actions"><label class="watch-daily-time">收盘后定时 <input type="time" data-watch-daily-at value="${escapeHtml(d.at)}" ${state.watchDailySaving ? 'disabled' : ''} /></label><button class="button button-secondary" data-action="watch-daily-toggle" ${state.watchDailySaving ? 'disabled' : ''}>${d.enabled ? '暂停自动' : '开启自动'}</button><button class="button button-primary" data-action="watch-daily-run" ${state.watchDailyRunning ? 'disabled' : ''}>${state.watchDailyRunning ? '<span class="spinner"></span>日检中' : `${icon('play', 15)}立即日检`}</button></div>
    ${progressHtml}
  </section>`;
}

/** 按用户自定义顺序排列模板；未出现在 order 里的模板保持后端顺序并排在后面 */
export function orderedTemplates(templates: TaskTemplate[], order: string[]): TaskTemplate[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...templates].sort((a, b) => {
    const ai = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const bi = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    return ai === bi ? 0 : ai - bi;
  });
}

/** 执行模型：折叠展示（默认收起）；摘要保留宿主模型，展开看逐角色生效模型 */
function execModelLine(template: TaskTemplate): string {
  const models = template.effectiveModels || [];
  // 旧后端（未重载插件）不返回模型字段时整行隐藏，避免出现「执行模型 —」的噪声
  if (!models.length && !template.hostModel) return '';
  const host = template.hostModel ? `<span class="exec-model-host" title="该模板的宿主模型：继承宿主或未覆盖的角色实际使用它">宿主 ${escapeHtml(template.hostModel)}</span>` : '';
  const unique = Array.from(new Set(models.map((model) => model.resolved)));
  const chip = (text: string, tip: string, inherited: boolean): string =>
    `<span class="model-chip${inherited ? ' is-inherit' : ''}" title="${escapeHtml(tip)}">${escapeHtml(text)}</span>`;
  const chips = !models.length ? '<span class="muted">—</span>'
    : unique.length === 1
      ? chip('全部·' + unique[0], models.map((model) => model.role + '：' + model.route).join('\n'),
          !models[0].route || models[0].route === '继承宿主')
      : models.map((model) => chip(model.role + '·' + model.resolved, model.role + '：' + model.route,
          !model.route || model.route === '继承宿主')).join('');
  return `<details class="exec-model-fold" data-field="exec-model-${escapeHtml(template.id)}">
    <summary><span class="exec-model-label">执行模型</span>${host}<i class="exec-model-toggle">逐角色</i></summary>
    <div class="exec-model">${chips}</div>
  </details>`;
}

function templateCard(template: TaskTemplate, state: AppState, index: number, total: number): string {
  const draft: TaskDraft = state.taskDrafts[template.id] || { code: '', question: '' };
  const starting = Boolean(state.startingTemplates[template.id]);
  const acceptsName = NAME_INPUT_TEMPLATES.has(template.id);
  const orderButtons = `<span class="template-order-btns"><button class="icon-button small" data-action="template-move" data-id="${escapeHtml(template.id)}" data-dir="-1" ${index === 0 ? 'disabled' : ''} title="上移" aria-label="上移 ${escapeHtml(template.name)}">↑</button><button class="icon-button small" data-action="template-move" data-id="${escapeHtml(template.id)}" data-dir="1" ${index >= total - 1 ? 'disabled' : ''} title="下移" aria-label="下移 ${escapeHtml(template.name)}">↓</button></span>`;
  return `<article class="template-card template-tone-${index % 5}"><div class="template-top"><span class="template-icon">${icon(templateIcon(template), 21)}</span><span class="template-top-right"><span class="mode-tag">${escapeHtml(template.mode || 'all')}</span>${orderButtons}</span></div>
    <h3>${escapeHtml(template.name)}</h3><p>${escapeHtml(template.description)}</p>
    <div class="role-list">${(template.roles || []).slice(0, 4).map((role) => `<span>${escapeHtml(role)}</span>`).join('')}</div>
    ${template.sequence && template.sequence.length ? `<div class="pipeline-order" title="各阶段严格串行：下游可见上游产出，逐层收窄"><span>串行</span>${template.sequence.map((role) => `<b>${escapeHtml(role)}</b>`).join('<i>→</i>')}</div>` : ''}
    ${execModelLine(template)}
    ${template.needsCode ? `<label class="field-label">${acceptsName ? '代码或股票名' : '标的代码'} <em>必填</em><div class="input-with-icon">${icon('code', 15)}<input data-field="template-code-${escapeHtml(template.id)}" data-template-id="${escapeHtml(template.id)}" data-draft="code" value="${escapeHtml(draft.code)}" placeholder="${escapeHtml(acceptsName ? '如 600519 或 贵州茅台' : (template.placeholder || '如 600519.SH'))}" autocomplete="off" /></div></label>${acceptsName && draft.resolvedCode ? `<p class="field-help">已识别为 <span class="mono">${escapeHtml(draft.resolvedCode)}</span>，提交将按该代码执行</p>` : ''}` : '<div class="no-code-note">无需代码 · 按模板默认范围执行</div>'}
    <details class="template-advanced" data-field="template-advanced-${escapeHtml(template.id)}"><summary>补充分析要求 <span>可选</span></summary><textarea data-field="template-question-${escapeHtml(template.id)}" data-template-id="${escapeHtml(template.id)}" data-draft="question" rows="2" placeholder="例如：重点关注最新财报中的现金流变化">${escapeHtml(draft.question)}</textarea></details>
    <button class="button button-primary template-run" data-action="start-template" data-id="${escapeHtml(template.id)}" ${starting ? 'disabled' : ''}>${starting ? '<span class="spinner"></span>正在提交' : `${icon('play', 15)}开始分析`}</button>
  </article>`;
}

function progressDetails(progress: JobProgress | undefined, job: Job): { label: string; percent: number | null } {
  if (job.status === 'done') return { label: '分析完成，报告已归档', percent: 100 };
  if (job.status === 'failed') return { label: job.error || '任务执行失败', percent: null };
  if (job.status === 'queued') return { label: '任务已入队，等待执行器接收', percent: 0 };
  if (typeof progress === 'string') return { label: progress, percent: null };
  if (typeof progress === 'number') return { label: `当前进度 ${Math.round(progress)}%`, percent: progress };
  if (progress && typeof progress === 'object') {
    const percent = typeof progress.index === 'number' && typeof progress.total === 'number' && progress.total > 0
      ? progress.index / progress.total * 100 : null;
    const step = typeof progress.index === 'number' && typeof progress.total === 'number' ? `（${progress.index}/${progress.total}）` : '';
    return { label: `${progress.message || progress.stage || progress.label || '投研流水线运行中'}${step}`, percent };
  }
  return { label: '投研流水线运行中', percent: null };
}

export function primaryJobReport(job: Job): { path: string; charts: string[] } | null {
  const path = job.result?.reports?.[0] || '';
  return path ? { path, charts: job.result?.charts || [] } : null;
}

function jobCard(job: Job): string {
  const progress = progressDetails(job.progress, job);
  const report = primaryJobReport(job);
  const percent = progress.percent === null ? null : Math.max(0, Math.min(100, progress.percent));
  const outputCount = Array.isArray(job.result?.outputs) ? job.result.outputs.length : 0;
  const historyTag = job.persisted ? '<span class="job-history-tag" title="来自持久化的历史任务（跨 web 关闭保留）">历史</span>' : '';
  return `<article class="job-card"><div class="job-summary"><span class="job-status-icon ${job.status}">${icon(job.status === 'done' ? 'check' : job.status === 'failed' ? 'alert' : 'sparkles', 18)}</span><div class="job-title"><div><strong>${escapeHtml(job.name || job.templateName || job.templateId || '投研分析任务')}</strong>${jobStatusBadge(job.status)}${historyTag}</div><p>${job.code ? `<span class="mono">${escapeHtml(job.code)}</span> · ` : ''}${escapeHtml(truncate(job.question || '按模板执行', 70))}</p></div><div class="job-time"><span>${formatDateTime(job.createdAt, true)}</span><strong>${formatDuration(job.elapsedMs)}</strong></div></div>
    <div class="job-progress-row"><div class="job-progress-copy"><span class="${job.status === 'failed' ? 'danger-text' : ''}">${escapeHtml(progress.label)}</span><small>JOB ${escapeHtml(job.id)}${outputCount ? ` · ${outputCount} 项输出` : ''}</small></div><div class="progress-track ${percent === null && job.status === 'running' ? 'indeterminate' : ''}">${percent !== null ? `<i style="width:${percent}%"></i>` : '<i></i>'}</div></div>
    ${job.status === 'done' || job.persisted ? `<div class="job-actions">${report ? `<button class="button button-secondary" data-action="open-job-report" data-id="${escapeHtml(job.id)}">${icon('file', 15)}查看报告</button><button class="button button-secondary" data-action="ask-report" data-path="${escapeHtml(report.path)}">${icon('chat', 15)}追问</button>` : '<span class="muted">任务完成，未返回报告路径</span>'}</div>` : ''}
  </article>`;
}

export function renderTasks(state: AppState): string {
  const jobs = [...state.jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const meta = state.jobsMeta;
  const activeCount = meta.running + meta.queued || jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const concurrency = meta.concurrency;
  const liveText = activeCount
    ? `运行 ${meta.running} · 排队 ${meta.queued}${concurrency ? ` · 并发上限 ${concurrency}` : ''}`
    : concurrency > 1 ? `执行器空闲 · 最多并发 ${concurrency}` : '执行器空闲';
  // 观察仓日检已有独立的顶部状态条（含开关/定时/立即运行/进度），这里不再重复一张模板卡
  const templates = orderedTemplates(state.templates, state.templateOrder).filter((template) => template.id !== 'watch-daily');
  const subtitle = concurrency > 1
    ? `把常用研究流程封装成模板；最多可同时运行 ${concurrency} 个任务，其余自动排队，提交后自动跟踪阶段、耗时与归档报告。`
    : '把常用研究流程封装成模板；提交后自动跟踪阶段、耗时与归档报告。';
  const headerActions = `<div class="task-head-actions"><span class="live-indicator ${activeCount ? 'active' : ''}"><i></i>${liveText}</span>
    <button class="button button-secondary" data-action="scroll-to" data-target="jobs-panel">${icon('clock', 14)}最近任务</button>
    <button class="button button-secondary" data-action="scroll-to" data-target="runs-panel">${icon('runs', 14)}运行记录</button></div>`;
  return pageHeader('一键任务', subtitle, headerActions) + `
    ${watchDailyBar(state)}
    <section class="task-section">${sectionHeading('分析模板', '选择场景，补齐必要参数，其余交给投研流水线 · 用卡片右上角 ↑↓ 调整顺序')}${state.templatesLoading && !state.templates.length ? `<div class="template-grid">${Array.from({ length: 5 }, () => '<div class="skeleton template-skeleton"></div>').join('')}</div>` : state.templatesError && !state.templates.length ? errorState('模板加载失败', state.templatesError) : templates.length ? `<div class="template-grid">${templates.map((template, index) => templateCard(template, state, index, templates.length)).join('')}</div>` : emptyState('暂无可用模板', '模板接口已返回空列表，请检查后端配置。', 'sparkles')}</section>
    <section class="panel jobs-panel" id="jobs-panel">${sectionHeading('最近任务', '运行任务每 1.2 秒自动刷新进度；关闭 web 后仍保留最近 5 个', `<button class="text-button" data-action="refresh-jobs">${icon('refresh', 14)}刷新任务</button>`)}${state.jobsError ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(state.jobsError)}</div>` : ''}${state.jobsLoading && !jobs.length ? '<div class="skeleton jobs-skeleton"></div>' : jobs.length ? `<div class="job-list">${jobs.slice(0, 3).map(jobCard).join('')}</div>${jobs.length > 3 ? `<details class="job-more" data-field="jobs-more"><summary>展开其余 ${Math.min(jobs.length, 5) - 3} 个任务${jobs.length > 5 ? `（共保留最近 5 个，更早在「运行记录」）` : ''}</summary><div class="job-list">${jobs.slice(3, 5).map(jobCard).join('')}</div></details>` : ''}` : emptyState('还没有任务', '从上方选择一个模板，开始第一次自动化分析。', 'sparkles')}</section>
    ${runsSection(state, true)}`;
}
