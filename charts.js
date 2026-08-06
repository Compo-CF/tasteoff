// charts.js — tiny dependency-free inline-SVG charts. Theme-aware via CSS vars.
// Each returns an SVG string. Guards against empty data.

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Horizontal bars, values 0..max. items: [{label, value, hint?}]
export function barChart(items, { max = 5, unit = "", color = "var(--brand)" } = {}) {
  if (!items || !items.length) return `<p class="hint">No data yet.</p>`;
  const rowH = 30, labelW = 92, w = 320, barW = w - labelW - 44;
  const h = items.length * rowH + 8;
  const rows = items
    .map((it, i) => {
      const y = i * rowH + 6;
      const frac = max ? Math.max(0, Math.min(1, it.value / max)) : 0;
      const bw = Math.max(2, frac * barW);
      return `
      <text x="0" y="${y + 15}" class="c-lbl">${esc(it.label)}</text>
      <rect x="${labelW}" y="${y + 4}" width="${barW}" height="16" rx="4" class="c-track"/>
      <rect x="${labelW}" y="${y + 4}" width="${bw}" height="16" rx="4" fill="${color}"/>
      <text x="${labelW + bw + 5}" y="${y + 15}" class="c-val">${it.value}${unit}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${rows}</svg>`;
}

// Diverging bars around zero (e.g. generosity −x..+x, or correlation −1..1).
export function divergingChart(items, { max = 1, posColor = "var(--brand)", negColor = "#3b6ea5" } = {}) {
  if (!items || !items.length) return `<p class="hint">No data yet.</p>`;
  const rowH = 30, labelW = 92, w = 320;
  const mid = labelW + (w - labelW - 8) / 2;
  const half = (w - labelW - 12) / 2;
  const h = items.length * rowH + 8;
  const rows = items
    .map((it, i) => {
      const y = i * rowH + 6;
      const frac = Math.max(-1, Math.min(1, it.value / (max || 1)));
      const bw = Math.abs(frac) * half;
      const x = frac >= 0 ? mid : mid - bw;
      const color = frac >= 0 ? posColor : negColor;
      return `
      <text x="0" y="${y + 15}" class="c-lbl">${esc(it.label)}</text>
      <line x1="${mid}" y1="${y + 2}" x2="${mid}" y2="${y + 22}" class="c-axis"/>
      <rect x="${x}" y="${y + 4}" width="${Math.max(1, bw)}" height="16" rx="3" fill="${color}"/>
      <text x="${frac >= 0 ? mid + bw + 4 : mid - bw - 4}" y="${y + 15}" class="c-val" text-anchor="${frac >= 0 ? "start" : "end"}">${it.value > 0 ? "+" : ""}${it.value}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${rows}</svg>`;
}

// Vertical histogram. items: [{score, count}]
export function histogram(items) {
  if (!items || !items.every) return `<p class="hint">No data yet.</p>`;
  const maxC = Math.max(1, ...items.map((d) => d.count));
  const w = 320, h = 140, padB = 22, padT = 8;
  const bw = (w - 8) / items.length;
  const bars = items
    .map((d, i) => {
      const bh = (d.count / maxC) * (h - padB - padT);
      const x = 4 + i * bw;
      const y = h - padB - bh;
      return `<rect x="${x + 2}" y="${y}" width="${bw - 4}" height="${Math.max(0, bh)}" rx="3" fill="var(--brand)"/>
        <text x="${x + bw / 2}" y="${h - 6}" class="c-tick" text-anchor="middle">${d.score}</text>
        ${d.count ? `<text x="${x + bw / 2}" y="${y - 3}" class="c-val" text-anchor="middle">${d.count}</text>` : ""}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${bars}</svg>`;
}

// Radar/spider for one dish's facets. axes: [{short, value}], value 0..max
export function radar(axes, { max = 5 } = {}) {
  if (!axes || axes.length < 3) return `<p class="hint">Need at least 3 criteria for a radar.</p>`;
  const size = 240, cx = size / 2, cy = size / 2, R = 88;
  const n = axes.length;
  const pt = (i, r) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  };
  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const p = axes.map((_, i) => pt(i, R * f).join(",")).join(" ");
      return `<polygon points="${p}" class="c-ring"/>`;
    })
    .join("");
  const spokes = axes
    .map((a, i) => {
      const [x, y] = pt(i, R);
      const [lx, ly] = pt(i, R + 16);
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="c-ring"/>
        <text x="${lx}" y="${ly}" class="c-tick" text-anchor="middle" dominant-baseline="middle">${esc(a.short)}</text>`;
    })
    .join("");
  const poly = axes.map((a, i) => pt(i, R * Math.max(0, Math.min(1, a.value / max))).join(",")).join(" ");
  const dots = axes
    .map((a, i) => {
      const [x, y] = pt(i, R * Math.max(0, Math.min(1, a.value / max)));
      return `<circle cx="${x}" cy="${y}" r="3" fill="var(--brand)"/>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${size} ${size}" class="chart radar" role="img">
    ${rings}${spokes}
    <polygon points="${poly}" class="c-area"/>${dots}</svg>`;
}
