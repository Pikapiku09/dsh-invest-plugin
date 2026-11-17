// 内联 SVG 折线（v0.63.0）
//
// 工作台没有图表库，为一条线引 echarts 不划算（Lihu 那边是 vendored 1MB 的 echarts）。
// 抽出共享实现，避免量化策略页与策略回测页各写一份、样式飘移。
import { escapeHtml } from './format';

export interface SparkPoint {
  d: string;
  v: number;
}

/**
 * 折线 + 面积。
 * @param tone 'up' 用强调色（默认）；'down' 用红/绿语义由调用方决定是否传
 */
export function sparkline(points: SparkPoint[], w = 640, h = 150, label = '曲线'): string {
  if (!points || points.length < 2) return '<p class="muted">数据点不足两天，暂不画曲线。</p>';
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const pad = 8;
  const xy = points.map((p, i) => {
    const x = i * step;
    const y = h - pad - ((p.v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = xy.join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  return `<div class="equity-spark-wrap">
    <svg class="equity-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
         aria-label="${escapeHtml(label)}，${escapeHtml(points[0].d)} 至 ${escapeHtml(points[points.length - 1].d)}">
      <polygon class="spark-area" points="${area}"/>
      <polyline class="spark-line" points="${line}"/>
    </svg>
    <div class="equity-axis">
      <span>${escapeHtml(points[0].d)}</span>
      <span>${escapeHtml(points[points.length - 1].d)}</span>
    </div>
  </div>`;
}
