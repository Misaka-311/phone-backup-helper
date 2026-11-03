// 界面与 CLI 共用的流程：扫手机目录 → 生成计划 → 导入选中的文件 → 把本次导入的导出到别处
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildSource } from './sources/source.mjs';
import { collectItems, resolveUnknownDates, executePlan } from './sync.mjs';
import { makeFilter } from './filter.mjs';
import { buildPlan, summarize } from './plan.mjs';
import { recordKey } from './state.mjs';

/** 手机上值得备份的父目录（逐个展开成子文件夹） */
export const PHONE_PARENTS = ['/sdcard/DCIM', '/sdcard/Pictures', '/sdcard/Movies', '/sdcard/Download'];

const sum = (arr, f) => arr.reduce((a, b) => a + (Number(f(b)) || 0), 0);

/** 递归取某个本地目录下的文件（限深度），用于"来源是硬盘"时统计 */
async function walkLocalFiles(dir, depth = 2) {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) out.push(...(await walkLocalFiles(full, depth - 1)));
    } else if (e.isFile()) {
      try {
        const st = await fsp.stat(full);
        out.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs, path: full });
      } catch {
        /* 跳过读不了的 */
      }
    }
  }
  return out;
}

/**
 * 来源是"某块硬盘上的一个文件夹"时，列出它下面的一级文件夹（带文件数、体积、文件名样本）。
 * 文件名样本用来做"名字不同但内容可能相同"的智能建议。
 */
export async function listFolderSource({ root, maxNames = 400 }) {
  const base = path.resolve(root);
  let entries = [];
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch (err) {
    throw new Error(`读不了这个文件夹：${base}（${err.code || err.message}）`);
  }

  const out = [];
  const loose = entries.filter((e) => e.isFile());
  if (loose.length) {
    const files = await walkLocalFiles(base, 0);
    out.push({
      path: '/',
      name: '（根目录散放的文件）',
      loose: true,
      count: loose.length,
      bytes: sum(files, (f) => f.size),
      names: loose.slice(0, maxNames).map((e) => e.name),
    });
  }

  for (const d of entries.filter((e) => e.isDirectory())) {
    if (d.name.startsWith('$') || d.name === 'System Volume Information') continue;
    const files = await walkLocalFiles(path.join(base, d.name), 2);
    out.push({
      path: `/${d.name}`,
      name: d.name,
      loose: false,
      count: files.length,
      bytes: sum(files, (f) => f.size),
      names: files.slice(0, maxNames).map((f) => f.name),
    });
  }

  out.sort((a, b) => b.count - a.count);
  return out;
}

/**
 * 列出手机侧的可备份目录（带文件数、体积），给界面做"对应到硬盘哪文件夹"的选项。
 */
export async function listPhoneDirs({ source, parents = PHONE_PARENTS, onProgress = null, maxNames = 400 }) {
  const dirs = [];
  let scanned = 0;

  for (const parent of parents) {
    let entries = [];
    try {
      entries = source.listEntries ? await source.listEntries(parent) : await source.list(parent);
    } catch {
      continue;
    }

    const looseFiles = entries.filter((e) => !e.isDir);
    if (looseFiles.length) {
      dirs.push({
        remote: parent,
        path: parent,
        name: `${path.posix.basename(parent)}（散放的文件）`,
        parent: path.posix.dirname(parent),
        loose: true,
        count: looseFiles.length,
        bytes: sum(looseFiles, (f) => f.size),
        latestMs: Math.max(0, ...looseFiles.map((f) => f.mtimeMs || 0)),
        names: looseFiles.slice(0, maxNames).map((f) => f.name),
      });
    }

    for (const e of entries.filter((x) => x.isDir)) {
      const remote = `${parent}/${e.name}`;
      let files = [];
      try {
        files = source.listEntries ? await source.listEntries(remote) : await source.list(remote);
      } catch {
        files = [];
      }
      const onlyFiles = files.filter((f) => !f.isDir);
      dirs.push({
        remote,
        path: remote,
        name: e.name,
        parent,
        loose: false,
        count: onlyFiles.length,
        bytes: sum(onlyFiles, (f) => f.size),
        latestMs: Math.max(0, ...onlyFiles.map((f) => f.mtimeMs || 0)),
        names: onlyFiles.slice(0, maxNames).map((f) => f.name),
      });
      scanned += 1;
      if (onProgress) onProgress({ scanned, total: null, name: remote });
    }
  }

  dirs.sort((a, b) => b.count - a.count);
  return dirs;
}

