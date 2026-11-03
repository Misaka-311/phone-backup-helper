// 显示宽度感知的表格/格式化工具（中文占两列，保证在 Windows 控制台里对得齐）

const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
];

function isWide(cp) {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x200b || cp === 0xfeff) return 0;
  return isWide(cp) ? 2 : 1;
}

export function strWidth(s) {
  if (!s) return 0;
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch);
  return w;
}

export function padEnd(s, width, fill = ' ') {
  const str = String(s ?? '');
  const need = width - strWidth(str);
  return need > 0 ? str + fill.repeat(need) : str;
}

export function padStart(s, width, fill = ' ') {
  const str = String(s ?? '');
  const need = width - strWidth(str);
  return need > 0 ? fill.repeat(need) + str : str;
}

export function truncate(s, width, ellipsis = '…') {
  const str = String(s ?? '');
  if (strWidth(str) <= width) return str;
  const ell = strWidth(ellipsis);
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch);
    if (w + cw + ell > width) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

export function table(headers, rows, options = {}) {
  const align = options.align || [];
  const widths = headers.map((h, i) => {
    let w = strWidth(h);
    for (const r of rows) w = Math.max(w, strWidth(r[i] ?? ''));
    return w;
  });
  const line = (cells) =>
    cells
      .map((c, i) => (align[i] === 'right' ? padStart(c, widths[i]) : padEnd(c, widths[i])))
      .join('  ')
      .replace(/\s+$/, '');
  const out = [line(headers), widths.map((w) => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r.map((c) => String(c ?? ''))));
  return out.join('\n');
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const p2 = (n) => String(n).padStart(2, '0');

export function formatDay(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function formatDateTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '-';
  return `${formatDay(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function formatTime(ms) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m} 分 ${rest} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
