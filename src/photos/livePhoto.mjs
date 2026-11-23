// 实况照片（Live Photo / 动态照片）识别。
//
// 判据（详见 live-photo-distinguish 技能）：实况的身份写在 XMP 元数据里，而视频是"追加在文件尾部"。
//   JPEG：XMP 在文件前部（APP1），读头部 128 KB 就够；
//   HEIC/AVIF：XMP 通常贴在文件尾部，必须再读末尾 64 KB，否则会全部漏判。
// 找到身份标记后，按元数据里的长度算出视频偏移，跳到那里读 8 字节确认是 `ftyp`，
// 才算"真的有视频"；算不出或对不上，就是"声明了但视频已被剥掉"（备份/转码常见）。
//
// 只读，绝不修改任何文件。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const HEAD_BYTES = 128 * 1024;
export const TAIL_BYTES = 64 * 1024;

/** 照片扩展名：只有这些才值得读文件头去判实况 */
export const PHOTO_EXTS = ['.jpg', '.jpeg', '.jfif', '.heic', '.heif', '.avif', '.png', '.webp'];
/** 旁挂式实况（苹果 / vivo 旧式）：同名 .MOV/.MP4 就是那段视频 */
export const PAIR_VIDEO_EXTS = ['.mov', '.mp4', '.m4v'];

/** 身份标记：命中任意一个，说明元数据声明了"文件里有动态视频" */
const XMP_MARKERS = [
  'OpCamera:VideoLength', // OPPO/一加/realme、抖音剪映导出
  'Item:Semantic="MotionPhoto"', // Google/小米新版/vivo/通用
  '<Camera:MotionPhoto>1',
  'MotionPhoto="1"', // 属性写法，三星等
  'MicroVideo="1"', // 小米旧版
  'MicroVideoOffset',
  'ContentIdentifier', // 苹果（视频是同名 .MOV，不在文件里）
];

/** ISO-BMFF 的 major brand 里这些是图片容器，不是视频 */
const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']);

export function isPhotoName(name) {
  return PHOTO_EXTS.includes(path.extname(String(name)).toLowerCase());
}

function bufIndex(hay, needle, from = 0) {
  return hay.indexOf(Buffer.from(needle, 'latin1'), from);
}

/** 找最后一个 Item:Length="N"（Container:Directory 里视频项固定排最后） */
function lastItemLength(buf) {
  const needle = Buffer.from('Item:Length="', 'latin1');
  let idx = buf.lastIndexOf(needle);
  while (idx !== -1) {
    const start = idx + needle.length;
    let end = start;
    while (end < buf.length && buf[end] >= 0x30 && buf[end] <= 0x39) end++;
    if (end > start) {
      const n = Number(buf.slice(start, end).toString('latin1'));
      if (Number.isFinite(n) && n > 0) return n;
    }
    idx = buf.lastIndexOf(needle, idx - 1);
  }
  return null;
}