const SKIP_DIR_NAME = (n) => String(n).startsWith('$') || n === 'System Volume Information';

/** 找一个不冲突的文件名：xxx (2).jpg、xxx (3).jpg … */
async function uniquePath(basePath) {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    const hit = await fsp.stat(candidate).catch(() => null);
    if (!hit) return candidate;
  }
  throw new Error(`无法为 ${basePath} 找到可用文件名`);
}

/** 递归收集某个目录下的所有文件名（小写），用来判断"同名文件是否已存在" */
async function collectNames(dir, { maxDepth = 3, cap = 100000 } = {}) {
  const names = new Set();
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile()) {
        names.add(e.name.toLowerCase());
        if (names.size >= cap) return names;
      } else if (e.isDirectory() && depth < maxDepth) {
        stack.push({ d: path.join(d, e.name), depth: depth + 1 });
      }
    }
  }
  return names;
}

/**
 * 来源目录树：大文件夹（group）→ 小文件夹（children）。
 * 界面用它做"分栏 + 每个小文件夹单独对应"。
 * 只有 children 参与对应；group 只是分类标题，避免同一批文件被映射两次。
 */
export async function listSourceTree({ source, kind, root, maxNames = 300 }) {
  if (kind === 'folder') return listFolderTree({ root, maxNames });
  return listPhoneTree({ source, maxNames });
}

async function listPhoneTree({ source, maxNames }) {
  const groups = [];
  for (const parent of PHONE_PARENTS) {
    let entries = [];
    try {
      entries = source.listEntries ? await source.listEntries(parent) : await source.list(parent);
    } catch {
      continue;
    }
    const children = [];

    const loose = entries.filter((e) => !e.isDir);
    if (loose.length) {
      children.push({
        path: parent,
        name: '（散放的文件）',
        parent: path.posix.basename(parent),
        loose: true,
        depth: 0,
        count: loose.length,
        bytes: sum(loose, (f) => f.size),
        names: loose.slice(0, maxNames).map((f) => f.name),
      });
    }

    for (const e of entries.filter((x) => x.isDir)) {
      const remote = `${parent}/${e.name}`;
      let files = [];
      try {
        files = source.listEntries ? await source.listEntries(remote) : await source.list(remote);
      } catch {
        files = [];
      }
      const only = files.filter((f) => !f.isDir);
      children.push({
        path: remote,
        name: e.name,
        parent: path.posix.basename(parent),
        count: only.length,
        bytes: sum(only, (f) => f.size),
        names: only.slice(0, maxNames).map((f) => f.name),
      });
    }

    groups.push({
      name: path.posix.basename(parent),
      path: parent,
      count: sum(children, (c) => c.count),
      children,
    });
  }
  return { kind: 'phone', root: '/sdcard', groups };
}

/** 递归数文件（只数，不 stat，快），返回 {count, names}；names 取前 maxNames 个用于比内容 */
async function countTree(dir, { maxDepth = 3, cap = 200000, maxNames = 300 } = {}) {
  let count = 0;
  const names = [];
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile()) {
        count += 1;
        if (names.length < maxNames) names.push(e.name);
        if (count >= cap) return { count, names, capped: true };
      } else if (e.isDirectory() && depth < maxDepth) {
        stack.push({ d: path.join(d, e.name), depth: depth + 1 });
      }
    }
  }
  return { count, names, capped: false };
}

