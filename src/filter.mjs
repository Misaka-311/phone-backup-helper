// 筛选规则：日期区间 + 扩展名 + 路径前缀 + 文件名通配 + "时间不确定"处置

import { formatDay } from './util/format.mjs';

const RANGE_HINT = '日期要写成 2026-10-01 这种格式（年-月-日）';

export function parseDateBoundary(value, { which = '日期' } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (!s || s.toLowerCase() === 'null' || s === '-') return null;
  const m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/.exec(s);
  if (!m) {
    throw new Error(`${which}「${s}」看不懂。${RANGE_HINT}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3] || 1);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new Error(`${which}「${s}」超出合理范围。${RANGE_HINT}`);
  }
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (dt.getMonth() !== mo - 1) {
    throw new Error(`${which}「${s}」不是有效日期。${RANGE_HINT}`);
  }
  return dt;
}

/** --years 2027 或 --years 2026,2027 → 区间 */
export function rangeFromYears(value) {
  const parts = String(value)
    .split(/[,\s，]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 1990 && n <= 2100)
    .sort((a, b) => a - b);
  if (!parts.length) throw new Error(`年份「${value}」看不懂，示例：--years 2027`);
  const since = new Date(parts[0], 0, 1, 0, 0, 0, 0);
  const until = new Date(parts[parts.length - 1] + 1, 0, 1, 0, 0, 0, 0);
  return { since, until, label: parts.join('、') + ' 年' };
}

export function globToRegExp(glob) {
  const s = String(glob).replace(/\\/g, '/');
  let re = '^';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') {
        re += '.*';
        i++;
        if (s[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re, 'i');
}

export function normalizeExtList(list) {
  if (!list) return null;
  const arr = Array.isArray(list) ? list : String(list).split(/[,\s;，]+/);
  const out = arr
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)
    .map((x) => (x.startsWith('.') ? x : `.${x}`));
  return out.length ? new Set(out) : null;
}

/**
 * 构造 filter。
 * @param {object} opts
 * @param {Date|null} opts.since 含
 * @param {Date|null} opts.until 不含
 * @param {string[]|null} opts.includeExt
 * @param {number} opts.minSizeBytes
 * @param {string[]} opts.pathPrefixes 只处理这些相对路径开头
 * @param {string|RegExp|null} opts.nameGlob
 * @param {boolean} opts.excludeUncertain 排除仅凭 mtime 判定的文件
 */
export function makeFilter(opts = {}) {
  const since = opts.since || null;
  const until = opts.until || null;
  const extSet = normalizeExtList(opts.includeExt);
  const minSize = Number.isFinite(opts.minSizeBytes) ? opts.minSizeBytes : 0;
  const prefixes = (opts.pathPrefixes || []).map((p) => String(p).replace(/\\/g, '/').replace(/^\/+/, ''));
  const nameRe =
    opts.nameGlob instanceof RegExp
      ? opts.nameGlob
      : opts.nameGlob
        ? globToRegExp(opts.nameGlob)
        : null;
  const excludeUncertain = Boolean(opts.excludeUncertain);

  function check(file) {
    const name = String(file.name || '');
    const rel = String(file.relPath || '').replace(/\\/g, '/');

    if (extSet) {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (!extSet.has(ext)) return { ok: false, code: 'ext', reason: `扩展名 ${ext || '(无)'} 不在范围` };
    }

    if (minSize > 0 && Number(file.size) < minSize) {
      return { ok: false, code: 'small', reason: `小于 ${minSize} 字节` };
    }

    if (prefixes.length) {
      const hit = prefixes.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`));
      if (!hit) return { ok: false, code: 'path', reason: '不在指定目录范围' };
    }

    if (nameRe && !nameRe.test(name)) {
      return { ok: false, code: 'glob', reason: '文件名不符合通配规则' };
    }

    const date = file.date instanceof Date ? file.date : file.date ? new Date(file.date) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return { ok: false, code: 'nodate', reason: '无法判定拍摄时间' };
    }

    if (excludeUncertain && file.confidence === 'mtime') {
      return { ok: false, code: 'uncertain', reason: '时间只能靠修改时间推测（已排除）' };
    }

    if (since && date.getTime() < since.getTime()) {
      return { ok: false, code: 'before', reason: `拍摄于 ${formatDay(date)}，早于起始` };
    }
    if (until && date.getTime() >= until.getTime()) {
      return { ok: false, code: 'after', reason: `拍摄于 ${formatDay(date)}，晚于结束` };
    }

    return { ok: true };
  }

  function describe() {
    if (!since && !until) return '不限时间（手机里所有还没同步过的都会处理）';
    const fmt = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '不限');
    if (since && until) return `拍摄时间 >= ${fmt(since)} 且 < ${fmt(until)}`;
    if (since) return `拍摄时间 >= ${fmt(since)}`;
    return `拍摄时间 < ${fmt(until)}`;
  }

  return { check, describe, since, until, excludeUncertain };
}
