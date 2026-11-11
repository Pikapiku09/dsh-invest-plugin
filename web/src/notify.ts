// Windows / 浏览器系统通知封装
// 页面跑在 http://127.0.0.1（secure context），用户授权后 new Notification() 会以 Windows 通知呈现。
// 设计要点：① 同一提醒 key 只弹一次（localStorage 去重）；② 权限未授予时保留页面内 toast 兜底；
//          ③ 通知开关持久化，默认开启。
const ENABLED_KEY = 'dsh-invest.notifyEnabled';
const SEEN_KEY = 'dsh-invest.seenAlertKeys';
const MAX_SEEN = 500;

export interface SystemNotice {
  key: string;
  title: string;
  body: string;
}

export function notifyEnabled(): boolean {
  try { return window.localStorage.getItem(ENABLED_KEY) !== '0'; } catch { return true; }
}

export function setNotifyEnabled(on: boolean): void {
  try { window.localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* 无法持久化时仅本次生效 */ }
}

/** 当前通知权限（浏览器不支持时视为 denied） */
export function notifyPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

/** 只有用户手势里调用才可靠；返回最终权限 */
export async function ensureNotifyPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'default') {
    try { return await Notification.requestPermission(); } catch { return Notification.permission; }
  }
  return Notification.permission;
}

function seenKeys(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set(); }
}

function markSeen(keys: string[]): void {
  if (!keys.length) return;
  const set = seenKeys();
  keys.forEach((key) => set.add(key));
  try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(set).slice(-MAX_SEEN))); } catch { /* 忽略 */ }
}

/**
 * 把一批提醒推送到系统通知（Windows 通知），返回实际新推送的条数。
 * 未开启 / 无权限 / 重复 key 时不推送；页面内 toast 由调用方通过事件兜底。
 */
export async function pushAlertsToSystem(alerts: SystemNotice[]): Promise<number> {
  if (!alerts.length || !notifyEnabled()) return 0;
  const seen = seenKeys();
  const fresh = alerts.filter((alert) => alert.key && !seen.has(alert.key));
  if (!fresh.length) return 0;
  // 不在这里申请权限：非用户手势下 requestPermission 可能被浏览器自动拒绝。
  // 权限只由「系统通知开关」在用户手势里申请；此处仅按当前权限决定是否弹系统通知。
  const granted = notifyPermission() === 'granted';
  let pushed = 0;
  for (const alert of fresh) {
    if (granted && typeof Notification !== 'undefined') {
      try {
        const notice = new Notification(alert.title, { body: alert.body, tag: alert.key });
        notice.onclick = () => { try { window.focus(); notice.close(); } catch { /* 忽略 */ } };
        pushed += 1;
      } catch { /* 单条失败不影响其余 */ }
    }
    // 无论系统通知是否成功，都给页面内兜底事件（保证「更明显」）
    window.dispatchEvent(new CustomEvent('dsh-invest:system-notify', { detail: alert }));
  }
  markSeen(fresh.map((alert) => alert.key));
  return pushed;
}