async function listFolderTree({ root, maxNames }) {
  const base = path.resolve(root);
  let top;
  try {
    top = await fsp.readdir(base, { withFileTypes: true });
  } catch (err) {
    throw new Error(`读不了这个文件夹：${base}（${err.code || err.message}）`);
  }

  const groups = [];
  for (const d of top.filter((e) => e.isDirectory() && !SKIP_DIR_NAME(e.name))) {
    const full = path.join(base, d.name);
    let subs = [];
    try {
      subs = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      subs = [];
    }

    const children = [];
    for (const s of subs.filter((e) => e.isDirectory())) {
      const r = await countTree(path.join(full, s.name), { maxNames });
      children.push({
        path: `/${d.name}/${s.name}`,
        name: s.name,
        parent: d.name,
        count: r.count,
        bytes: null,
        names: r.names,
      });
    }

    const loose = subs.filter((e) => e.isFile());
    if (loose.length) {
      children.push({
        path: `/${d.name}`,
        name: '（散放的文件）',
        parent: d.name,
        loose: true,
        depth: 0,
        count: loose.length,
        bytes: null,
        names: loose.slice(0, maxNames).map((e) => e.name),
      });
    }

    if (!children.length) {
      const r = await countTree(full, { maxNames });
      children.push({ path: `/${d.name}`, name: d.name, parent: d.name, self: true, count: r.count, bytes: null, names: r.names });
    }

    groups.push({ name: d.name, path: `/${d.name}`, count: sum(children, (c) => c.count), children });
  }

  groups.sort((a, b) => b.count - a.count);
  return { kind: 'folder', root: base, groups };
}

/**
 * 扫描：按用户给的"手机目录 → 硬盘文件夹"映射，算出每个文件夹里新增了哪些文件。
 * @returns {{cfg, source, items, plan, summary, filterDesc}}
 */
export async function scanAll({
  cfg,
  source,
  mapping,
  since = null,
  until = null,
  state,
  log,
  stagingDir,
  targets = { disk: true, cloud: true },
  extraFilter = {},
  includeExt,
  minSizeBytes,
}) {
  const sources = mapping
    .filter((m) => m && m.remote && m.enabled !== false)
    .map((m, i) => ({
      id: m.id || `src${i}`,
      remote: m.remote,
      targetSubdir: m.subdir || path.posix.basename(m.remote),
      maxDepth: Number.isFinite(m.depth) ? m.depth : undefined,
      enabled: true,
    }));

  const cfg2 = {
    ...cfg,
    phone: { ...cfg.phone, sources, enabledSources: sources },
  };

  const { items, sourceStatus } = await collectItems({ source, cfg: cfg2, log });
  const sourceErrors = (sourceStatus || [])
    .filter((s) => s.error)
    .map((s) => ({ remote: s.remote, error: s.error }));

  // 先把"目标里已经有同名文件"的标出来——同名的一律跳过，不再算新增
  const dupBySource = new Map();
  for (const s of sources) {
    const destDir = path.join(cfg2.local.root, ...String(s.targetSubdir).split(/[\\/]+/));
    const names = await collectNames(destDir);
    dupBySource.set(s.id, names);
  }
  for (const item of items) {
    const set = dupBySource.get(item.sourceId);
    if (set && set.size && set.has(String(item.name).toLowerCase())) item.dupName = true;
  }

  const filter = makeFilter({
    since,
    until,
    // includeExt 传 null 表示"不过滤扩展名（所有文件都要）"；传数组表示只要这些类型
    includeExt: includeExt !== undefined ? includeExt : cfg2.phone.includeExt,
    minSizeBytes: minSizeBytes !== undefined ? minSizeBytes : cfg2.phone.minSizeBytes,
    pathPrefixes: extraFilter.pathPrefixes || [],
    nameGlob: extraFilter.nameGlob || null,
    excludeUncertain: Boolean(extraFilter.excludeUncertain),
  });

  await resolveUnknownDates({ items, source, state, stagingDir, log });

  const plan = buildPlan({ items, filter, state, cfg: cfg2, targets });
  const summary = summarize(plan, sources, targets);

  // 每个文件夹的"对比"数字：源有多少、目标已有多少、新增多少
  const bySourceCount = new Map();
  for (const item of items) {
    const k = item.sourceId;
    bySourceCount.set(k, (bySourceCount.get(k) || 0) + 1);
  }
  const addBySource = new Map();
  const bytesBySource = new Map();
  for (const item of plan.copy) {
    addBySource.set(item.sourceId, (addBySource.get(item.sourceId) || 0) + 1);
    bytesBySource.set(item.sourceId, (bytesBySource.get(item.sourceId) || 0) + (Number(item.size) || 0));
  }

  const folderStats = [];
  for (const s of sources) {
    const destDir = path.join(cfg2.local.root, ...String(s.targetSubdir).split(/[\\/]+/));
    let destFiles = 0;
    try {
      const list = await fsp.readdir(destDir, { withFileTypes: true, recursive: false });
      destFiles = list.filter((x) => x.isFile()).length;
    } catch {
      destFiles = 0;
    }
    folderStats.push({
      sourceId: s.id,
      remote: s.remote,
      folder: s.targetSubdir,
      sourceCount: bySourceCount.get(s.id) || 0,
      destCount: destFiles,
      add: addBySource.get(s.id) || 0,
      addBytes: bytesBySource.get(s.id) || 0,
      destPath: destDir,
    });
  }

  return { cfg: cfg2, source, items, plan, summary, filterDesc: filter.describe(), sourceErrors, folderStats };
}

