// 生成"这次的待办清单"：决定哪些要复制、哪些要上传、哪些跳过、为什么跳过。
//
// 目标可以是三种组合：
//   {disk:true,  cloud:false}  只导硬盘
//   {disk:false, cloud:true}   只传 123 云盘（不落硬盘）
//   {disk:true,  cloud:true}   两边都要
//
// 一个文件是否"已经做完"，取决于你这次要什么：
//   - 要硬盘：状态库里 onDisk=true 且大小一致才算做完
//   - 要云盘：状态库里有 cloudFileID 才算做完（handoff 模式下由落盘代表上云）

import fs from 'node:fs';
import path from 'node:path';
import { recordKey } from './state.mjs';
import { formatDay } from './util/format.mjs';

export const SKIP_LABELS = {
  ext: '扩展名不在范围',
  small: '文件太小',
  path: '不在指定目录',
  glob: '文件名不符',
  nodate: '无法判定时间',
  uncertain: '时间不确定（已排除）',
  before: '早于起始日期',
  after: '晚于结束日期',
  'already-synced': '上次已同步',
  exists: '硬盘已存在',
  conflict: '同名不同内容',
  'same-name': '目标里已有同名文件',
  'cloud-done': '云盘已有',
};

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function uniquePath(basePath) {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法为 ${basePath} 找到可用文件名`);
}

/**
 * @param {object} params
 * @param {Array} params.items 展平后的文件条目
 * @param {object} params.filter makeFilter() 的返回值
 * @param {import('./state.mjs').StateStore} params.state
 * @param {object} params.cfg 配置
 * @param {{disk: boolean, cloud: boolean}} params.targets 这次要哪个目标
 */
export function buildPlan({ items, filter, state, cfg, targets = { disk: true, cloud: true } }) {
  const root = cfg.local.root;
  const collision = cfg.local.collision || 'skip';
  const cloudMode = (cfg.cloud && cfg.cloud.mode) || 'off';
  const wantDisk = targets.disk !== false;
  const wantCloud = targets.cloud !== false && cloudMode !== 'off';

  const copy = [];
  const skip = [];
  const conflicts = [];

  for (const item of items) {
    // 目标里已经有同名文件 → 直接跳过（最优先，连时间都不用判）
    if (item.dupName) {
      skip.push({ ...item, code: 'same-name', reason: '目标里已有同名文件' });
      continue;
    }

    const verdict = filter.check(item);
    if (!verdict.ok) {
      skip.push({ ...item, code: verdict.code, reason: verdict.reason });
      continue;
    }

    const key = recordKey(item.sourceId, item.remote);
    const rec = state.getRecord(key);
    const sizeOk = rec && Number(rec.size) === Number(item.size);

    const targetPath0 = path.join(root, item.targetSubdir, ...String(item.relPath).split('/'));
    let targetPath = targetPath0;
    let renamed = false;
    let needDisk = wantDisk;
    let needCloud = wantCloud;
    let adopted = false;

    if (sizeOk) {
      const diskDone = !wantDisk || rec.onDisk !== false;
      // handoff 模式没有独立的云端记录，落盘即视为已交管
      const cloudDone =
        !wantCloud || Boolean(rec.cloudFileID) || (cloudMode === 'handoff' && rec.onDisk !== false);
      if (diskDone && cloudDone) {
        skip.push({ ...item, code: 'already-synced', reason: '上次已同步', key });
        continue;
      }
      needDisk = wantDisk && !diskDone;
      needCloud = wantCloud && !cloudDone;
    }

    if (needDisk) {
      const st = statSafe(targetPath);
      if (st && st.isFile()) {
        if (Number(st.size) === Number(item.size)) {
          // 硬盘上已经有了：记一笔，不用重拷（外部拷进来的也能被认领）
          state.setRecord(key, {
            ...(rec || {}),
            size: item.size,
            mtimeMs: item.mtimeMs,
            takenAt: item.date ? item.date.toISOString() : null,
            confidence: item.confidence,
            localPath: targetPath,
            onDisk: true,
            adopted: true,
          });
          needDisk = false;
          adopted = true;
        } else if (collision === 'rename') {
          targetPath = uniquePath(targetPath);
          renamed = true;
        } else {
          conflicts.push({ ...item, targetPath });
          skip.push({ ...item, code: 'conflict', reason: '同名不同内容', key, targetPath });
          continue;
        }
      }
    }

    if (!needDisk && !needCloud) {
      skip.push({
        ...item,
        code: adopted ? 'exists' : 'cloud-done',
        reason: adopted ? '硬盘已存在' : '目标都已满足',
        key,
        targetPath,
      });
      continue;
    }

    copy.push({ ...item, key, targetPath, renamed, needDisk, needCloud });
  }

  copy.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));

  return { copy, skip, conflicts, root };
}

export function summarize(plan, sources, targets = { disk: true, cloud: true }) {
  const bySource = new Map();
  for (const s of sources) {
    bySource.set(s.id, {
      id: s.id,
      remote: s.remote,
      targetSubdir: s.targetSubdir,
      dir: `${plan.root}\\${s.targetSubdir}`,
      add: 0,
      addBytes: 0,
      skip: 0,
    });
  }
  for (const item of plan.copy) {
    const slot = bySource.get(item.sourceId);
    if (slot) {
      slot.add += 1;
      slot.addBytes += Number(item.size) || 0;
    }
  }
  for (const item of plan.skip) {
    const slot = bySource.get(item.sourceId);
    if (slot) slot.skip += 1;
  }

  const byDay = new Map();
  const byConfidence = { filename: 0, exif: 0, mtime: 0 };
  let totalBytes = 0;
  let toDisk = 0;
  let toCloud = 0;
  for (const item of plan.copy) {
    const day = item.date ? formatDay(item.date) : '未知';
    byDay.set(day, (byDay.get(day) || 0) + 1);
    totalBytes += Number(item.size) || 0;
    if (item.needDisk) toDisk += 1;
    if (item.needCloud) toCloud += 1;
    if (byConfidence[item.confidence] !== undefined) byConfidence[item.confidence] += 1;
  }

  const skipByCode = new Map();
  for (const item of plan.skip) {
    skipByCode.set(item.code, (skipByCode.get(item.code) || 0) + 1);
  }

  return {
    sources: [...bySource.values()],
    byDay: new Map([...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    byConfidence,
    skipByCode,
    count: plan.copy.length,
    bytes: totalBytes,
    skipped: plan.skip.length,
    conflicts: plan.conflicts.length,
    toDisk,
    toCloud,
    targets,
  };
}
