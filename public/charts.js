// Small dependency-free SVG charts: bar, line and stacked bar, with a shared hover layer.
// Colors are CSS custom properties, applied through the CSSOM so the page CSP stays strict.
const SVG_NS = 'http://www.w3.org/2000/svg';
const GAP = 2; // surface gap between stacked segments

function svgEl(name, attrs = {}, parent) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceTicks(min, max, count = 4) {
  if (!(max > min)) {
    min = Number.isFinite(min) ? min - 1 : 0;
    max = Number.isFinite(max) ? max + 1 : 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  const step = (r >= 7.5 ? 10 : r >= 3.5 ? 5 : r >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let k = 0; lo + k * step <= hi + step / 2; k++) ticks.push(+(lo + k * step).toFixed(6));
  return { lo, hi, ticks };
}

function roundedTop(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

const fmtShortDate = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Least-squares trend per series (line), on the bar values (bar) or on the stack total (stack).
// x is the row index, so rows should be evenly spaced (days, weeks or months).
export function trendLines(spec) {
  const data = spec.data || [];
  const skip = spec.trendSkip || (() => false);
  const fit = (val) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, first = null, last = null;
    data.forEach((d, i) => {
      if (skip(d)) return;
      const v = val(d);
      if (v == null || !Number.isFinite(v)) return;
      n += 1; sx += i; sy += v; sxx += i * i; sxy += i * v;
      if (first == null) first = i;
      last = i;
    });
    const den = n * sxx - sx * sx;
    if (n < 4 || !den) return null;
    const slope = (n * sxy - sx * sy) / den;
    return { slope, intercept: (sy - slope * sx) / n, first, last, n };
  };
  if (spec.type === 'stack') {
    const f = fit((d) => {
      const vals = spec.series.map((s) => s.value(d));
      return vals.every((v) => v == null) ? null : vals.reduce((a, v) => a + (v || 0), 0);
    });
    return f ? [{ ...f, label: 'Total', color: 'var(--text-secondary)' }] : [];
  }
  if (spec.type === 'bar') {
    const f = fit(spec.series[0].value);
    return f ? [{ ...f, label: spec.series[0].label, color: 'var(--text-secondary)' }] : [];
  }
  return spec.series.map((s) => {
    const f = fit(s.value);
    return f ? { ...f, label: s.label, color: s.color } : null;
  }).filter(Boolean);
}

// Tooltip content: a title, then rows of key + value + label. A row's key is a status icon
// (good / warning / critical), a color swatch, or a line key.
function fillTip(tip, info) {
  tip.replaceChildren();
  const title = document.createElement('div');
  title.className = 'tt-title';
  title.textContent = info.title;
  tip.appendChild(title);
  for (const row of info.rows) {
    const r = document.createElement('div');
    r.className = 'tt-row';
    const key = document.createElement('span');
    key.className = row.icon ? `tt-icon status-icon status-${row.icon}` : row.swatch ? 'tt-swatch' : 'tt-key';
    if (!row.icon && row.color) key.style.setProperty('--key', row.color);
    const val = document.createElement('strong');
    val.textContent = row.value;
    const lab = document.createElement('span');
    lab.className = 'tt-label';
    lab.textContent = row.label || '';
    r.append(key, val, lab);
    tip.appendChild(r);
  }
}

export function renderChart(host, spec) {
  const st = host.__chart || (host.__chart = {});
  st.spec = spec;
  if (!st.ro) {
    st.ro = new ResizeObserver(() => {
      cancelAnimationFrame(st.raf);
      st.raf = requestAnimationFrame(() => draw(host));
    });
    st.ro.observe(host);
  }
  draw(host, true);
}

function draw(host, force = false) {
  const st = host.__chart;
  const spec = st.spec;
  const width = Math.max(240, Math.floor(host.clientWidth));
  if (!force && st.lastWidth === width) return;
  st.lastWidth = width;
  if (spec.type === 'calendar') return drawCalendar(host, spec, width);

  const data = spec.data;
  const n = data.length;
  const H = spec.height || 210;
  const hasEnd = spec.type === 'line' || spec.type === 'stack';
  const m = { top: 12, right: hasEnd ? 52 : 10, bottom: 26, left: 38 };
  let pw = width - m.left - m.right;
  const ph = H - m.top - m.bottom;

  host.replaceChildren();
  host.classList.add('chart-host');

  if (!n || data.every((d) => spec.series.every((s) => s.value(d) == null))) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = spec.emptyText || 'No data in this range yet.';
    host.appendChild(empty);
    return;
  }

  // ---- y domain
  let lo;
  let hi;
  let ticks;
  if (spec.yTicks) {
    ticks = spec.yTicks;
    lo = ticks[0];
    hi = ticks[ticks.length - 1];
  } else {
    const vals = [];
    for (const d of data) {
      if (spec.type === 'stack') {
        const t = spec.series.reduce((a, s) => a + (s.value(d) || 0), 0);
        if (t) vals.push(t);
      } else {
        for (const s of spec.series) {
          const v = s.value(d);
          if (v != null) vals.push(v);
        }
      }
      if (spec.band) {
        for (const v of [spec.band.lo(d), spec.band.hi(d)]) if (v != null && Number.isFinite(v)) vals.push(v);
      }
    }
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (spec.type !== 'line' || spec.zeroBased) min = 0;
    else {
      const pad = (max - min) * 0.15 || Math.abs(max) * 0.05 || 1;
      min -= pad;
      max += pad;
    }
    if (spec.yMax != null) max = Math.max(max, spec.yMax);
    ({ lo, hi, ticks } = niceTicks(min, max, spec.tickCount || 4));
    if (spec.yFloor != null && lo < spec.yFloor) {
      lo = spec.yFloor;
      ticks = ticks.filter((t) => t >= lo);
      if (ticks[0] !== lo) ticks.unshift(lo);
    }
  }
  // Size the margins to the widest tick label and line end label (about 6.6px per character at 11-12px).
  const fmtY = spec.yFormat || ((v) => String(v));
  const longestTick = Math.max(...ticks.map((t) => String(fmtY(t)).length));
  m.left = Math.max(m.left, Math.round(longestTick * 6.6) + 12);
  if (spec.type === 'line') {
    const ends = spec.series.map((s) => {
      for (let i = n - 1; i >= 0; i--) {
        const v = s.value(data[i]);
        if (v != null) return String(fmtY(v)).length;
      }
      return 0;
    });
    m.right = Math.max(m.right, Math.round(Math.max(...ends) * 7) + 14);
  }
  pw = width - m.left - m.right;
  const y = (v) => m.top + ph - ((v - lo) / (hi - lo)) * ph;
  const step = pw / n;
  const cx = (i) => m.left + step * (i + 0.5);

  const svg = svgEl('svg', {
    width,
    height: H,
    viewBox: `0 0 ${width} ${H}`,
    role: 'img',
    tabindex: '0',
    'aria-label': `${spec.ariaLabel || 'Chart'}. Use left and right arrow keys to read values.`,
    class: `chart chart-${spec.type}`,
  });

  // ---- grid + y axis labels
  const grid = svgEl('g', { class: 'grid' }, svg);
  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    svgEl('line', { x1: m.left, x2: m.left + pw, y1: yy, y2: yy, class: t === lo && lo === 0 ? 'baseline' : 'gridline' }, grid);
    svgEl('text', { x: m.left - 8, y: yy, dy: '0.32em', 'text-anchor': 'end', class: 'tick' }, grid).textContent = fmtY(t);
  }

  // ---- x labels (anchored on the most recent day)
  const maxLabels = Math.max(2, Math.floor(pw / 62));
  const every = Math.max(1, Math.ceil(n / maxLabels));
  const xg = svgEl('g', { class: 'x-axis' }, svg);
  for (let i = n - 1; i >= 0; i -= every) {
    const x = cx(i);
    if (x - 20 < m.left - 10) continue;
    const label = (spec.xFormat || fmtShortDate)(spec.x(data[i]));
    // keep edge labels inside the chart (about 6.2px per character at 11-12px)
    const half = (String(label).length * 6.2) / 2;
    const attrs = x + half > width ? { x: width, 'text-anchor': 'end' } : x - half < 0 ? { x: 0, 'text-anchor': 'start' } : { x, 'text-anchor': 'middle' };
    svgEl('text', { ...attrs, y: H - 8, class: 'tick' }, xg).textContent = label;
  }

  // ---- shaded band (a normal or target range), drawn behind the marks
  if (spec.band) {
    const clampV = (v) => Math.max(lo, Math.min(hi, v));
    let d = '';
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        const top = seg.map(([i, , b]) => `${cx(i).toFixed(1)},${y(b).toFixed(1)}`);
        const bottom = [...seg].reverse().map(([i, a]) => `${cx(i).toFixed(1)},${y(a).toFixed(1)}`);
        d += `M${top.join('L')}L${bottom.join('L')}Z`;
      }
      seg = [];
    };
    data.forEach((row, i) => {
      const a = spec.band.lo(row);
      const b = spec.band.hi(row);
      if (a == null || b == null) return flush();
      seg.push([i, clampV(a), clampV(b)]);
    });
    flush();
    if (d) svgEl('path', { d, class: 'band-area' }, svg).style.setProperty('fill', spec.band.color);
  }

  // ---- marks
  const marks = svgEl('g', { class: 'marks' }, svg);
  const columns = []; // per-index groups for hover emphasis

  if (spec.type === 'bar') {
    const bw = Math.min(24, Math.max(1, step * 0.74));
    const s = spec.series[0];
    data.forEach((d, i) => {
      const g = svgEl('g', { class: 'col' }, marks);
      columns.push(g);
      const v = s.value(d);
      if (v == null || v === 0) return;
      const top = y(Math.max(v, lo));
      const h = Math.max(1, y(lo) - top);
      const p = svgEl('path', { d: roundedTop(cx(i) - bw / 2, y(lo) - h, bw, h, 4), class: 'mark' }, g);
      p.style.setProperty('fill', spec.colorFor ? spec.colorFor(d) : s.color);
    });
  }

  if (spec.type === 'stack') {
    const bw = Math.min(24, Math.max(1, step * 0.74));
    data.forEach((d, i) => {
      const g = svgEl('g', { class: 'col' }, marks);
      columns.push(g);
      let acc = 0;
      const vals = spec.series.map((s) => s.value(d) || 0);
      const topIdx = vals.reduce((t, v, k) => (v > 0 ? k : t), -1);
      vals.forEach((v, k) => {
        if (v <= 0) return;
        const yTop = y(acc + v);
        let yBot = y(acc);
        if (acc > 0) yBot -= GAP;
        acc += v;
        const h = yBot - yTop;
        if (h < 0.5) return;
        const x = cx(i) - bw / 2;
        const shape =
          k === topIdx
            ? svgEl('path', { d: roundedTop(x, yTop, bw, h, 4), class: 'mark' }, g)
            : svgEl('rect', { x, y: yTop, width: bw, height: h, class: 'mark' }, g);
        shape.style.setProperty('fill', spec.series[k].color);
      });
    });
    // direct labels beside the most recent column
    const lastIdx = data.findLastIndex((d) => spec.series.some((s) => (s.value(d) || 0) > 0));
    if (lastIdx >= 0) {
      let acc = 0;
      let lastY = Infinity;
      const lg = svgEl('g', { class: 'direct-labels' }, svg);
      spec.series.forEach((s) => {
        const v = s.value(data[lastIdx]) || 0;
        const mid = y(acc + v / 2);
        const h = y(acc) - y(acc + v);
        acc += v;
        if (h < 12 || lastY - mid < 12) return;
        lastY = mid;
        svgEl('text', { x: m.left + pw + 8, y: mid, dy: '0.32em', class: 'end-label' }, lg).textContent = s.short || s.label;
      });
    }
  }

  const endLabels = [];
  if (spec.type === 'line') {
    spec.series.forEach((s) => {
      let d = '';
      let run = 0;
      const pts = [];
      data.forEach((row, i) => {
        const v = s.value(row);
        if (v == null) {
          run = 0;
          return;
        }
        d += `${run === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
        run += 1;
        pts.push([i, v, run]);
      });
      const path = svgEl('path', { d, class: 'line' }, marks);
      path.style.setProperty('stroke', s.color);
      // dots: every point on short ranges, plus isolated points that have no segment
      pts.forEach(([i, v], k) => {
        const isolated = (k === 0 || pts[k - 1][0] !== i - 1) && (k === pts.length - 1 || pts[k + 1][0] !== i + 1);
        if (n <= 14 || isolated) {
          const c = svgEl('circle', { cx: cx(i), cy: y(v), r: 3, class: 'dot' }, marks);
          c.style.setProperty('fill', s.color);
        }
      });
      const last = pts[pts.length - 1];
      if (last) {
        const c = svgEl('circle', { cx: cx(last[0]), cy: y(last[1]), r: 4, class: 'end-dot' }, marks);
        c.style.setProperty('fill', s.color);
        endLabels.push({ x: cx(last[0]) + 9, y: y(last[1]), text: fmtY(last[1]) });
      }
    });
  }

  // ---- trendlines (dashed, with a surface halo so they read over the data)
  if (spec.trend !== false) {
    const tg = svgEl('g', { class: 'trends' }, svg);
    const clampY = (v) => Math.max(m.top, Math.min(m.top + ph, y(v)));
    for (const t of trendLines(spec)) {
      const d = `M${cx(t.first).toFixed(1)},${clampY(t.intercept + t.slope * t.first).toFixed(1)}L${cx(t.last).toFixed(1)},${clampY(t.intercept + t.slope * t.last).toFixed(1)}`;
      svgEl('path', { d, class: 'trend-halo' }, tg);
      svgEl('path', { d, class: 'trend' }, tg).style.setProperty('stroke', spec.trendColors?.[t.label] || t.color);
    }
  }
  const placed = [];
  for (const l of endLabels) {
    if (placed.some((py) => Math.abs(py - l.y) < 12)) continue;
    placed.push(l.y);
    svgEl('text', { x: l.x, y: l.y, dy: '0.32em', class: 'end-label' }, svg).textContent = l.text;
  }

  // ---- hover layer
  const cross = svgEl('line', { x1: 0, x2: 0, y1: m.top, y2: m.top + ph, class: 'crosshair', visibility: 'hidden' }, svg);
  const hoverDots = spec.type === 'line'
    ? spec.series.map((s) => {
        const c = svgEl('circle', { r: 5, class: 'hover-dot', visibility: 'hidden' }, svg);
        c.style.setProperty('fill', s.color);
        return c;
      })
    : [];
  svgEl('rect', { x: m.left, y: m.top, width: pw, height: ph + m.bottom, class: 'hit' }, svg);

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  host.append(svg, tip);

  let active = -1;
  function show(i, pointerY) {
    active = i;
    const d = data[i];
    svg.classList.add('is-hover');
    columns.forEach((g, k) => g.classList.toggle('active', k === i));
    if (spec.type === 'line') {
      cross.setAttribute('x1', cx(i));
      cross.setAttribute('x2', cx(i));
      cross.setAttribute('visibility', 'visible');
      spec.series.forEach((s, k) => {
        const v = s.value(d);
        const dot = hoverDots[k];
        if (v == null) return dot.setAttribute('visibility', 'hidden');
        dot.setAttribute('cx', cx(i));
        dot.setAttribute('cy', y(v));
        dot.setAttribute('visibility', 'visible');
      });
    }
    fillTip(tip, spec.tooltip(d, i));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = cx(i) + 14;
    if (left + tw > width - 4) left = cx(i) - 14 - tw;
    left = Math.max(4, left);
    let top = (pointerY ?? m.top + 8) - th / 2;
    top = Math.max(0, Math.min(H - th, top));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hide() {
    active = -1;
    svg.classList.remove('is-hover');
    columns.forEach((g) => g.classList.remove('active'));
    cross.setAttribute('visibility', 'hidden');
    hoverDots.forEach((c) => c.setAttribute('visibility', 'hidden'));
    tip.hidden = true;
  }
  const indexAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor((clientX - r.left - m.left) / step)));
  };
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    show(indexAt(e.clientX), e.clientY - r.top);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(active >= 0 ? active : n - 1));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in moves) {
      e.preventDefault();
      show(Math.max(0, Math.min(n - 1, (active < 0 ? n - 1 : active) + moves[e.key])));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape') {
      hide();
    }
  });
}

// ---- calendar heatmap: one square per day, a column per week (Monday first), the most
// recent week on the right. spec: { days: [{ date, ... }], end: 'YYYY-MM-DD', weeks,
// category(day) -> { color, ... } | null, tooltip(day, category, date), ariaLabel }.
// Narrow hosts show fewer weeks instead of shrinking the squares below MIN_CELL.
const DAY_MS = 86_400_000;
const MIN_CELL = 9;
const MAX_CELL = 16;
const CELL_GAP = 3;
const isoOf = (t) => new Date(t).toISOString().slice(0, 10);

function drawCalendar(host, spec, width) {
  host.replaceChildren();
  host.classList.add('chart-host', 'is-calendar');
  const byDate = new Map(spec.days.map((d) => [d.date, d]));
  if (!spec.end || !spec.days.some((d) => spec.category(d))) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = spec.emptyText || 'No data in the last 12 months yet.';
    host.appendChild(empty);
    return;
  }

  const left = 30;
  const top = 18;
  const wanted = spec.weeks || 53;
  const avail = width - left - 4;
  const weeks = Math.max(4, Math.min(wanted, Math.floor((avail + CELL_GAP) / (MIN_CELL + CELL_GAP))));
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((avail + CELL_GAP) / weeks - CELL_GAP)));
  const pitch = cell + CELL_GAP;
  const gridW = weeks * pitch - CELL_GAP;
  const W = left + gridW + 4;
  const H = top + 7 * pitch - CELL_GAP + 4;

  const endT = Date.parse(`${spec.end}T00:00:00Z`);
  const weekday = (t) => (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const startT = endT - weekday(endT) * DAY_MS - (weeks - 1) * 7 * DAY_MS;
  const cells = [];
  for (let t = startT, i = 0; t <= endT; t += DAY_MS, i++) {
    const date = isoOf(t);
    const d = byDate.get(date) || null;
    cells.push({ date, t, col: Math.floor(i / 7), row: i % 7, d, cat: d ? spec.category(d) : null });
  }

  const svg = svgEl('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    tabindex: '0',
    'aria-label': `${spec.ariaLabel || 'Calendar'}. Use the arrow keys to move between days.`,
    class: 'chart chart-calendar',
  });

  // month labels on the column that holds the 1st, never closer than 3 columns apart
  const labels = svgEl('g', {}, svg);
  let lastCol = -10;
  for (const c of cells) {
    const isFirst = c.date.endsWith('-01');
    if (!isFirst && !(c.col === 0 && c.row === 0)) continue;
    if (c.col - lastCol < 3) continue;
    if (!isFirst && cells.some((o) => o.date.endsWith('-01') && o.col <= 2)) continue;
    lastCol = c.col;
    const name = new Date(c.t).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
    svgEl('text', { x: left + c.col * pitch, y: top - 6, class: 'tick' }, labels).textContent = name;
  }
  // weekday labels on Monday, Wednesday and Friday
  for (const row of [0, 2, 4]) {
    const name = new Date(Date.UTC(2024, 0, 1 + row)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
    svgEl('text', { x: left - 6, y: top + row * pitch + cell / 2, dy: '0.32em', 'text-anchor': 'end', class: 'tick' }, labels).textContent = name;
  }

  const g = svgEl('g', {}, svg);
  const radius = Math.min(3, cell / 4);
  for (const c of cells) {
    const r = svgEl('rect', {
      x: left + c.col * pitch + (c.cat ? 0 : 0.5),
      y: top + c.row * pitch + (c.cat ? 0 : 0.5),
      width: c.cat ? cell : cell - 1,
      height: c.cat ? cell : cell - 1,
      rx: radius,
      class: c.cat ? 'cal-cell' : 'cal-cell cal-empty',
    }, g);
    if (c.cat) r.style.setProperty('fill', c.cat.color);
  }
  const ring = svgEl('rect', { width: cell + 4, height: cell + 4, rx: radius + 1, class: 'cal-ring', visibility: 'hidden' }, svg);

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  host.append(svg, tip);
  if (weeks < wanted) {
    const note = document.createElement('p');
    note.className = 'cal-note';
    note.textContent = `Showing the last ${weeks} weeks. Show table has the full year.`;
    host.appendChild(note);
  }

  let active = -1;
  function show(i) {
    active = i;
    const c = cells[i];
    const x = left + c.col * pitch;
    const y = top + c.row * pitch;
    ring.setAttribute('x', x - 2);
    ring.setAttribute('y', y - 2);
    ring.setAttribute('visibility', 'visible');
    fillTip(tip, spec.tooltip(c.d, c.cat, c.date));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let tl = x + cell + 10;
    if (tl + tw > host.clientWidth - 4) tl = x - 10 - tw;
    tl = Math.max(4, tl);
    let tt = y + cell / 2 - th / 2;
    tt = Math.max(0, Math.min(H - th, tt));
    tip.style.left = `${tl}px`;
    tip.style.top = `${tt}px`;
  }
  function hide() {
    active = -1;
    ring.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  }
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left - left + CELL_GAP / 2) / pitch);
    const row = Math.floor((e.clientY - r.top - top + CELL_GAP / 2) / pitch);
    const i = col * 7 + row;
    if (col < 0 || row < 0 || row > 6 || i >= cells.length) return hide();
    if (i !== active) show(i);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(active >= 0 ? active : cells.length - 1));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const moves = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    if (e.key in moves) {
      e.preventDefault();
      const from = active < 0 ? cells.length - 1 : active;
      show(Math.max(0, Math.min(cells.length - 1, from + moves[e.key])));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : cells.length - 1);
    } else if (e.key === 'Escape') {
      hide();
    }
  });
}
