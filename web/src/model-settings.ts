import { errorState, pageHeader, sectionHeading, skeletonPage } from './components';
import { escapeHtml } from './format';
import { icon } from './icons';
import type { AppState } from './state';
import type { ModelPresetDefinition, ModelRoleSetting, ModelSettingsResponse, ModelTemplateSetting } from './types';

const ROLE_ORDER = ['选股', '消息', '深度', '总判断', '波段'];
const TEMPLATE_ORDER = ['stock-review', 'stock-quick', 'portfolio-review', 'morning-news', 'swing-weekly', 'watch-daily', 'market-screen-full'];
const TEMPLATE_USE: Record<string, string> = {
  'stock-review': '单只标的的完整深度分析',
  'stock-quick': '单只标的的轻量快速诊断',
  'portfolio-review': '账户与持仓组合的整体检查',
  'morning-news': '盘前消息与异动线索梳理',
  'swing-weekly': '波段池与持仓纪律的周度复盘',
  'watch-daily': '观察仓每日批量刷新 + 触发者买入判断（默认每日自动）',
  'market-screen-full': '全市场海选 + 消息核验 + 深度 + 组合决策（四阶段串行）',
};
// 推理强度：default = 不向宿主下发 reasoningEffort，由模型自身默认决定（路由串不带 @）
const EFFORT_OPTIONS = [
  { value: 'default', label: 'default · 模型默认' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
];
const DEFAULT_PRESETS: ModelPresetDefinition[] = [
  { id: 'inherit', name: '继承宿主', description: '使用宿主模型与默认推理强度，不做额外覆盖。' },
  { id: 'budget', name: '经济快速', description: '优先控制调用成本，适合高频初筛与轻量任务。' },
  { id: 'balanced', name: '均衡', description: '兼顾分析质量、响应速度与调用成本。' },
  { id: 'quality', name: '高质量', description: '优先分析深度与结论可靠性，耗时和成本可能更高。' },
  { id: 'fast', name: '快速', description: '优先缩短响应时间，适合时效性较强的任务。' },
];

export function modelRouteFor(role: ModelRoleSetting, state: AppState): string {
  return state.modelRoleRoutes[role.code] ?? role.route ?? 'inherit';
}

export function modelPresetFor(template: ModelTemplateSetting, state: AppState): string {
  return state.modelTemplatePresets[template.id] ?? template.preset ?? 'inherit';
}

/** 合法路由：provider/model（=default，不带 @）或 provider/model@effort；也接受备选链 */
export function isValidModelRoute(route: string): boolean {
  const value = route.trim();
  if (value === 'inherit') return true;
  if (!value || Array.from(value).some((character) => character.trim() === '')) return false;
  return value.split('|').every((item) => {
    const slash = item.indexOf('/');
    const at = item.indexOf('@');
    const hasEffort = at > 0;
    return slash > 0 && item.lastIndexOf('/') === slash
      && (!hasEffort || (at > slash + 1 && at < item.length - 1 && item.lastIndexOf('@') === at));
  });
}

export function modelSettingsDirtyCount(state: AppState): number {
  if (!state.modelSettings) return 0;
  const roles = state.modelSettings.roles.filter((role) => modelRouteFor(role, state).trim() !== (role.route || 'inherit')).length;
  const templates = state.modelSettings.templates.filter((template) => modelPresetFor(template, state) !== (template.preset || 'inherit')).length;
  const host = (state.modelHostDraft || 'inherit') !== serverHostValue(state.modelSettings) ? 1 : 0;
  return roles + templates + host;
}

/** 服务器当前生效的宿主模型取值：'inherit'（跟随会话）或 provider/model（自定义覆盖） */
export function serverHostValue(settings: ModelSettingsResponse | null | undefined): string {
  const host = settings?.hostModel;
  return host && host.source === 'override' && host.label ? host.label : 'inherit';
}

function ordered<T>(items: T[], order: string[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ai = order.indexOf(key(a));
    const bi = order.indexOf(key(b));
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
  });
}

