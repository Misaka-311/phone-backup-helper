// 给"对比结果里的文件"补上实况照片标记。
//
// 三种来源能力不同，处理方式也不同：
//   本地文件夹  → 直接随机读文件头尾（最快，一次扫描毫秒级判完上千张）
//   adb 手机    → 用 dd 只读头尾几 KB（会多几次 adb 调用，手机慢一点，可选）
//   MTP 手机    → 文件必须整份复制才能读，扫描阶段判不了，等导入落盘后再补判
// 判不出来就标 'unknown'，绝不影响备份本身。

import { classifyBytes, classifyManyFiles, isPhotoName, shouldReadTail, HEAD_BYTES, TAIL_BYTES, PAIR_VIDEO_EXTS } from './livePhoto.mjs';

import path from 'node:path';

function pairKey(dirRemote, name) {
  return `${String(dirRemote).replace(/\\/g, '/').toLowerCase()}|${path.basename(String(name), path.extname(String(name))).toLowerCase()}`;
}

/** 在本次列出的文件里找同名视频（苹果 / vivo 旧式旁挂实况） */
function buildPairIndex(items) {
  const idx = new Map();
  for (const it of items) {
    const ext = path.extname(String(it.name)).toLowerCase();
    if (!PAIR_VIDEO_EXTS.includes(ext)) continue;
    const dir = String(it.remote).replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    idx.set(pairKey(dir, it.name), it);
  }
  return idx;
}

function dirOfRemote(remote) {
  return String(remote).replace(/\\/g, '/').split('/').slice(0, -1).join('/');
}

function slim(result, pairedItem) {
  const out = { kind: result.kind, marker: result.marker || null };
  if (result.videoOffset) out.videoOffset = result.videoOffset;
  if (result.videoLength) out.videoLength = result.videoLength;
  if (result.engine) out.engine = result.engine;
  if (pairedItem) out.pairedName = pairedItem.name;
  return out;
}

/**
 * 就地给 items 加上 item.live。
 * @returns {Promise<{supported:boolean, transport:string, counted:number, ms:number}>}
 */
export async function annotateLivePhotos({ items, source, log = null, concurrency = 8, onProgress = null }) {
  const photos = items.filter((it) => isPhotoName(it.name));
  const started = Date.now();
  const pairIndex = buildPairIndex(items);

  const pairedOf = (item) => pairIndex.get(pairKey(dirOfRemote(item.remote), item.name)) || null;

  if (typeof source?.localPathOf === 'function') {
    const paths = photos.map((it) => source.localPathOf(it.remote));
    const map = await classifyManyFiles(paths, { concurrency, onProgress });
    photos.forEach((item, i) => {
      const r = map.get(paths[i]) || { kind: 'unknown' };
      item.live = slim(r, pairedOf(item));
      if (r.pairedVideo) item.live.pairedPath = r.pairedVideo;
    });
    const res = { supported: true, transport: 'local', counted: photos.length, ms: Date.now() - started };
    if (log && photos.length) log.info(`实况识别：看了 ${photos.length} 张照片，用时 ${res.ms} ms`);
    return res;
  }

  if (typeof source?.readRange === 'function') {
    let done = 0;
    const queue = photos.slice();
    const workers = new Array(Math.min(concurrency, Math.max(1, queue.length))).fill(0).map(async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        item.live = await classifyRemoteItem(source, item, pairedOf(item));
        done += 1;
        if (onProgress) onProgress(done, photos.length);
      }
    });
    await Promise.all(workers);
    const res = { supported: true, transport: 'remote', counted: photos.length, ms: Date.now() - started };
    if (log && photos.length) log.info(`实况识别：看了 ${photos.length} 张照片，用时 ${res.ms} ms`);
    return res;
  }

  for (const item of photos) {
    item.live = { kind: 'unknown', marker: null, reason: '这条通道读不了文件头（MTP），导入落盘后再判' };
  }
  return { supported: false, transport: 'unsupported', counted: 0, ms: Date.now() - started };
}

async function classifyRemoteItem(source, item, pairedItem) {
  const size = Number(item.size) || 0;
  if (!size) return { kind: 'unknown', marker: null, reason: '没有文件大小' };
  try {
    const headLen = Math.min(HEAD_BYTES, size);
    const head = await source.readRange(item.remote, 0, headLen);
    if (!head || !head.length) return { kind: 'unknown', marker: null, reason: '读不到文件头' };
    let tail = Buffer.alloc(0);
    if (shouldReadTail(head, size)) {
      const tailLen = Math.min(TAIL_BYTES, size - headLen);
      if (tailLen > 0) tail = await source.readRange(item.remote, size - tailLen, tailLen);
    }
    const first = classifyBytes({ head, tail, size, paired: Boolean(pairedItem) });
    if (first.kind === 'live' && first.videoOffset) {
      const sig = await source.readRange(item.remote, first.videoOffset, 12);
      const verified = classifyBytes({ head, tail, size, paired: Boolean(pairedItem), probe: () => sig });
      return slim(verified, pairedItem);
    }
    return slim(first, pairedItem);
  } catch (err) {
    return { kind: 'unknown', marker: null, reason: err.message };
  }
}

/** 汇总一批 items 的实况情况（界面上的那行字用它） */
export function liveSummary(items) {
  const s = { live: 0, paired: 0, declaredMissing: 0, none: 0, unknown: 0, checked: 0 };
  for (const it of items) {
    const k = it.live?.kind;
    if (!k) continue;
    s.checked += 1;
    if (k === 'live') s.live += 1;
    else if (k === 'paired') s.paired += 1;
    else if (k === 'declared-missing') s.declaredMissing += 1;
    else if (k === 'none') s.none += 1;
    else s.unknown += 1;
  }
  return s;
}

/** 导入落盘之后补判（MTP 通道靠这个） */
export async function classifyImportedOnDisk(items, { concurrency = 8 } = {}) {
  const withPath = items.filter((it) => it.localPath && isPhotoName(it.name));
  if (!withPath.length) return liveSummary(items);
  const map = await classifyManyFiles(withPath.map((it) => it.localPath), { concurrency });
  for (const it of withPath) {
    const r = map.get(it.localPath);
    if (r) it.live = { kind: r.kind, marker: r.marker || null, checkedAfterImport: true, pairedName: r.pairedVideo ? path.basename(r.pairedVideo) : undefined };
  }
  return liveSummary(items);
}
