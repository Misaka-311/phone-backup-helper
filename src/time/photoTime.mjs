// 拍摄时间判定：文件名 → EXIF → 手机端 mtime，并给出"置信度"。
// 你的手机照片形如 IMG20260901181943_01.heic，文件名里就带着 yyyyMMddHHmmss。

import { readExifDate } from './exif.mjs';

const MIN_YEAR = 2000;
const MAX_YEAR = 2035;

export const CONFIDENCE = {
  FILENAME: 'filename',
  EXIF: 'exif',
  MTIME: 'mtime',
};

function validParts(y, mo, d, h, mi, s) {
  if (y < MIN_YEAR || y > MAX_YEAR) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  if (h > 23 || mi > 59 || s > 60) return false;
  const dt = new Date(y, mo - 1, d, h, mi, Math.min(s, 59));
  if (Number.isNaN(dt.getTime())) return false;
  // 排除 2 月 31 日这类"合法字段但非法日期"
  if (dt.getMonth() !== mo - 1) return false;
  return true;
}

function build(y, mo, d, h, mi, s) {
  return new Date(y, mo - 1, d, h, mi, Math.min(s, 59));
}

function from14(str) {
  const y = Number(str.slice(0, 4));
  const mo = Number(str.slice(4, 6));
  const d = Number(str.slice(6, 8));
  const h = Number(str.slice(8, 10));
  const mi = Number(str.slice(10, 12));
  const s = Number(str.slice(12, 14));
  return validParts(y, mo, d, h, mi, s) ? build(y, mo, d, h, mi, s) : null;
}

function from8and6(dateStr, timeStr) {
  return from14(dateStr + timeStr);
}

function fromEpochMs(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  const dt = new Date(n);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  return dt;
}

function fromEpochSec(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  return fromEpochMs(n * 1000);
}

const BOUND = '(?:^|[^0-9])';
const END = '(?:[^0-9]|$)';

/**
 * 从文件名推断拍摄时间。
 * @returns {{date: Date, confidence: string, basis: string}|null}
 */
export function parseFromName(name) {
  const stem = String(name || '').replace(/\.[^.\\/]+$/, '');
  if (!stem) return null;

  // 1) 连续 14 位：IMG20260901181943 / 微信图片_20261001...
  {
    const m = new RegExp(`${BOUND}(\\d{14})${END}`).exec(stem);
    if (m) {
      const d = from14(m[1]);
      if (d) return { date: d, confidence: CONFIDENCE.FILENAME, basis: 'name:yyyymmddhhmmss' };
    }
  }

  // 2) 8 位 + 6 位，用 - 或 _ 分隔：Screenshot_20261001_123456 / IMG_20261001_123456
  {
    const m = new RegExp(`${BOUND}(\\d{8})[_-](\\d{6})${END}`).exec(stem);
    if (m) {
      const d = from8and6(m[1], m[2]);
      if (d) return { date: d, confidence: CONFIDENCE.FILENAME, basis: 'name:yyyymmdd_hhmmss' };
    }
  }

  // 3) 毫秒时间戳：mmexport1727800000000
  {
    const m = new RegExp(`${BOUND}(\\d{13})${END}`).exec(stem);
    if (m) {
      const d = fromEpochMs(m[1]);
      if (d) return { date: d, confidence: CONFIDENCE.FILENAME, basis: 'name:epoch-ms' };
    }
  }

  // 4) 秒时间戳：1581689106
  {
    const m = new RegExp(`${BOUND}(\\d{10})${END}`).exec(stem);
    if (m) {
      const d = fromEpochSec(m[1]);
      if (d) return { date: d, confidence: CONFIDENCE.FILENAME, basis: 'name:epoch-s' };
    }
  }

  return null;
}

/**
 * 综合判定一张照片的拍摄时间。
 * @param {{name: string, mtimeMs: number, headBuffer?: Buffer|null}} input
 */
export function resolvePhotoTime({ name, mtimeMs, headBuffer = null }) {
  const byName = parseFromName(name);
  if (byName) return byName;

  if (headBuffer && headBuffer.length) {
    const exifDate = readExifDate(headBuffer);
    if (exifDate) {
      return { date: exifDate, confidence: CONFIDENCE.EXIF, basis: 'exif:DateTimeOriginal' };
    }
  }

  const ms = Number(mtimeMs);
  if (Number.isFinite(ms) && ms > 0) {
    return { date: new Date(ms), confidence: CONFIDENCE.MTIME, basis: 'phone-mtime' };
  }
  return null;
}

/** 该扩展名是否值得尝试读 EXIF（目前只支持 JPEG） */
export function exifableExtension(name) {
  return /\.(jpe?g|jfif)$/i.test(String(name || ''));
}