/** 宿主模型卡片：展示当前宿主模型 + 更改入口（一键任务与「继承宿主」角色都吃这个值） */
function hostModelCard(state: AppState): string {
  const settings = state.modelSettings!;
  const host = settings.hostModel;
  const session = settings.sessionModel;
  const draft = state.modelHostDraft || 'inherit';
  const dirty = draft !== serverHostValue(settings);
  const options = [
    { value: 'inherit', label: '跟随会话宿主（默认）' },
    ...(settings.modelOptions || []).filter((option) => option.value !== 'inherit'),
  ];
  if (draft !== 'inherit' && !options.some((option) => option.value === draft)) {
    options.push({ value: draft, label: '当前自定义 / ' + draft });
  }
  const select = '<select id="host-model-select" class="host-model-select" data-host-model>'
    + options.map((option) => '<option value="' + escapeHtml(option.value) + '" ' + (draft === option.value ? 'selected' : '') + '>' + escapeHtml(option.label) + '</option>').join('')
    + '</select>';
  const badge = dirty ? '未保存' : host?.source === 'override' ? '自定义' : '跟随会话';
  const badgeTone = dirty ? 'dirty' : host?.source === 'override' ? 'custom' : '';
  const sessionLine = session && session.label !== (host?.label || '')
    ? `<p class="field-help">当前会话模型：<code>${escapeHtml(session.label)}</code>（仅作对照；选择「跟随会话宿主」时使用它）</p>`
    : '';
  return `<section class="panel host-model-card ${dirty ? 'is-dirty' : ''}">
    <div class="model-card-head"><span class="model-role-icon">${icon('database', 18)}</span>
      <div><h3>宿主模型</h3><span class="mono">host model</span></div>
      <span class="config-badge ${badgeTone}">${badge}</span></div>
    <p class="host-model-current">当前宿主模型 <code>${escapeHtml(host?.label || '未识别')}</code></p>
    <label class="model-route-label" for="host-model-select">更改宿主模型</label>${select}
    <p class="field-help">「继承宿主」的角色与一键任务都使用该模型；选择「跟随会话宿主」则始终跟随当前 DSH 会话的模型。</p>
    ${sessionLine}
  </section>`;
}

function roleCard(role: ModelRoleSetting, state: AppState): string {
  const route = modelRouteFor(role, state);
  const effective = role.route || 'inherit';
  const dirty = route.trim() !== effective;
  const firstRoute = route.split('|')[0].trim();
  const at = firstRoute.lastIndexOf('@');
  const selectedModel = firstRoute === 'inherit' ? 'inherit' : (at > 0 ? firstRoute.slice(0, at) : firstRoute);
  // 路由串不带 @ → default（未指定推理强度）；继承宿主时 effort 下拉禁用、显示 default
  const selectedEffort = firstRoute === 'inherit' ? 'default' : (at > 0 ? firstRoute.slice(at + 1) : 'default');
  const options = [...(state.modelSettings?.modelOptions || [])];
  if (selectedModel !== 'inherit' && !options.some((option) => option.value === selectedModel)) {
    options.push({ value: selectedModel, label: '当前自定义 / ' + selectedModel });
  }
  if (!options.some((option) => option.value === 'inherit')) options.unshift({ value: 'inherit', label: '继承宿主模型（默认）' });
  const modelSelect = '<select id="route-' + escapeHtml(role.code) + '" class="model-route-input" data-field="model-route-model-' + escapeHtml(role.code) + '" data-role-model="' + escapeHtml(role.code) + '">'
    + options.map((option) => '<option value="' + escapeHtml(option.value) + '" ' + (selectedModel === option.value ? 'selected' : '') + '>' + escapeHtml(option.label) + '</option>').join('') + '</select>';
  const effortSelect = '<select class="model-effort-input" data-field="model-route-effort-' + escapeHtml(role.code) + '" data-role-effort="' + escapeHtml(role.code) + '" ' + (selectedModel === 'inherit' ? 'disabled' : '') + '>'
    + EFFORT_OPTIONS.map((option) => '<option value="' + option.value + '" ' + (selectedEffort === option.value ? 'selected' : '') + '>' + escapeHtml(option.label) + '</option>').join('') + '</select>';
  const inheritHost = state.modelSettings?.hostModel?.label;
  const effectiveDisplay = effective.trim() === 'inherit' && inheritHost ? 'inherit → ' + inheritHost : effective;
  return '<article class="model-role-card ' + (dirty ? 'is-dirty' : '') + '">'
    + '<div class="model-card-head"><span class="model-role-icon">' + icon(role.name === '深度' ? 'layers' : role.name === '消息' ? 'file' : role.name === '波段' ? 'chart' : role.name === '总判断' ? 'sparkles' : 'search', 18) + '</span>'
    + '<div><h3>' + escapeHtml(role.name) + '</h3><span class="mono">' + escapeHtml(role.code) + '</span></div>'
    + '<span class="config-badge ' + (dirty ? 'dirty' : route.trim() === 'inherit' ? '' : 'custom') + '">' + (dirty ? '未保存' : route.trim() === 'inherit' ? '继承宿主' : '自定义') + '</span></div>'
    + '<label class="model-route-label" for="route-' + escapeHtml(role.code) + '">角色模型</label>' + modelSelect
    + '<label class="model-route-label">推理强度</label>' + effortSelect
    + '<p class="field-help">默认 <code>default</code>：不下发推理强度，由模型自身决定；需要强制档位时再选 low/medium/high/max。备选链仍沿用现有配置。</p>'
    + '<div class="effective-config"><span>当前生效</span><code title="' + escapeHtml(effectiveDisplay) + '">' + escapeHtml(effectiveDisplay) + '</code></div></article>';
}