/** 小米旧版的 MicroVideoOffset：视频长度（从文件末尾往前数） */
function microVideoOffset(buf) {
  const re = /MicroVideoOffset="?(\d+)/;
  const s = buf.toString('latin1');
  const m = re.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 华为/荣耀的尾标：文件最后有 `LIVE_<字节数>`，没有动态 XMP */
function huaweiTail(tail, size) {
  const s = tail.toString('latin1');
  const idx = s.lastIndexOf('LIVE_');
  if (idx === -1) return null;
  let end = idx + 5;
  let start = end;
  while (end < s.length && s[end] >= '0' && s[end] <= '9') end++;
  if (end === start) return null;
  const liveSize = Number(s.slice(start, end));
  if (!Number.isFinite(liveSize) || liveSize <= 0 || liveSize >= size) return null;
  return { liveSize, videoOffset: size - liveSize - 40, videoLength: liveSize - 20 };
}

function looksLikeFtyp(b) {
  return b.length >= 12 && b.slice(4, 8).toString('latin1') === 'ftyp';
}

/** 头部 EXIF 里出现华为/荣耀机型 → 值得再读一次尾部找 LIVE_ 尾标 */
const HUAWEI_RE = /HUAWEI|HONOR|华为|荣耀/i;

function needsHuaweiTail(head) {
  return HUAWEI_RE.test(head.toString('latin1'));
}

/**
 * 需不需要再读一次文件尾部：
 *  - HEIC/AVIF 这类 ISO-BMFF 图片：XMP 贴在尾部，必须读；
 *  - 头部出现华为/荣耀机型：视频信息和 LIVE_ 尾标在尾部，必须读。
 * 其它情况（普通 JPEG）只读头部就够，省掉一次随机读。
 */
export function shouldReadTail(head, size) {
  const headLen = head.length;
  if (size <= headLen) return false;
  return (looksLikeFtyp(head) && IMAGE_BRANDS.has(brandOf(head))) || needsHuaweiTail(head);
}

function brandOf(b) {
  return b.length >= 12 ? b.slice(8, 12).toString('latin1').trim().toLowerCase() : '';
}

/**
 * 纯字节判定（方便测试）：head/tail 是文件头尾切片，probe(offset,len) 用来做偏移校验。
 * 返回 { kind, marker, videoOffset, videoLength, engine }
 *   kind: 'live'            真有内嵌视频（已用 ftyp 校验）
 *         'paired'          旁挂式（苹果）：视频是另一个同名文件
 *         'declared-missing' 元数据声明了，但视频已不在文件里
 *         'none'            不是实况
 */
export function classifyBytes({ head, tail, size, paired = false, probe = null }) {
  if (!head || !head.length) return { kind: 'none', marker: null, engine: 'empty' };
  const tailBuf = tail && tail.length ? tail : Buffer.alloc(0);

  // ① ISO-BMFF（HEIC/AVIF/MP4）：XMP 常在尾部，必须把头尾拼起来找
  const isoBmff = looksLikeFtyp(head) && IMAGE_BRANDS.has(brandOf(head));
  const combined = isoBmff || tailBuf.length ? Buffer.concat([head, tailBuf]) : head;

  // ② 找身份标记
  let marker = null;
  for (const m of XMP_MARKERS) {
    if (bufIndex(combined, m) !== -1) {
      marker = m;
      break;
    }
  }

  if (!marker) {
    // ③ 没有 XMP：再看华为/荣耀的尾部标记（文件小到一次就读完时，"尾部"就在 head 里）
    const hayTail = tailBuf.length ? tailBuf : head.slice(Math.max(0, head.length - TAIL_BYTES));
    const hw = huaweiTail(hayTail, size);
    if (hw && hw.videoOffset > 0 && hw.videoOffset < size) {
      return { kind: 'live', marker: 'LIVE_', videoOffset: hw.videoOffset, videoLength: hw.videoLength, engine: 'huawei' };
    }
    return { kind: 'none', marker: null, engine: 'xmp' };
  }

  // ④ 苹果：视频是同名 .MOV，不在本文件里
  if (marker === 'ContentIdentifier') {
    return { kind: paired ? 'paired' : 'declared-missing', marker, engine: 'xmp' };
  }

  // ⑤ 算视频偏移：优先 MicroVideoOffset（小米旧版），否则用最后一个 Item:Length
  const len = microVideoOffset(combined) || lastItemLength(combined);
  if (!len || len >= size) {
    return { kind: 'declared-missing', marker, engine: 'xmp', declaredLength: len || null };
  }
  const offset = size - len;
  if (offset <= 0) return { kind: 'declared-missing', marker, engine: 'xmp', declaredLength: len };

  // ⑥ 有 probe 就读那 8 字节确认 ftyp —— 把"元数据声称"升级成"字节事实"
  if (typeof probe === 'function') {
    const sig = probe(offset, 12);
    if (!sig || !looksLikeFtyp(sig) || IMAGE_BRANDS.has(brandOf(sig))) {
      return { kind: 'declared-missing', marker, engine: 'xmp', declaredLength: len };
    }
  }
  return { kind: 'live', marker, videoOffset: offset, videoLength: len, engine: 'xmp' };
}

/* ------------------------------------------------------------------ */
/* 本地文件：直接随机读                                                */
/* ------------------------------------------------------------------ */

const cache = new Map();
const CACHE_MAX = 60000;

export function clearCache() {
  cache.clear();
}

/** 同目录下是否有同名视频（苹果 / vivo 旧式旁挂） */
export async function findPairedVideo(absPath) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const ext of PAIR_VIDEO_EXTS) {
    const hit = lower.get((base + ext).toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/**
 * 判定一个本地文件。size/mtime 相同则复用上次结果（同一次运行里反复对比不会重复读）。
 * @returns {Promise<{kind:string,marker:string|null,videoOffset?:number,videoLength?:number,pairedVideo?:string|null,ms?:number}>}
 */
export async function classifyLocalFile(absPath, { useCache = true } = {}) {
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch {
    return { kind: 'unknown', marker: null, reason: 'stat-failed' };
  }
  if (!st.isFile()) return { kind: 'unknown', marker: null, reason: 'not-file' };

  const key = `${absPath}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (useCache && cache.has(key)) return cache.get(key);

  const started = Date.now();
  const size = st.size;
  let fh = null;
  let result;
  try {
    fh = await fsp.open(absPath, 'r');
    const headLen = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) await fh.read(head, 0, headLen, 0);

    let tail = Buffer.alloc(0);
    if (shouldReadTail(head, size)) {
      const tailLen = Math.min(TAIL_BYTES, size - headLen);
      const start = size - tailLen;
      tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, start);
    }

    const pairedVideo = await findPairedVideo(absPath);
    result = classifyBytes({
      head,
      tail,
      size,
      paired: Boolean(pairedVideo),
      probe: (offset, len) => {
        const b = Buffer.alloc(len);
        const n = fs.readSync(fh.fd, b, 0, len, offset);
        return b.slice(0, n);
      },
    });
    if (pairedVideo) result.pairedVideo = pairedVideo;
    result.ms = Date.now() - started;
  } catch (err) {
    result = { kind: 'unknown', marker: null, reason: err.message };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }

  if (useCache) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, result);
  }
  return result;
}

/** 批量判定（并发，默认 8） */
export async function classifyManyFiles(absPaths, { concurrency = 8, onProgress = null } = {}) {
  const out = new Map();
  let done = 0;
  let i = 0;
  const workers = new Array(Math.min(concurrency, Math.max(1, absPaths.length))).fill(0).map(async () => {
    for (;;) {
      const idx = i++;
      if (idx >= absPaths.length) return;
      const p = absPaths[idx];
      out.set(p, await classifyLocalFile(p));
      done++;
      if (onProgress) onProgress(done, absPaths.length);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 给人看的一句话（控制台 / 界面都用它） */
export function describeKind(kind) {
  switch (kind) {
    case 'live':
      return '实况（有视频）';
    case 'paired':
      return '实况（同名视频）';
    case 'declared-missing':
      return '实况（视频已丢）';
    case 'none':
      return '普通照片';
    default:
      return '未识别';
  }
}
