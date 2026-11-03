// 本地网页界面服务（只监听 127.0.0.1，不对外网开放）
// 启动：node src\server.mjs  或在界面里 启动界面.cmd

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfigLocal } from './config.mjs';
import { buildSource } from './sources/source.mjs';
import { StateStore } from './state.mjs';
import { listVolumes, listFolders, ensureDir } from './drives.mjs';
import { listPhoneDirs, listFolderSource, listSourceTree, scanAll, importSelected, exportBatch } from './pipeline.mjs';
import { ensureStagingDir } from './sync.mjs';
import { createLogger } from './util/log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(ROOT, 'ui');
const PORT_START = Number(process.env.PB_PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ------------------------------------------------------------------ */
/* 会话状态                                                            */
/* ------------------------------------------------------------------ */

const session = {
  cfg: null,
  source: null,
  phone: null,
  scan: null, // {id, at, cfg, plan, summary, mapping, root, filterDesc}
  jobs: new Map(),
  jobSeq: 0,
  log: null,
};

function newJob(type, label) {
  const id = `j${++session.jobSeq}-${Date.now().toString(36)}`;
  const job = {
    id,
    type,
    label,
    status: 'running',
    progress: { done: 0, total: 0, percent: 0, name: '' },
    message: '准备中…',
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
  };
  session.jobs.set(id, job);
  // 只留最近 30 个
  if (session.jobs.size > 30) {
    const oldest = [...session.jobs.keys()].slice(0, session.jobs.size - 30);
    for (const k of oldest) session.jobs.delete(k);
  }
  return job;
}

function jobUpdate(job, patch) {
  Object.assign(job, patch);
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function ensureSession() {
  if (!session.cfg) {
    session.cfg = await loadConfig({ projectRoot: ROOT });
    // 演练模式：把某个本地目录当成来源（测试/没插手机时用）
    session.sourceSpec = process.env.PB_PHONE_DIR
      ? { kind: 'folder', root: path.resolve(process.env.PB_PHONE_DIR), drill: true }
      : { kind: 'phone' };
    await ensureStagingDir(session.cfg, silentLog());
    session.log = createLogger({ logDir: session.cfg.paths.logs, silent: true });
  }
  return session.cfg;
}

function silentLog() {
  const noop = () => {};
  return { raw: noop, plain: noop, info: noop, step: noop, ok: noop, warn: noop, error: noop, debug: noop, close: noop };
}

/** 把"某块硬盘上的一个文件夹"包装成和手机一样的来源 */
function makeFolderSource(root) {
  const s = buildSource({ phone: { transport: 'dir', dir: { root, prefix: '' } } });
  return {
    ...s,
    kind: 'folder',
    async describe() {
      return { label: `硬盘文件夹：${root}`, serial: 'folder', model: root };
    },
  };
}

async function getSource({ reconnect = false } = {}) {
  const cfg = await ensureSession();
  const spec = session.sourceSpec || { kind: 'phone' };
  if (!session.source || reconnect || session.sourceFor !== sourceSpecKey(spec)) {
    session.source = spec.kind === 'folder' ? makeFolderSource(spec.root) : buildSource(cfg);
    session.sourceFor = sourceSpecKey(spec);
  }
  return session.source;
}

function sourceSpecKey(spec) {
  return spec.kind === 'folder' ? `folder:${spec.root}` : 'phone';
}

async function probeSource() {
  try {
    const src = await getSource({ reconnect: true });
    const info = await src.describe();
    session.phone = { ok: true, ...info, spec: session.sourceSpec };
  } catch (err) {
    session.phone = { ok: false, error: err.message, hint: err.hint || null, spec: session.sourceSpec };
  }
  return session.phone;
}

async function probePhone() {
  return probeSource();
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/ui\//, '').replace(/^\//, '');
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

/* ------------------------------------------------------------------ */
/* API 处理                                                            */
/* ------------------------------------------------------------------ */

async function apiOverview() {
  const cfg = await ensureSession();
  const volumes = listVolumes();
  const rootInfo = await listFolders(cfg.local.root, { withCounts: true }).catch(() => ({
    dir: cfg.local.root,
    exists: false,
    folders: [],
    files: [],
  }));
  // 每次都重新探测，拔插手机后不用重启服务
  const source = await probeSource();
  return {
    ok: true,
    phone: source,
    source,
    sourceSpec: session.sourceSpec,
    volumes,
    config: {
      root: cfg.local.root,
      target: (cfg.run && cfg.run.target) || 'both',
      cloudMode: cfg.cloud.mode,
      since: cfg.filter.since || null,
      until: cfg.filter.until || null,
    },
    root: rootInfo,
    paths: {
      desktop: path.join(os.homedir(), 'Desktop'),
      home: os.homedir(),
    },
    batches: (await StateStore.load(cfg.paths.state)).listBatches(5),
  };
}

/** 选择数据来源：手机，或某块硬盘上的某个文件夹 */
async function apiSourceChoose(body) {
  await ensureSession();
  const kind = body.kind === 'folder' ? 'folder' : 'phone';
  if (kind === 'folder') {
    if (!body.root) throw new Error('请填写要作为来源的文件夹路径');
    const root = path.resolve(body.root);
    const st = fs.existsSync(root) ? fs.statSync(root) : null;
    if (!st || !st.isDirectory()) throw new Error(`这个文件夹不存在：${root}`);
    session.sourceSpec = { kind: 'folder', root };
  } else {
    session.sourceSpec = { kind: 'phone' };
  }
  session.source = null;
  session.scan = null;
  const info = await probeSource();
  return { ok: true, source: info };
}

/** 列出当前来源的目录树：大文件夹 → 小文件夹（供分栏对应） */
async function apiSourceTree() {
  const spec = session.sourceSpec || { kind: 'phone' };
  const src = await getSource();
  const tree = await listSourceTree({ source: src, kind: spec.kind, root: spec.root });
  return { ok: true, ...tree };
}

/** 列出当前来源下可对比的文件夹（扁平版，保留给旧界面/脚本） */
async function apiSourceFolders() {
  const spec = session.sourceSpec || { kind: 'phone' };
  const src = await getSource();

  if (spec.kind === 'folder') {
    const folders = await listFolderSource({ root: spec.root });
    return {
      ok: true,
      kind: 'folder',
      root: spec.root,
      folders: folders.map((f) => ({ ...f, remote: f.path })),
    };
  }

  const dirs = await listPhoneDirs({ source: src });
  return { ok: true, kind: 'phone', root: '/sdcard', folders: dirs.map((d) => ({ ...d, path: d.remote })) };
}

async function apiListDir(body) {
  const dir = body.dir;
  if (!dir) return { ok: false, error: '缺少 dir' };
  const info = await listFolders(dir, {
    withCounts: body.withCounts !== false,
    withNames: Boolean(body.withNames),
  });
  return { ok: true, ...info };
}

async function apiMkdir(body) {
  const dir = body.dir;
  if (!dir) return { ok: false, error: '缺少 dir' };
  const resolved = path.resolve(dir);
  await ensureDir(resolved);
  return { ok: true, dir: resolved };
}

function startJob(type, label, runner) {
  const job = newJob(type, label);
  (async () => {
    try {
      const result = await runner(job);
      jobUpdate(job, { status: 'done', result, message: '完成' });
    } catch (err) {
      jobUpdate(job, { status: 'error', error: err.message, message: err.message });
    }
  })();
  return job;
}

async function apiScan(body) {
  const cfg = await ensureSession();
  const root = body.root || cfg.local.root;
  if (!root) throw new Error('请先选择要备份到哪块硬盘的哪个文件夹');
  await ensureDir(root);

  cfg.local.root = path.resolve(root);
  const mapping = Array.isArray(body.mapping) ? body.mapping : [];
  if (!mapping.length) throw new Error('还没有设置"手机文件夹 → 硬盘文件夹"的对应关系');

  const targets = {
    disk: body.targets?.disk !== false,
    cloud: body.targets?.cloud !== false && cfg.cloud.mode !== 'off',
  };
  const since = body.since ? new Date(`${body.since}T00:00:00`) : null;
  const until = body.until ? new Date(`${body.until}T00:00:00`) : null;

  // 文件类型：照片视频 / 再加文档 / 全部文件
  const DOC_EXTS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.md', '.rtf', '.zip', '.rar', '.7z', '.epub'];
  const extMode = String(body.extMode || 'media');
  let includeExt;
  if (body.exts !== undefined) includeExt = body.exts; // null = 所有文件都要
  else if (extMode === 'all') includeExt = null;
  else if (extMode === 'docs') includeExt = [...(cfg.phone.includeExt || []), ...DOC_EXTS];
  else includeExt = cfg.phone.includeExt;

  const state = await StateStore.load(cfg.paths.state);
  await ensureStagingDir(cfg, silentLog());
  const source = await getSource();

  const job = startJob('scan', '扫描手机新增文件', async (j) => {
    j.message = '正在比对手机与硬盘…';
    const res = await scanAll({
      cfg,
      source,
      mapping,
      since,
      until,
      state,
      log: silentLog(),
      stagingDir: cfg.local.stagingDir,
      targets,
      includeExt,
      minSizeBytes: Number.isFinite(body.minSizeBytes)
        ? Number(body.minSizeBytes)
        : extMode === 'media'
          ? cfg.phone.minSizeBytes
          : 0,
    });

    if (res.sourceErrors && res.sourceErrors.length) {
      j.message = `有 ${res.sourceErrors.length} 个文件夹读不了：${res.sourceErrors[0].remote}`;
    }

    const files = res.plan.copy.map((i) => ({
      key: i.key,
      name: i.name,
      relPath: i.relPath,
      folder: i.targetSubdir,
      remote: i.remote,
      size: i.size,
      date: i.date ? i.date.toISOString() : null,
      confidence: i.confidence,
      needDisk: i.needDisk,
      needCloud: i.needCloud,
    }));

    session.scan = {
      id: `s${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      cfg: res.cfg,
      plan: res.plan,
      summary: res.summary,
      mapping,
      root: cfg.local.root,
      filterDesc: res.filterDesc,
      targets,
    };

    return {
      scanId: session.scan.id,
      filterDesc: res.filterDesc,
      files,
      folders: res.summary.sources.map((s) => ({
        remote: s.remote,
        folder: s.targetSubdir,
        add: s.add,
        addBytes: s.addBytes,
        skip: s.skip,
      })),
      folderStats: res.folderStats || [],
      totals: {
        count: files.length,
        bytes: res.summary.bytes,
        skipped: res.summary.skipped,
        toDisk: res.summary.toDisk,
        toCloud: res.summary.toCloud,
      },
      skips: [...res.summary.skipByCode.entries()],
      sourceErrors: res.sourceErrors || [],
      byDay: [...res.summary.byDay.entries()],
    };
  });

  return { ok: true, jobId: job.id };
}

async function apiImport(body) {
  const cfg = await ensureSession();
  if (!session.scan) throw new Error('请先扫描一次');
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (!keys.length) throw new Error('还没有勾选任何文件');

  const targets = {
    disk: body.targets?.disk !== false,
    cloud: body.targets?.cloud !== false && cfg.cloud.mode !== 'off',
  };
  if (!targets.disk && !targets.cloud) throw new Error('目标和云端都被关掉了');

  const state = await StateStore.load(cfg.paths.state);
  const source = await getSource();
  const scan = session.scan;

  const job = startJob('import', '导入选中的文件', async (j) => {
    const res = await importSelected({
      cfg,
      source,
      state,
      planCopy: scan.plan.copy,
      keys,
      targets,
      log: silentLog(),
      onProgress: (p) => {
        job.progress = p;
        j.message = `正在处理 ${p.done}/${p.total}：${p.name}`;
      },
    });
    return {
      batchId: res.batchId,
      batchCount: res.count,
      copied: res.stats.copied,
      uploaded: res.stats.uploaded,
      failures: res.stats.failures,
      root: cfg.local.root,
    };
  });

  return { ok: true, jobId: job.id };
}

async function apiExport(body) {
  const cfg = await ensureSession();
  const destDir = body.destDir || '';
  if (!destDir) throw new Error('请填写要导出到哪个文件夹');

  const state = await StateStore.load(cfg.paths.state);
  const job = startJob('export', '导出本次新导入的文件', async (j) => {
    const res = await exportBatch({
      cfg,
      state,
      batchId: body.batchId || null,
      destDir,
      onProgress: (p) => {
        job.progress = p;
        j.message = `正在复制 ${p.done}/${p.total}`;
      },
    });
    return {
      dest: res.dest,
      total: res.total,
      copied: res.copied.length,
      skipped: res.skipped.length,
      failed: res.failed,
    };
  });
  return { ok: true, jobId: job.id };
}

async function apiSaveConfig(body) {
  const cfg = await ensureSession();
  const patch = {};
  if (body.root) patch.local = { root: path.resolve(body.root) };
  if (body.target) patch.run = { target: body.target };
  if (body.cloudMode) patch.cloud = { mode: body.cloudMode };
  if (Object.keys(patch).length) {
    await saveConfigLocal(patch, { projectRoot: ROOT });
    session.cfg = await loadConfig({ projectRoot: ROOT });
  }
  return { ok: true, config: { root: session.cfg.local.root, target: session.cfg.run.target } };
}

async function apiBatches() {
  const cfg = await ensureSession();
  const state = await StateStore.load(cfg.paths.state);
  return { ok: true, batches: state.listBatches(10) };
}

/* ------------------------------------------------------------------ */
/* 预览：用 Windows 自带的看图工具打开                                  */
/* ------------------------------------------------------------------ */

async function resolvePreviewFile(key) {
  const scan = session.scan;
  if (!scan) throw new Error('请先对比一次，再点预览');
  const item = scan.plan.copy.find((i) => i.key === key);
  if (!item) throw new Error('这个文件不在本次对比结果里，请重新对比');

  if (item.targetPath && fs.existsSync(item.targetPath)) {
    return { filePath: item.targetPath, onDisk: true };
  }

  const src = await getSource();
  const dir = path.join(os.tmpdir(), 'phone-backup-preview');
  await fsp.mkdir(dir, { recursive: true });
  const safeName = String(item.name).replace(/[\\/:*?"<>|]/g, '_');
  const filePath = path.join(dir, `${item.size}-${safeName}`);
  if (!fs.existsSync(filePath)) {
    await src.fetchTo(item.remote, filePath);
  }
  return { filePath, onDisk: false };
}

function openWithShell(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/c', 'start', '', filePath], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** 用系统默认程序打开这张图 */
async function apiPreview(body) {
  const { filePath, onDisk } = await resolvePreviewFile(body.key);
  await openWithShell(filePath);
  return { ok: true, path: filePath, onDisk };
}

/** 在资源管理器里定位这张图 */
async function apiReveal(body) {
  const { filePath } = await resolvePreviewFile(body.key);
  await new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', ['/select,', filePath], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
  return { ok: true, path: filePath };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const POST_ROUTES = {
  '/api/phone/connect': async () => ({ ok: true, phone: await probePhone() }),
  '/api/phone/dirs': apiSourceFolders,
  '/api/source/choose': apiSourceChoose,
  '/api/source/probe': async () => ({ ok: true, source: await probeSource() }),
  '/api/source/folders': apiSourceFolders,
  '/api/source/tree': apiSourceTree,
  '/api/fs/list': apiListDir,
  '/api/fs/mkdir': apiMkdir,
  '/api/scan': apiScan,
  '/api/preview': apiPreview,
  '/api/reveal': apiReveal,
  '/api/import': apiImport,
  '/api/export': apiExport,
  '/api/config': apiSaveConfig,
};

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return sendJson(res, 200, await apiOverview());
    }
    if (req.method === 'GET' && url.pathname === '/api/job') {
      const job = session.jobs.get(url.searchParams.get('id') || '');
      if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在' });
      return sendJson(res, 200, { ok: true, job });
    }
    if (req.method === 'GET' && url.pathname === '/api/batches') {
      return sendJson(res, 200, await apiBatches());
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return sendJson(res, 200, { ok: true, app: 'phone-backup', pid: process.pid });
    }
    if (req.method === 'POST' && url.pathname === '/api/quit') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 250);
      return undefined;
    }

    if (req.method === 'POST') {
      const route = POST_ROUTES[url.pathname];
      if (route) {
        const body = await readBody(req);
        const out = await route(body);
        return sendJson(res, 200, out);
      }
      return sendJson(res, 404, { ok: false, error: `没有这个接口：${url.pathname}` });
    }

    if (req.method === 'GET') return serveStatic(res, url.pathname);

    res.writeHead(405);
    res.end();
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message, hint: err.hint || null });
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function openBrowser(url) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {
    /* 打不开就手动点 */
  }
}

function listen(server, port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(server, port + 1, attempt + 1);
    } else {
      console.error(`✗ 端口被占用或无法监听：${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${port}/`;
    await ensureSession().catch(() => {});
    probePhone().catch(() => {});
    console.log('');
    console.log('  手机备份助手 · 界面已启动');
    console.log(`  地址：${url}`);
    console.log('  关掉这个窗口、或在网页右上角点「退出」即停止服务。');
    console.log('');
    if (process.env.PB_NO_OPEN !== '1') openBrowser(url);
  });
}

/** 已经有一个在跑？直接把浏览器指过去，不再起第二个 */
async function findRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(900) });
    const json = await res.json();
    if (json && json.app === 'phone-backup') return `http://127.0.0.1:${port}/`;
  } catch {
    /* 没在跑 */
  }
  return null;
}

const server = http.createServer(handle);

(async () => {
  if (!process.env.PB_PORT) {
    const running = await findRunning(PORT_START);
    if (running) {
      console.log(`已经开着了：${running}`);
      if (process.env.PB_NO_OPEN !== '1') openBrowser(running);
      process.exit(0);
    }
  }
  listen(server, PORT_START);
})();

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