function templateCard(template: ModelTemplateSetting, presets: ModelPresetDefinition[], state: AppState): string {
  const selected = modelPresetFor(template, state);
  const effective = template.preset || 'inherit';
  const definition = presets.find((preset) => preset.id === selected);
  const inheritHost = state.modelSettings?.hostModel?.label;
  const effectiveDisplay = effective.trim() === 'inherit' && inheritHost ? 'inherit → ' + inheritHost : effective;
  return `<article class="model-template-card ${selected !== effective ? 'is-dirty' : ''}">
    <div class="model-template-title"><div><h3>${escapeHtml(template.name)}</h3><span class="mono">${escapeHtml(template.id)}</span></div>${selected !== effective ? '<span class="config-badge dirty">未保存</span>' : ''}</div>
    <p>${escapeHtml(TEMPLATE_USE[template.id] || '按模板预设执行投研任务')}</p>
    <label class="select-field" for="preset-${escapeHtml(template.id)}"><span>预设档</span><select id="preset-${escapeHtml(template.id)}" data-field="model-preset-${escapeHtml(template.id)}" data-template-preset="${escapeHtml(template.id)}">
      ${presets.map((preset) => `<option value="${escapeHtml(preset.id)}" ${selected === preset.id ? 'selected' : ''}>${escapeHtml(preset.name)} · ${escapeHtml(preset.id)}</option>`).join('')}
    </select></label>
    <p class="preset-description">${escapeHtml(definition?.description || '使用该预设档执行当前模板。')}</p>
    <div class="effective-config"><span>当前生效</span><code title="${escapeHtml(effectiveDisplay)}">${escapeHtml(effectiveDisplay)}</code></div>
  </article>`;
}

export function renderModelSettings(state: AppState): string {
  const dirty = modelSettingsDirtyCount(state);
  const saveAction = `<button class="button button-primary" data-action="save-model-settings" ${!state.modelSettings || state.modelSettingsSaving || !dirty ? 'disabled' : ''}>${state.modelSettingsSaving ? '<span class="spinner"></span>正在保存' : `${icon('check', 15)}保存设置${dirty ? `（${dirty}）` : ''}`}</button>`;
  const header = pageHeader('模型设置', '为不同分析师角色与任务模板配置模型路由；修改仅在点击保存后提交。', saveAction);
  if (state.modelSettingsLoading && !state.modelSettings) return header + skeletonPage();
  if (!state.modelSettings) return header + errorState('模型设置读取失败', state.modelSettingsError || '模型设置接口尚未就绪，请稍后重试。');

  const settings = state.modelSettings;
  const roles = ordered(settings.roles || [], ROLE_ORDER, (role) => role.code);
  const templates = ordered(settings.templates || [], TEMPLATE_ORDER, (template) => template.id);
  const customPresets = new Map((settings.presets || []).map((preset) => [preset.id, preset]));
  const presets = DEFAULT_PRESETS.map((preset) => customPresets.get(preset.id) || preset);
  const missingRoles = ROLE_ORDER.filter((role) => !roles.some((item) => item.code === role || item.name === role));
  const missingTemplates = TEMPLATE_ORDER.filter((id) => !templates.some((item) => item.id === id));
  const incomplete = missingRoles.length || missingTemplates.length
    ? `<div class="inline-warning">${icon('alert', 15)}后端配置尚不完整：${missingRoles.length ? `缺少角色 ${escapeHtml(missingRoles.join('、'))}` : ''}${missingRoles.length && missingTemplates.length ? '；' : ''}${missingTemplates.length ? `缺少模板 ${escapeHtml(missingTemplates.join('、'))}` : ''}。</div>` : '';
  return header
    + (state.modelSettingsError ? `<div class="inline-warning">${icon('alert', 15)}刷新失败，当前显示上次读取的配置：${escapeHtml(state.modelSettingsError)}</div>` : '')
    + incomplete
    + hostModelCard(state)
    + `<section class="settings-guide"><span>${icon('database', 19)}</span><div><strong>路由与预设分离管理</strong><p>宿主模型决定「继承宿主」与一键任务的默认执行模型；角色路由直接选择已注册模型与推理强度；推理强度默认 <code>default</code>（不下发，由模型自身决定）。模板预设提供继承宿主、经济快速、均衡、高质量、快速五档。</p></div></section>
     <section class="settings-section">${sectionHeading('分析师角色', '5 个角色均可独立设置，默认继承宿主；推理强度默认 default')}
       <div class="model-role-grid">${roles.map((role) => roleCard(role, state)).join('')}</div></section>
     <section class="settings-section">${sectionHeading('任务模板', '6 个标准模板使用独立预设档')}
       <div class="model-template-grid">${templates.map((template) => templateCard(template, presets, state)).join('')}</div></section>
     <div class="settings-save-bar"><span>${dirty ? `有 ${dirty} 项修改尚未保存` : '所有修改均已保存'}。</span><button class="button button-primary" data-action="save-model-settings" ${state.modelSettingsSaving || !dirty ? 'disabled' : ''}>${state.modelSettingsSaving ? '<span class="spinner"></span>正在保存' : `${icon('check', 15)}保存设置`}</button></div>`;
}
