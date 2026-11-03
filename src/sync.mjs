#!/usr/bin/env node
// 手机备份助手 · 主流程
//
// 用法：
//   node src\sync.mjs run                完整流程（默认）
//   node src\sync.mjs dry                只出表，不动文件
//   node src\sync.mjs retry-cloud        只重试云端待补传
//   node src\sync.mjs verify             校验状态库里的文件是否还在、大小/哈希对不对
//   node src\sync.mjs setup              首次设置向导
//
// 常用参数：
//   --since 2026-10-01     含当天
//   --until 2026-11-01     不含
//   --years 2027           只要 2027 年拍的（等价 --since 2027-01-01 --until 2028-01-01）
//   --since-last           从上一次成功运行的时间继续
//   --yes                  不询问，直接执行
//   --dry                  只预演
//   --cloud off|handoff|mount|open123
//   --root <硬盘根目录>     覆盖 local.root
//   --source-dir <目录>     用本地目录当手机（演练用）
//   --path-prefix a,b      只看这些子目录
//   --name-glob "*.heic"   只处理匹配的文件名
//   --exclude-uncertain    排除只能靠修改时间推测的文件

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, isFlagOn } from './util/args.mjs';
import { createLogger } from './util/log.mjs';
import { PROJECT_ROOT, isInside } from './util/paths.mjs';
import { loadConfig, saveConfigLocal, resolveClientSecret } from './config.mjs';
import { buildSource, walkRemote, SourceError } from './sources/source.mjs';
import { parseFromName, resolvePhotoTime, exifableExtension } from './time/photoTime.mjs';
import { makeFilter, parseDateBoundary, rangeFromYears } from './filter.mjs';
import { buildPlan, summarize, SKIP_LABELS } from './plan.mjs';
import { placeFile, cleanupStaging } from './local/copy.mjs';
import { StateStore, recordKey } from './state.mjs';
import { runHandoff } from './cloud/handoff.mjs';
import { resolveMountDrive } from './cloud/mountDrive.mjs';
import { Open123Client } from './cloud/open123.mjs';
import { getFreeSpace, renderPlanText, renderCloudText, writeHtmlReport, openInBrowser } from './report.mjs';
import { formatBytes, formatDateTime } from './util/format.mjs';

const DEFAULT_CMD = 'run';

const USAGE = `手机备份助手

  node src\\sync.mjs run            完整流程（先出表，回车后执行）
  node src\\sync.mjs dry            只出表，不动任何文件
  node src\\sync.mjs target-run     先问你这次要导到哪，再跑
  node src\\sync.mjs date-run       先问起止日期，再跑
  node src\\sync.mjs retry-cloud    只重试云端待补传
  node src\\sync.mjs verify         校验状态库里记录的文件
  node src\\sync.mjs setup          首次设置向导

目标（这次备份到哪里）
  --target disk    只导硬盘，不碰 123 云盘
  --target cloud   只传 123 云盘，不写硬盘（需要 --cloud mount|open123）
  --target both    两边都导（默认）

常用参数
  --since 2026-10-01    只处理这一天（含）之后拍的
  --until 2026-11-01    到这一天（不含）为止
  --years 2027          只要 2027 年拍的
  --since-last          从上一次成功运行的时间继续
  --name-glob "*.heic"  只处理匹配的文件名
  --path-prefix Camera  只看手机里的某个子目录
  --exclude-uncertain   排除只能靠修改时间推测的文件
  --root F:\\某个目录     覆盖硬盘根目录
  --source-dir <目录>    用本地目录当手机（演练）
  --cloud off|handoff|mount|open123
  --yes                 不询问直接执行
  --no-open             不自动打开 HTML 报告
  --dry                 等同 dry 命令
`;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

async function readHeadFile(filePath, bytes = 262144) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const n = Math.min(bytes, st.size);
    if (n <= 0) return null;
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