/** 只导入用户勾选的那些文件 */
export async function importSelected({
  cfg,
  source,
  state,
  planCopy,
  keys,
  targets,
  log,
  onProgress = null,
}) {
  const wanted = new Set(keys);
  const selected = planCopy.filter((i) => wanted.has(i.key));

  if (!selected.length) {
    return { stats: { copied: 0, uploaded: 0, reuse: 0, uploadedFailed: 0, handoff: 0, failures: [] }, batchId: null, count: 0 };
  }

  const plan = { copy: selected, skip: [], conflicts: [], root: cfg.local.root };
  const stats = await executePlan({ plan, source, cfg, state, log, targets, onProgress });

  const batchId = `b${Date.now().toString(36)}`;
  const at = new Date().toISOString();
  const doneKeys = [];
  for (const item of selected) {
    const rec = state.getRecord(item.key);
    if (rec && (rec.onDisk || rec.cloudFileID)) {
      state.setRecord(item.key, { ...rec, batchId, importedAt: at });
      doneKeys.push(item.key);
    }
  }

  const batch = {
    id: batchId,
    at,
    count: doneKeys.length,
    keys: doneKeys,
    root: cfg.local.root,
    targets,
  };
  state.addBatch(batch);
  await state.save();

  return { stats, batchId, count: doneKeys.length, batch };
}

/**
 * 把某批次新导入的文件，按原来的目录结构复制到指定文件夹，并保留原始时间。
 * 只读硬盘上的副本 → 复制一份到导出目录；不动原始文件、不动手机、不改批次记录。
 * 目标已有同名文件时：同名同大小 → 跳过；同名不同大小 → 自动加 (2)，绝不覆盖。
 */
export async function exportBatch({ cfg, state, batchId = null, destDir, onProgress = null }) {
  const batch = batchId ? state.getBatch(batchId) : state.listBatches(1)[0];
  if (!batch) throw new Error('没有找到可导出的批次（还没有导入过）');
  if (!destDir) throw new Error('请指定要导出到哪个文件夹');

  const dest = path.resolve(destDir);
  await fsp.mkdir(dest, { recursive: true });

  const copied = [];
  const skipped = [];
  const failed = [];
  const total = batch.keys.length;
  let seq = 0;

  for (const key of batch.keys) {
    seq += 1;
    const rec = state.getRecord(key);
    if (!rec || !rec.localPath || !fs.existsSync(rec.localPath)) {
      skipped.push({ key, reason: '源文件不存在（可能只传了云盘）' });
      continue;
    }
    try {
      const rel = path.relative(cfg.local.root, rec.localPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界，已拒绝');

      const srcStat = await fsp.stat(rec.localPath);
      let target = path.join(dest, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });

      // 目标已存在时：不覆盖
      const existed = await fsp.stat(target).catch(() => null);
      if (existed) {
        if (existed.size === srcStat.size) {
          skipped.push({ key, reason: '导出目录里已有同名同大小文件', to: target });
          continue;
        }
        target = await uniquePath(target);
      }

      const part = `${target}.part`;
      await fsp.copyFile(rec.localPath, part);
      const st = await fsp.stat(part);
      await fsp.rename(part, target);
      const when = new Date(st.mtimeMs);
      await fsp.utimes(target, when, when); // 保留原始时间
      copied.push({ from: rec.localPath, to: target, rel });
      if (onProgress) onProgress({ done: seq, total, percent: Math.round((seq / total) * 100), name: path.basename(target) });
    } catch (err) {
      failed.push({ key, error: err.message });
    }
  }

  return { dest, batchId: batch.id, copied, skipped, failed, total };
}

export { recordKey };