function splitList(value) {
  if (value === undefined || value === null || value === true) return [];
  return String(value)
    .split(/[,\s;，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let _rl = null;
function getRl() {
  if (!_rl) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    _rl.on('close', () => {
      _rl = null;
    });
  }
  return _rl;
}

async function ask(question) {
  const rl = getRl();
  if (!rl || rl.closed) return '';
  // stdin 被关闭（管道/EOF）时不要让 promise 永远挂着，按"直接回车"处理
  const onClosed = new Promise((resolve) => {
    rl.once('close', () => resolve(''));
  });
  try {
    const answer = await Promise.race([rl.question(question), onClosed]);
    return String(answer ?? '').trim();
  } catch {
    return '';
  }
}

async function confirmOrAbort(log) {
  if (!process.stdin.isTTY) return true;
  const answer = await ask('按回车开始执行，输入 n 取消：');
  if (/^n/i.test(answer)) {
    log.warn('已取消，没有修改任何文件。');
    return false;
  }
  return true;
}

/** 找一个真的能写的暂存目录（目标盘只读 / 盘符不存在时自动降级到系统临时目录） */
export async function ensureStagingDir(cfg, log) {
  const wanted = cfg.local.stagingDir;
  const candidates = [wanted, path.join(os.tmpdir(), 'phone-backup-staging')].filter(Boolean);
  for (const dir of candidates) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
      if (dir !== wanted) log.warn(`暂存目录不可写，改用：${dir}`);
      cfg.local.stagingDir = dir;
      return dir;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到可写的暂存目录，请用 --staging-dir 指定一个');
}

/* ------------------------------------------------------------------ */
/* 配置 + 命令行                                                       */
/* ------------------------------------------------------------------ */

function buildFilterOptions(cfg, args, state) {
  let since = null;
  let until = null;
  let label = null;

  if (args.years) {
    const r = rangeFromYears(args.years);
    since = r.since;
    until = r.until;
    label = r.label;
  }
  if (args.since !== undefined) {
    since = parseDateBoundary(args.since, { which: '起始日期' });
    label = null;
  }
  if (args.until !== undefined) {
    until = parseDateBoundary(args.until, { which: '结束日期' });
    label = null;
  }
  if (isFlagOn(args['since-last'])) {
    if (!state.data.lastSuccessAt) {
      throw new Error('还没有成功运行过，没有"上次时间"可用；请改用 --since 2026-10-01');
    }
    since = new Date(state.data.lastSuccessAt);
    label = null;
  }
  if (!args.years && !args.since && !args.until && !isFlagOn(args['since-last'])) {
    since = cfg.filter.since ? parseDateBoundary(cfg.filter.since, { which: '配置里的 filter.since' }) : null;
    until = cfg.filter.until ? parseDateBoundary(cfg.filter.until, { which: '配置里的 filter.until' }) : null;
  }

  return {
    since,
    until,
    label,
    includeExt: splitList(args['ext']).length ? splitList(args['ext']) : cfg.phone.includeExt,
    minSizeBytes: Number.isFinite(Number(args['min-size'])) ? Number(args['min-size']) : cfg.phone.minSizeBytes,
    pathPrefixes: splitList(args['path-prefix']).length ? splitList(args['path-prefix']) : cfg.filter.pathPrefixes || [],
    nameGlob: args['name-glob'] || cfg.filter.nameGlob || null,
    excludeUncertain: isFlagOn(args['exclude-uncertain']) || Boolean(cfg.filter.excludeUncertain),
  };
}

async function prepareConfig(args) {
  const cfg = await loadConfig({ projectRoot: PROJECT_ROOT });
  const oldRoot = cfg.local.root;
  if (args.root) {
    cfg.local.root = path.resolve(String(args.root));
    // 暂存目录若还是"默认值"（跟随根目录），要跟着一起搬
    if (cfg.local.stagingDir === path.join(oldRoot, '._phone_backup_tmp')) {
      cfg.local.stagingDir = path.join(cfg.local.root, '._phone_backup_tmp');
    }
  }
  if (args['source-dir']) {
    cfg.phone.transport = 'dir';
    cfg.phone.dir = { root: path.resolve(String(args['source-dir'])), prefix: cfg.phone.dir?.prefix || '/sdcard/' };
  }
  if (args.cloud) {
    const mode = String(args.cloud);
    if (!['off', 'handoff', 'mount', 'open123'].includes(mode)) {
      throw new Error(`--cloud 只能是 off / handoff / mount / open123，收到「${args.cloud}」`);
    }
    cfg.cloud.mode = mode;
  }
  if (args.state) cfg.paths.state = path.resolve(String(args.state));
  if (args.reports) cfg.paths.reports = path.resolve(String(args.reports));
  if (args.logs) cfg.paths.logs = path.resolve(String(args.logs));
  if (args['staging-dir']) cfg.local.stagingDir = path.resolve(String(args['staging-dir']));
  if (args['cloud-url']) cfg.cloud.open123.baseURL = String(args['cloud-url']);
  if (args['cloud-id']) cfg.cloud.open123.clientId = String(args['cloud-id']);
  if (args['cloud-secret']) cfg.cloud.open123.clientSecret = String(args['cloud-secret']);
  if (!cfg.local.root) throw new Error('配置里没有 local.root（硬盘备份根目录）');
  return cfg;
}

/* ------------------------------------------------------------------ */
/* 采集：列出手机文件 + 判定拍摄时间                                     */
/* ------------------------------------------------------------------ */

export async function collectItems({ source, cfg, log }) {
  const items = [];
  const sourceStatus = [];
  const excludeNames = new Set((cfg.phone.excludeNames || []).map((n) => n.toLowerCase()));

  for (const s of cfg.phone.enabledSources) {
    let files = [];
    let error = null;
    try {
      files = await walkRemote(source, s.remote, {
        // 每个来源可以单独指定深度（"散放的文件"那种只取本层，避免和子文件夹重复）
        maxDepth: Number.isFinite(s.maxDepth) ? s.maxDepth : cfg.phone.maxDepth,
        excludeDirs: cfg.phone.excludeDirs,
      });
    } catch (err) {
      error = err.message;
    }
    files = files.filter((f) => !excludeNames.has(String(f.name).toLowerCase()));

    sourceStatus.push({ id: s.id, remote: s.remote, targetSubdir: s.targetSubdir, count: files.length, error });

    for (const f of files) {
      const parsed = parseFromName(f.name);
      items.push({
        sourceId: s.id,
        remote: f.remote,
        relPath: f.relPath,
        name: f.name,
        size: f.size,
        mtimeMs: f.mtimeMs,
        targetSubdir: s.targetSubdir,
        date: parsed ? parsed.date : null,
        confidence: parsed ? parsed.confidence : null,
        basis: parsed ? parsed.basis : null,
      });
    }
    log.info(`${s.remote}  →  扫描到 ${files.length} 个文件${error ? `（读取失败：${error}）` : ''}`);
  }

  return { items, sourceStatus };
}

export async function resolveUnknownDates({
  items,
  source,
  state,
  stagingDir,
  log,
  probeCap = 100,
  probeMaxSize = 8 * 1024 * 1024,
}) {
  const unknown = items.filter((i) => !i.date && !i.dupName);
  if (!unknown.length) return 0;

  let pulled = 0;
  let skippedByCap = 0;
  let seq = 0;
  log.info(`有 ${unknown.length} 个文件的文件名里没有时间，开始识别（前 ${probeCap} 个 JPEG 读 EXIF，其余用手机端修改时间）`);

  for (const item of unknown) {
    const key = recordKey(item.sourceId, item.remote);
    const rec = state.getRecord(key);
    if (rec) {
      item.date = new Date(item.mtimeMs || Date.now());
      item.confidence = 'mtime';
      item.basis = 'phone-mtime';
      continue;
    }

    const canProbe =
      exifableExtension(item.name) &&
      pulled < probeCap &&
      !(Number(item.size) > probeMaxSize);

    if (canProbe) {
      try {
        seq += 1;
        const staging = path.join(stagingDir, `probe-${Date.now()}-${seq}${path.extname(item.name) || '.bin'}`);
        const got = await source.fetchTo(item.remote, staging);
        const head = await readHeadFile(staging);
        const t = resolvePhotoTime({ name: item.name, mtimeMs: item.mtimeMs, headBuffer: head });
        item.date = t.date;
        item.confidence = t.confidence;
        item.basis = t.basis;
        item.prestaged = { path: staging, md5: got.md5, size: got.size };
        pulled += 1;
        continue;
      } catch (err) {
        log.warn(`读 EXIF 失败，改用修改时间：${item.name}（${err.message}）`);
      }
    } else if (exifableExtension(item.name) && pulled >= probeCap) {
      skippedByCap += 1;
    }

    const t = resolvePhotoTime({ name: item.name, mtimeMs: item.mtimeMs });
    item.date = t.date;
    item.confidence = t.confidence;
    item.basis = t.basis;
  }

  if (pulled) log.info(`为识别时间预取了 ${pulled} 个 JPEG（若最后被筛掉会自动删除）`);
  if (skippedByCap) log.info(`另有 ${skippedByCap} 个 JPEG 超过探测上限，改用手机端修改时间`);
  return pulled;
}

/* ------------------------------------------------------------------ */
/* 目标（只导硬盘 / 只传云盘 / 两边都导）                                */
/* ------------------------------------------------------------------ */

export function resolveTargets(args, cfg) {
  const raw = args.target ?? args.to ?? (cfg.run && cfg.run.target) ?? 'both';
  const t = String(raw).trim().toLowerCase();
  if (['both', 'all', '2', '都', '两边'].includes(t)) return { disk: true, cloud: true };
  if (['disk', 'local', 'hdd', '1', '硬盘'].includes(t)) return { disk: true, cloud: false };
  if (['cloud', 'pan', '123', '3', '云盘'].includes(t)) return { disk: false, cloud: true };
  throw new Error(`目标只能填 disk / cloud / both（或 1 / 3 / 2），收到「${raw}」`);
}

export function targetLabelOf(targets, cloudMode) {
  const cloud = targets.cloud && cloudMode !== 'off';
  if (targets.disk && cloud) return `硬盘 + 123 云盘（${cloudMode}）`;
  if (targets.disk) return '仅硬盘（不传云盘）';
  if (cloud) return `仅 123 云盘（${cloudMode}，不写硬盘）`;
  return '什么都不做';
}

/* ------------------------------------------------------------------ */
/* 执行：落盘 + 上云（按 item.needDisk / item.needCloud 各自独立）        */
/* ------------------------------------------------------------------ */

function cloudRemoteDir(cfg, item) {
  const o = cfg.cloud.open123;
  const relDir = path.posix.dirname(String(item.relPath).replace(/\\/g, '/'));
  return path.posix.join(o.remoteRoot, item.targetSubdir, relDir === '.' ? '' : relDir);
}

async function uploadOne({ item, filePath, cfg, state, client, drive, log }) {
  const mode = cfg.cloud.mode;

  if (mode === 'open123') {
    const remoteDir = cloudRemoteDir(cfg, item);
    if (!client) {
      state.addPending({
        key: item.key,
        localPath: item.needDisk ? item.targetPath : null,
        remote: item.remote,
        sourceId: item.sourceId,
        name: item.name,
        size: item.size,
        remotePath: `${remoteDir}/${item.name}`,
        error: '缺少 clientId/clientSecret',
      });
      return { ok: false, pending: true, error: '缺少 123 开放平台凭据' };
    }
    const parentID = await client.resolveDir(remoteDir);
    const res = await client.uploadFile({
      localPath: filePath,
      parentFileID: parentID,
      filename: item.name,
      size: item.size,
    });
    const rec = state.getRecord(item.key) || {};
    state.setRecord(item.key, {
      ...rec,
      size: item.size,
      onDisk: rec.onDisk === true,
      cloudFileID: res.fileID,
      cloudPath: `${remoteDir}/${item.name}`,
      cloudMode: 'open123',
    });
    return { ok: true, reuse: res.reuse };
  }

  if (mode === 'mount') {
    const remoteRoot = (cfg.cloud.mount && cfg.cloud.mount.remoteRoot) || '\\手机备份';
    const rel = item.needDisk
      ? path.relative(cfg.local.root, item.targetPath)
      : path.join(item.targetSubdir, ...String(item.relPath).split('/'));
    const dest = path.join(`${drive}\\`, remoteRoot.replace(/^\\+/, ''), rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    await fsp.copyFile(filePath, part);
    await fsp.rm(dest, { force: true }).catch(() => {});
    await fsp.rename(part, dest);
    const rec = state.getRecord(item.key) || {};
    state.setRecord(item.key, {
      ...rec,
      size: item.size,
      onDisk: rec.onDisk === true,
      cloudFileID: 'mount',
      cloudPath: dest,
      cloudMode: 'mount',
    });
    if (log) log.debug(`已写挂载盘：${dest}`);
    return { ok: true };
  }

  if (mode === 'handoff') {
    // T1：落盘就等于交给客户端了，这里只打标记
    const rec = state.getRecord(item.key) || {};
    state.setRecord(item.key, { ...rec, handoff: true });
    return { ok: true, handoff: true };
  }

  return { ok: false, error: `云端档位「${mode}」不做事` };
}

export async function executePlan({ plan, source, cfg, state, log, targets, onProgress = null }) {
  const failures = [];
  const stats = { copied: 0, uploaded: 0, reuse: 0, uploadedFailed: 0, handoff: 0 };
  let seq = 0;
  const total = plan.copy.length;
  const start = Date.now();

  const mode = cfg.cloud.mode;
  const wantCloud = targets.cloud && mode !== 'off';

  let client = null;
  if (wantCloud && mode === 'open123') {
    client = buildCloudClient(cfg, state, log);
    if (!client) log.warn('没配置 123 开放平台的 clientId / clientSecret：这次上云会全部进"待补传"');
  }
  let drive = null;
  if (wantCloud && mode === 'mount') drive = resolveMountDrive(cfg);

  const stagingOf = async (item) => {
    if (item.prestaged && fs.existsSync(item.prestaged.path)) {
      return { path: item.prestaged.path, md5: item.prestaged.md5, ephemeral: false };
    }
    const ext = path.extname(item.name) || '.bin';
    const p = path.join(
      cfg.local.stagingDir,
      `${Date.now()}-${seq}-${Math.random().toString(16).slice(2)}${ext}`,
    );
    const got = await source.fetchTo(item.remote, p);
    return { path: p, md5: got.md5, ephemeral: true };
  };

  for (const item of plan.copy) {
    seq += 1;
    let staging = null;
    try {
      // ① 落盘
      if (item.needDisk) {
        staging = await stagingOf(item);
        if (!isInside(cfg.local.root, item.targetPath)) {
          throw new Error(`目标路径越界，已拒绝：${item.targetPath}`);
        }
        const md5 = staging.md5;
        await placeFile({
          stagingPath: staging.path,
          targetPath: item.targetPath,
          md5,
          size: item.size,
          mtimeMs: cfg.local.keepPhoneMtime ? item.mtimeMs : undefined,
          verifyHash: cfg.local.verifyHash,
        });
        staging = null; // placeFile 已经消费掉暂存文件
        const rec = state.getRecord(item.key) || {};
        state.setRecord(item.key, {
          ...rec,
          size: item.size,
          mtimeMs: item.mtimeMs,
          takenAt: item.date ? item.date.toISOString() : null,
          confidence: item.confidence,
          basis: item.basis,
          md5,
          localPath: item.targetPath,
          sourceId: item.sourceId,
          remote: item.remote,
          relPath: item.relPath,
          onDisk: true,
        });
        stats.copied += 1;
      }

      // ② 上云
      if (item.needCloud && wantCloud) {
        let filePath = null;
        if (item.needDisk && fs.existsSync(item.targetPath)) filePath = item.targetPath;
        if (!filePath) {
          staging = staging || (await stagingOf(item));
          filePath = staging.path;
        }
        const res = await uploadOne({ item, filePath, cfg, state, client, drive, log });
        if (res.ok) {
          stats.uploaded += 1;
          if (res.reuse) stats.reuse += 1;
          if (res.handoff) stats.handoff += 1;
          log.info(`已上云：${item.name}${res.reuse ? '（秒传）' : ''}`);
        } else {
          stats.uploadedFailed += 1;
          throw new Error(res.error || '云端失败');
        }
      }

      const pct = Math.round((seq / total) * 100);
      if (onProgress) {
        try {
          onProgress({ done: seq, total, percent: pct, name: item.name, relPath: item.relPath });
        } catch {
          /* 进度回调出错不影响主流程 */
        }
      }
      if (process.stdout.isTTY) {
        const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25, '·');
        process.stdout.write(
          `\r  ${bar} ${String(seq).padStart(4)}/${total} ${String(pct).padStart(3)}%  ${item.name.slice(0, 40).padEnd(40)}`,
        );
      } else if (seq % 10 === 0 || seq === total) {
        log.info(`进度 ${seq}/${total}`);
      }

      if (seq % 20 === 0) await state.save();
    } catch (err) {
      failures.push({ name: item.name, path: item.remote, error: err.message });
      if (process.stdout.isTTY) process.stdout.write('\n');
      log.error(`处理失败：${item.relPath} → ${err.message}`);
      if (item.needCloud && wantCloud && !String(err.message).includes('缺少')) {
        state.addPending({
          key: item.key,
          localPath: item.needDisk ? item.targetPath : null,
          remote: item.remote,
          sourceId: item.sourceId,
          name: item.name,
          size: item.size,
          remotePath: `${cloudRemoteDir(cfg, item)}/${item.name}`,
          error: err.message,
        });
      }
    } finally {
      if (staging && staging.ephemeral) {
        await fsp.rm(staging.path, { force: true }).catch(() => {});
      }
    }
  }

  if (process.stdout.isTTY && total) process.stdout.write('\n');
  const ms = Date.now() - start;
  const parts = [];
  if (targets.disk) parts.push(`已落盘 ${stats.copied}`);
  if (wantCloud) parts.push(`已上云 ${stats.uploaded}${stats.reuse ? `（秒传 ${stats.reuse}）` : ''}`);
  log.ok(`${parts.join('，')}；共 ${total} 个待处理${failures.length ? `，失败 ${failures.length}` : ''}，耗时 ${(ms / 1000).toFixed(1)} 秒`);
  return { ...stats, failures };
}

/* ------------------------------------------------------------------ */
/* 云端                                                                */
/* ------------------------------------------------------------------ */

export function buildCloudClient(cfg, state, log) {
  const o = cfg.cloud.open123;
  const secret = resolveClientSecret(cfg);
  if (!o.clientId || !secret) {
    return null;
  }
  const client = new Open123Client({
    baseURL: o.baseURL,
    clientId: o.clientId,
    clientSecret: secret,
    duplicate: o.duplicate,
    token: state.getToken(),
    log,
    onToken: (t) => {
      if (t) state.setToken(t);
      else state.clearToken();
    },
  });
  return client;
}

async function summarizeCloud({ cfg, targets, stats }) {
  const mode = cfg.cloud.mode;
  if (!targets.cloud || mode === 'off') return { mode: 'off' };
  if (mode === 'handoff') {
    const info = await runHandoff({ cfg });
    return { ...info, mode: 'handoff', delegated: stats.handoff };
  }
  return { mode, uploaded: stats.uploaded, reuse: stats.reuse, failed: stats.uploadedFailed };
}

/* ------------------------------------------------------------------ */
/* 主命令：run / dry                                                   */
/* ------------------------------------------------------------------ */

export async function runSync(args, { command = DEFAULT_CMD } = {}) {
  const dry = command === 'dry' || isFlagOn(args.dry);
  const yes = isFlagOn(args.yes) || isFlagOn(args.y);
  const cfg = await prepareConfig(args);

  const targets = resolveTargets(args, cfg);
  const cloudMode = cfg.cloud.mode;
  if (targets.cloud && cloudMode === 'handoff' && !targets.disk) {
    throw new Error(
      '当前云端档位是「备份盘交管（T1）」，它靠"文件先落到硬盘、客户端再扫上去"工作，所以不能只传云盘不要硬盘。\n' +
        '  解决：① 选「硬盘 + 云盘」；或 ② 把云端档位换成 T2 挂载盘 / T3 开放平台 API（--cloud mount|open123）。',
    );
  }
  if (!targets.disk && !targets.cloud) {
    throw new Error('目标和云端都被关掉了，没什么可做的。至少选 disk 或 cloud 之一。');
  }

  const log = createLogger({ logDir: cfg.paths.logs, silent: isFlagOn(args.quiet) });
  const state = await StateStore.load(cfg.paths.state);
  state.markRunStart();

  log.raw('');
  log.raw('═'.repeat(62));
  log.raw(`  手机备份助手 · ${dry ? '预演模式（不会修改任何文件）' : '备份'}`);
  log.raw(`  目标：${targetLabelOf(targets, cloudMode)}`);
  log.raw('═'.repeat(62));

  // 0. 环境准备
  await ensureStagingDir(cfg, log);
  const stale = await cleanupStaging(cfg.local.stagingDir);
  if (stale) log.debug(`清理了 ${stale} 个上次残留的暂存文件`);

  const source = buildSource(cfg);
  let phoneInfo;
  try {
    phoneInfo = await source.describe();
  } catch (err) {
    if (err instanceof SourceError) {
      log.raw('');
      log.error(err.message);
      if (err.hint) log.plain(`  → ${err.hint}`);
      log.raw('');
      log.plain('提示：没插手机时可以先跑「只看新增-不动文件.cmd --source-dir <某个文件夹>」做演练。');
      return { ok: false, exitCode: 2, error: err.message };
    }
    throw err;
  }
  log.ok(`${phoneInfo.label}`);

  // 1. 列出手机文件
  log.step('第 1 步 / 5　扫描手机目录');
  const { items, sourceStatus } = await collectItems({ source, cfg, log });
  if (!items.length) {
    log.warn('手机里这些目录都没有文件，或目录不存在。请先在「首次设置」里确认目录是否正确。');
    await state.save();
    return { ok: true, exitCode: 0, empty: true };
  }

  // 2. 判定拍摄时间
  log.step('第 2 步 / 5　判定拍摄时间');
  const filterOpts = buildFilterOptions(cfg, args, state);
  const filter = makeFilter(filterOpts);
  await resolveUnknownDates({ items, source, state, stagingDir: cfg.local.stagingDir, log });

  // 3. 生成清单
  log.step('第 3 步 / 5　比对硬盘与历史记录');
  const plan = buildPlan({ items, filter, state, cfg, targets });
  const summary = summarize(plan, cfg.phone.enabledSources, targets);

  // 清掉"预取了但最后被筛掉"的暂存文件
  const kept = new Set(plan.copy.map((i) => i.prestaged?.path).filter(Boolean));
  for (const item of items) {
    if (item.prestaged && !kept.has(item.prestaged.path)) {
      await fsp.rm(item.prestaged.path, { force: true }).catch(() => {});
    }
  }

  const free = await getFreeSpace(cfg.local.root);
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dateLabel = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  const ctx = {
    dry,
    dateLabel,
    phoneLabel: phoneInfo.label,
    root: cfg.local.root,
    free: free ? free.free : null,
    filterDesc: filter.describe(),
    targetLabel: targetLabelOf(targets, cloudMode),
    showDisk: targets.disk,
    showCloud: targets.cloud && cloudMode !== 'off',
    cloudSummary: '',
  };

  log.raw(renderPlanText({ plan, summary, ctx }));

  for (const s of sourceStatus) {
    if (s.error) log.warn(`${s.remote} 读取失败：${s.error}`);
    else if (s.count === 0) log.warn(`${s.remote} 下没有文件（目录不存在或为空）`);
  }

  if (targets.disk && summary.count > 0 && free && summary.bytes > free.free) {
    log.error(`硬盘空间不够：需要 ${formatBytes(summary.bytes)}，${cfg.local.root} 只剩 ${formatBytes(free.free)}`);
    await state.save();
    return { ok: false, exitCode: 1, error: 'insufficient-space' };
  }

  if (dry) {
    log.raw(
      targets.disk
        ? '预演结束：以上是本次"如果执行会做什么"，硬盘上一个字节都没有改动。'
        : '预演结束：以上是本次"如果执行会上传什么"，没有向云盘写入任何东西。',
    );
    const html = await writeHtmlReport({
      reportsDir: cfg.paths.reports,
      ctx: { ...ctx, cloudSummary: '（预演，未执行）' },
      plan,
      summary,
      run: { copied: 0, failures: [] },
    });
    log.plain(`报告：${html}`);
    if (!isFlagOn(args['no-open'])) openInBrowser(html);
    await state.save();
    log.close();
    return { ok: true, exitCode: 0, plan, summary, targets, report: html };
  }

  if (summary.count === 0) {
    log.ok('没有需要处理的新文件。');
  } else if (!yes) {
    const go = await confirmOrAbort(log);
    if (!go) {
      await state.save();
      log.close();
      return { ok: true, exitCode: 0, cancelled: true };
    }
  }

  // 4. 落盘 + 上云
  log.step(
    `第 4 步 / 5　${targets.disk && targets.cloud ? '复制到硬盘 + 上传云盘' : targets.disk ? '复制到硬盘' : '上传到 123 云盘'}`,
  );
  const stats = summary.count
    ? await executePlan({ plan, source, cfg, state, log, targets })
    : { copied: 0, uploaded: 0, reuse: 0, uploadedFailed: 0, handoff: 0, failures: [] };
  const failures = stats.failures;

  // 5. 收尾
  log.step('第 5 步 / 5　收尾');
  let cloudResult = null;
  try {
    cloudResult = await summarizeCloud({ cfg, targets, stats });
  } catch (err) {
    log.error(`云端收尾信息取不到（不影响已经做完的事）：${err.message}`);
    cloudResult = { mode: cfg.cloud.mode, error: err.message };
  }
  log.raw(renderCloudText(cloudResult));

  state.data.counters.copiedTotal = (state.data.counters.copiedTotal || 0) + stats.copied;
  state.data.counters.uploadedTotal = (state.data.counters.uploadedTotal || 0) + stats.uploaded;
  if (targets.disk && stats.copied === summary.toDisk) state.markRunSuccess();
  await state.save();

  const cloudSummary = renderCloudText(cloudResult);
  const html = await writeHtmlReport({
    reportsDir: cfg.paths.reports,
    ctx: { ...ctx, cloudSummary },
    plan,
    summary,
    run: { copied: stats.copied, failures },
  });

  const bits = [`新增 ${summary.count} 个（${formatBytes(summary.bytes)}）`];
  if (targets.disk) bits.push(`已落盘 ${stats.copied}`);
  if (targets.cloud && cloudMode !== 'off') bits.push(`已上云 ${stats.uploaded}`);
  bits.push(`跳过 ${summary.skipped}`);
  if (failures.length) bits.push(`失败 ${failures.length}`);

  log.raw('');
  log.raw('─'.repeat(62));
  log.ok(`完成：${bits.join('，')}`);
  log.plain(`报告：${html}`);
  log.raw('');

  if (!isFlagOn(args['no-open'])) openInBrowser(html);
  log.close();
  return {
    ok: failures.length === 0,
    exitCode: failures.length ? 1 : 0,
    plan,
    summary,
    targets,
    copied: stats.copied,
    uploaded: stats.uploaded,
    failures,
    cloudResult,
    report: html,
  };
}

/* ------------------------------------------------------------------ */
/* retry-cloud                                                         */
/* ------------------------------------------------------------------ */

export async function retryCloud(args) {
  const cfg = await prepareConfig(args);
  const log = createLogger({ logDir: cfg.paths.logs, silent: isFlagOn(args.quiet) });
  const state = await StateStore.load(cfg.paths.state);
  const pending = state.listPending();

  log.raw('');
  log.raw('═'.repeat(62));
  log.raw(`  补传云端 · 待处理 ${pending.length} 个`);
  log.raw('═'.repeat(62));

  if (!pending.length) {
    log.ok('没有待补传的文件，收工。');
    log.close();
    return { ok: true, exitCode: 0, uploaded: 0 };
  }

  if (cfg.cloud.mode !== 'open123') {
    log.warn(`当前云端档位是「${cfg.cloud.mode}」，补传只对 open123（开放平台 API）有效。`);
    log.plain('如果你用的是「备份盘」交管或挂载盘，关掉本窗口，让客户端自己同步即可。');
    log.close();
    return { ok: false, exitCode: 2 };
  }

  const client = buildCloudClient(cfg, state, log);
  if (!client) {
    log.error('缺少 clientId / clientSecret，无法补传。');
    log.close();
    return { ok: false, exitCode: 2 };
  }

  await ensureStagingDir(cfg, log);
  let source = null;

  let ok = 0;
  let fail = 0;
  for (const item of pending) {
    let tempPath = null;
    try {
      let localPath = item.localPath;
      if (!localPath || !fs.existsSync(localPath)) {
        // 只传云盘的记录本地没有副本，只能回手机再拉一次
        if (!item.remote) throw new Error('本地没有副本，也不知道手机路径，无法补传');
        if (!source) source = buildSource(cfg);
        const ext = path.extname(item.name) || '.bin';
        tempPath = path.join(cfg.local.stagingDir, `retry-${Date.now()}${ext}`);
        await source.fetchTo(item.remote, tempPath);
        localPath = tempPath;
        log.debug(`从手机重新拉取：${item.name}`);
      }
      const dir = path.posix.dirname(String(item.remotePath).replace(/\\/g, '/'));
      const parentID = await client.resolveDir(dir);
      const res = await client.uploadFile({
        localPath,
        parentFileID: parentID,
        filename: item.name,
        size: item.size,
      });
      const rec = state.getRecord(item.key) || {};
      state.setRecord(item.key, { ...rec, cloudFileID: res.fileID, cloudPath: item.remotePath });
      state.removePending(item.key);
      ok += 1;
      log.ok(`补传成功：${item.name}`);
    } catch (err) {
      fail += 1;
      log.error(`补传失败：${item.name} → ${err.message}`);
    } finally {
      if (tempPath) await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }
  await state.save();
  log.raw('');
  log.ok(`补传结束：成功 ${ok}，失败 ${fail}，剩余待补传 ${state.listPending().length}`);
  log.close();
  return { ok: fail === 0, exitCode: fail ? 1 : 0, uploaded: ok, failed: fail };
}

/* ------------------------------------------------------------------ */
/* verify                                                              */
/* ------------------------------------------------------------------ */

export async function verifyState(args) {
  const cfg = await prepareConfig(args);
  const log = createLogger({ logDir: cfg.paths.logs, silent: isFlagOn(args.quiet) });
  const state = await StateStore.load(cfg.paths.state);
  const { md5OfFile } = await import('./local/copy.mjs');
  const withHash = isFlagOn(args.hash);

  const records = Object.entries(state.data.files);
  log.raw('');
  log.raw('═'.repeat(62));
  log.raw(`  校验报告 · 记录 ${records.length} 条${withHash ? '（含 MD5 重算）' : ''}`);
  log.raw('═'.repeat(62));

  let ok = 0;
  const missing = [];
  const sizeBad = [];
  const hashBad = [];
  let cloudOnly = 0;
  let checked = 0;

  for (const [key, rec] of records) {
    if (args.limit && checked >= Number(args.limit)) break;
    checked += 1;
    const p = rec.localPath;
    if (!p && rec.cloudFileID) {
      // 只传云盘、不写硬盘的记录，本来就没有本地文件
      cloudOnly += 1;
      continue;
    }
    if (!p || !fs.existsSync(p)) {
      missing.push({ key, p });
      continue;
    }
    const st = await fsp.stat(p);
    if (Number.isFinite(rec.size) && st.size !== Number(rec.size)) {
      sizeBad.push({ key, p, expect: rec.size, got: st.size });
      continue;
    }
    if (withHash && rec.md5) {
      const got = await md5OfFile(p);
      if (got !== rec.md5) {
        hashBad.push({ key, p, expect: rec.md5, got });
        continue;
      }
    }
    ok += 1;
  }

  log.ok(`正常 ${ok} 个`);
  if (cloudOnly) log.plain(`另有 ${cloudOnly} 条是"只传云盘"的记录，本地没有副本，跳过（正常）`);
  if (missing.length) {
    log.warn(`本地找不到 ${missing.length} 个（硬盘被移动/删除？）`);
    for (const m of missing.slice(0, 10)) log.plain(`  ${m.p}`);
  }
  if (sizeBad.length) {
    log.error(`大小不符 ${sizeBad.length} 个`);
    for (const m of sizeBad.slice(0, 10)) log.plain(`  ${m.p} 期望 ${m.expect} 实际 ${m.got}`);
  }
  if (hashBad.length) {
    log.error(`MD5 不符 ${hashBad.length} 个`);
    for (const m of hashBad.slice(0, 10)) log.plain(`  ${m.p}`);
  }
  const pending = state.listPending().length;
  if (pending) log.plain(`另有 ${pending} 个文件在"待补传"队列里，可运行「补传云端.cmd」`);
  log.close();

  const bad = missing.length + sizeBad.length + hashBad.length;
  return { ok: bad === 0, exitCode: bad ? 1 : 0, okCount: ok, bad };
}

/* ------------------------------------------------------------------ */
/* setup 向导                                                          */
/* ------------------------------------------------------------------ */

export async function setupWizard() {
  const log = createLogger({ logDir: path.join(PROJECT_ROOT, 'logs') });
  const cfg = await loadConfig({ projectRoot: PROJECT_ROOT });

  log.raw('');
  log.raw('═'.repeat(62));
  log.raw('  首次设置向导（直接回车 = 用括号里的默认值）');
  log.raw('═'.repeat(62));

  const transport = (await ask('1) 手机怎么连？[1=USB调试(adb，推荐)  2=用本地目录演练]  (1)：')) || '1';

  let dirRoot = null;
  const extraSources = [];
  if (transport === '2') {
    dirRoot = await ask('   请填一个"假装是手机"的本地目录：');
    if (!dirRoot) {
      log.error('没有填目录，退出。');
      return { ok: false, exitCode: 2 };
    }
  } else {
    // 插着手机就顺手扫一遍，让你看见每个目录到底有多少文件
    log.plain('   正在检测手机…');
    try {
      const probe = buildSource({ phone: { transport: 'adb', dir: {} } });
      const info = await probe.describe();
      log.ok(`   已连上：${info.label}`);
      for (const s of cfg.phone.sources) {
        let n = 0;
        try {
          n = (await walkRemote(probe, s.remote, { maxDepth: 0, excludeDirs: [] })).length;
        } catch {
          n = -1;
        }
        log.plain(`   ${s.remote}  →  ${n < 0 ? '读取失败' : n === 0 ? '（空目录或不存在）' : `${n} 个文件`}`);
      }
      for (let i = 0; i < 5; i++) {
        const p = await ask('   还要备份手机里别的目录吗？（填路径，如 /sdcard/DCIM/BrowserDownloads；回车跳过）：');
        if (!p) break;
        const seg = String(p).split('/').filter(Boolean).pop() || `extra${i + 1}`;
        extraSources.push({ id: `extra${i + 1}`, remote: p, targetSubdir: seg, enabled: true });
      }
    } catch (err) {
      log.warn(`   手机扫描跳过（${err.message}）`);
      if (err.hint) log.plain(`   → ${err.hint}`);
      log.plain('   不影响继续设置：先填好配置，插好手机再跑「只看新增」。');
    }
  }

  const rootInput = (await ask(`2) 备份到硬盘的哪个根目录？ (${cfg.local.root})：`)) || cfg.local.root;

  log.plain('');
  log.plain('3) 目录映射方案：');
  log.plain('   A = 按手机原文件夹名分开（推荐）');
  log.plain('   B = 全部汇总进一个文件夹（沿用旧的「拍照」）');
  log.plain('   C = 按拍摄年月分目录');
  const scheme = ((await ask('   选 A / B / C  (A)：')) || 'A').toUpperCase();

  let sources = [...cfg.phone.sources, ...extraSources];
  if (scheme === 'B') {
    const merged = await ask('   汇总到哪个子目录？ (拍照)：');
    sources = sources.map((s) => ({ ...s, targetSubdir: merged || '拍照' }));
  }

  log.plain('');
  log.plain('4) 云端同步方式：');
  log.plain('   T1 = 123 客户端「备份盘」自动增量（免费，推荐）');
  log.plain('   T2 = 写到客户端挂载盘符（免费，需已开通）');
  log.plain('   T3 = 开放平台 API（要买开发者权益包，约 200 元/年）');
  log.plain('   OFF = 先不做云端');
  const tier = ((await ask('   选 T1 / T2 / T3 / OFF  (T1)：')) || 'T1').toUpperCase();

  const cloudModeMap = { T1: 'handoff', T2: 'mount', T3: 'open123', OFF: 'off' };
  const cloudMode = cloudModeMap[tier] || 'handoff';

  log.plain('');
  log.plain('5) 默认备份到哪里？');
  log.plain('   1 = 只导硬盘（不传 123 云盘）');
  log.plain('   2 = 硬盘 + 123 云盘（推荐）');
  log.plain('   3 = 只传 123 云盘（不写硬盘）');
  const tPick = ((await ask('   输入 1 / 2 / 3  (2)：')) || '2').trim();
  const targetMap = { 1: 'disk', 2: 'both', 3: 'cloud' };
  const target = targetMap[tPick] || 'both';
  if (target === 'cloud' && cloudMode === 'handoff') {
    log.warn('「只传云盘」不能用 T1（备份盘）档位——T1 靠"先落硬盘再扫上去"。请把云端换成 T2 或 T3。');
  }

  const patch = {
    local: { root: path.resolve(rootInput) },
    phone: {
      transport: transport === '2' ? 'dir' : 'adb',
      sources,
      ...(transport === '2' && dirRoot ? { dir: { root: path.resolve(dirRoot), prefix: '/sdcard/' } } : {}),
    },
    cloud: { mode: cloudMode },
    run: { target },
  };

  if (cloudMode === 'mount') {
    const letter = await ask('   客户端挂载出来的盘符（如 Z:）：');
    patch.cloud.mount = { driveLetter: letter || null };
  }
  if (cloudMode === 'open123') {
    const id = await ask('   123 开放平台 clientId：');
    const key = await ask('   clientSecret（回车跳过，改用环境变量 PAN123_CLIENT_SECRET）：');
    patch.cloud.open123 = { enabled: true, clientId: id || '' };
    if (key) patch.cloud.open123.clientSecret = key;
  }

  const file = await saveConfigLocal(patch);
  const finalCfg = await loadConfig({ projectRoot: PROJECT_ROOT });

  log.raw('');
  log.ok(`已写入配置：${file}`);
  if (finalCfg.phone.transport === 'dir') {
    log.plain('当前是「本地目录演练」模式，手机上真跑之前记得把 phone.transport 改回 adb。');
  }
  log.raw('');
  log.plain('下一步：');
  log.plain(`  默认目标：${target === 'disk' ? '只导硬盘' : target === 'cloud' ? '只传 123 云盘' : '硬盘 + 123 云盘'}`);
  finalCfg.phone.enabledSources.forEach((s) => {
    log.plain(`  手机 ${s.remote}  →  硬盘 ${path.join(finalCfg.local.root, s.targetSubdir)}`);
  });
  if (cloudMode === 'handoff') {
    log.plain('');
    log.plain('云端（T1）请在 123 云盘客户端里做一次：');
    log.plain('  打开「备份盘」→ 新增备份 → 本地目录选上面这些硬盘落点目录');
    log.plain('  → 云端目录选 /手机备份 → 保存。之后它自己会增量上传。');
    log.plain('  注意：别把整个备份根目录都挂上，会连历史照片一起传。');
  }
  log.raw('');
  log.plain('然后双击「只看新增-不动文件.cmd」先看一眼清单，确认无误再双击「一键备份.cmd」。');
  log.close();
  return { ok: true, exitCode: 0, configFile: file };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0] || DEFAULT_CMD;

  try {
    switch (command) {
      case 'run':
      case 'dry': {
        const res = await runSync(args, { command });
        process.exitCode = res.exitCode ?? 0;
        break;
      }
      case 'date-run': {
        const s = await ask('起始日期（如 2026-10-01，直接回车=不限）：');
        const u = await ask('结束日期（如 2027-01-01，直接回车=不限）：');
        const merged = { ...args };
        if (s) merged.since = s;
        if (u) merged.until = u;
        if (!s && !u) console.log('两个都空，按"不限时间"执行。');
        const res = await runSync(merged, { command: 'run' });
        process.exitCode = res.exitCode ?? 0;
        break;
      }
      case 'target-run': {
        process.stdout.write('\n这次要备份到哪里？\n');
        process.stdout.write('  1) 只导硬盘（不传 123 云盘）\n');
        process.stdout.write('  2) 硬盘 + 123 云盘（推荐）\n');
        process.stdout.write('  3) 只传 123 云盘（不写硬盘）\n');
        const pick = (await ask('输入 1 / 2 / 3（直接回车=2）：')) || '2';
        const map = { 1: 'disk', 2: 'both', 3: 'cloud' };
        const target = map[String(pick).trim()] || 'both';
        const label = target === 'disk' ? '仅硬盘（不传云盘）' : target === 'cloud' ? '仅 123 云盘（不写硬盘）' : '硬盘 + 123 云盘';
        process.stdout.write(`\n目标：${label}\n`);
        const res = await runSync({ ...args, target }, { command: 'run' });
        process.exitCode = res.exitCode ?? 0;
        break;
      }
      case 'retry-cloud': {
        const res = await retryCloud(args);
        process.exitCode = res.exitCode ?? 0;
        break;
      }
      case 'verify': {
        const res = await verifyState(args);
        process.exitCode = res.exitCode ?? 0;
        break;
      }
      case 'setup': {
        const res = await setupWizard();
        process.exitCode = res.exitCode ?? 0;
        break;
      }
      case 'help':
      case '--help':
      case '-h': {
        process.stdout.write(USAGE);
        process.exitCode = 0;
        break;
      }
      default: {
        console.error(`未知命令：${command}\n可用：run | dry | retry-cloud | verify | setup`);
        process.exitCode = 2;
      }
    }
  } catch (err) {
    if (err instanceof SourceError) {
      console.error(`\n✗ ${err.message}`);
      if (err.hint) console.error(`  → ${err.hint}`);
      process.exitCode = 2;
    } else {
      console.error(`\n✗ 出错了：${err.message}`);
      if (process.env.PB_DEBUG) console.error(err.stack);
      else console.error('  （要看到完整堆栈，先设置环境变量 PB_DEBUG=1）');
      process.exitCode = 1;
    }
  }
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
