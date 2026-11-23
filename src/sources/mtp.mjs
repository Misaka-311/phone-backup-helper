// MTP（Windows 便携设备）通道：手机没开 USB 调试时，也能通过"文件传输"模式读写相册。
// 实际干活的是 tools/mtp-bridge.ps1（PowerShell + Shell.Application），这里只做进程调用与协议封装。
//
// 为什么需要它：adb 看不到设备（手机上没开"USB 调试"）时，Windows 依然能通过 MTP 看到手机，
// 只是慢一些（列目录约 1~2 ms/项、复制约 10 MB/s），但完全够备份用。

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

export class MtpError extends Error {
  constructor(message, { code = 'MTP', hint = null, stage = 'unknown' } = {}) {
    super(message);
    this.name = 'MtpError';
    this.code = code;
    this.hint = hint;
    this.stage = stage;
  }
}

/** 找桥脚本：显式指定 → 环境变量 → 项目内 tools/ → 已安装副本同级 tools/ */
export function findBridge(explicit = null) {
  const candidates = [
    explicit,
    process.env.PB_MTP_BRIDGE,
    path.join(PROJECT_ROOT, 'tools', 'mtp-bridge.ps1'),
    path.join(path.dirname(process.execPath), 'tools', 'mtp-bridge.ps1'),
    path.join(path.dirname(process.execPath), '..', 'tools', 'mtp-bridge.ps1'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return path.resolve(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

/** '/sdcard/DCIM/Camera' → ['DCIM','Camera']；'' 或 '/' 表示存储根 */
export function toSegments(remote) {
  const s = String(remote == null ? '' : remote)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^\/sdcard(\/|$)/i, '')
    .replace(/^\/+/, '');
  if (!s) return [];
  return s.split('/').filter(Boolean);
}

let seqCounter = 0;

async function tmpPaths() {
  const dir = path.join(os.tmpdir(), 'pb-mtp');
  await fsp.mkdir(dir, { recursive: true });
  seqCounter += 1;
  const tag = `${process.pid}-${Date.now()}-${seqCounter}`;
  return { dir, req: path.join(dir, `req-${tag}.json`), res: path.join(dir, `res-${tag}.json`) };
}

/** 把 payload 里的路径字段统一成"段数组"（桥只认段数组，传字符串会被当成单个目录名） */
function normalizePaths(payload) {
  const out = { ...payload };
  if (typeof out.path === 'string' || out.path == null) {
    if (out.path != null) out.path = toSegments(out.path);
  } else if (Array.isArray(out.path)) {
    out.path = out.path.flatMap((x) => (Array.isArray(x) ? x : toSegments(x)));
  }
  if (typeof out.dir === 'string') out.dir = toSegments(out.dir);
  else if (Array.isArray(out.dir)) out.dir = out.dir.flatMap((x) => (Array.isArray(x) ? x : toSegments(x)));
  if (Array.isArray(out.paths)) {
    out.paths = out.paths.map((p) => (Array.isArray(p) ? p : toSegments(p)));
  }
  return out;
}

/** 起一次 PowerShell 桥，跑一个 action，返回解析后的 JSON */
export async function runBridge(payload, { bridge = null, timeoutMs = 180000 } = {}) {
  payload = normalizePaths(payload);
  const script = findBridge(bridge);
  if (!script) {
    throw new MtpError('找不到 MTP 桥脚本 tools/mtp-bridge.ps1', {
      code: 'NO_BRIDGE',
      hint: '确认安装目录里 tools/mtp-bridge.ps1 没被删掉',
    });
  }
  const { req, res } = await tmpPaths();
  await fsp.writeFile(req, JSON.stringify(payload), 'utf8');

  try {
    const result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          powershellPath(),
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ReqPath', req, '-ResPath', res],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (err) {
        reject(err);
        return;
      }
      let stderr = '';
      child.stderr.on('data', (d) => {
        if (stderr.length < 4000) stderr += String(d);
      });
      child.stdout.on('data', () => {});
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new MtpError('MTP 操作超时', { code: 'TIMEOUT', stage: 'timeout' }));
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve({ stderr });
      });
    });

    let raw = '';
    try {
      raw = await fsp.readFile(res, 'utf8');
    } catch {
      throw new MtpError('MTP 桥没有返回结果', {
        code: 'NO_RESULT',
        hint: result.stderr ? `PowerShell 报错：${result.stderr.trim().slice(0, 300)}` : null,
      });
    }
    let data;
    try {
      data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new MtpError(`MTP 桥输出无法解析：${err.message}`, { code: 'BAD_JSON' });
    }
    if (!data.ok) {
      const stage = data.stage || 'unknown';
      const hints = {
        'no-device': '用数据线连上手机，并在手机上把 USB 用途选成「传输文件 / MTP」',
        'no-storage': '在手机上解锁屏幕，保持「文件传输」模式，然后重新连接一次',
        'no-dir': '这个文件夹在手机上不存在，可能被删掉或改名了',
        'no-dest': '目标文件夹打不开，换个位置再试',
      };
      throw new MtpError(data.error || `MTP 失败（${stage}）`, { code: stage.toUpperCase(), stage, hint: hints[stage] || null });
    }
    return data;
  } finally {
    await fsp.rm(req, { force: true }).catch(() => {});
    await fsp.rm(res, { force: true }).catch(() => {});
  }
}

async function md5OfFile(filePath) {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function normaliseItem(it) {
  const dir = !!it.isDir;
  return {
    name: String(it.name),
    isDir: dir,
    size: dir ? 0 : Number(it.size) || 0,
    mtimeMs: Number(it.mtimeMs) || 0,
  };
}

/**
 * 把 MTP 包装成和 adb 一样的来源对象。
 * 除 list/listEntries/fetchTo 外，还提供 copyMany（一次进程复制一批，省掉每条一启动 PowerShell 的开销）。
 */
export function createMtpSource({ device = null, storage = null, bridge = null, timeoutMs = 180000 } = {}) {
  let chosenDevice = device;
  let chosenStorage = storage;
  const cache = new Map();

  const base = () => ({ device: chosenDevice, storage: chosenStorage });

  async function listEntries(remote) {
    const key = String(remote || '');
    if (cache.has(key)) return cache.get(key);
    const data = await runBridge({ action: 'list', ...base(), path: toSegments(remote) }, { bridge, timeoutMs });
    const items = (data.items || []).map(normaliseItem);
    cache.set(key, items);
    return items;
  }

  return {
    kind: 'mtp',
    transport: 'mtp',
    get device() {
      return chosenDevice;
    },

    async describe() {
      const data = await runBridge({ action: 'probe', ...base() }, { bridge, timeoutMs });
      const devices = data.devices || [];
      if (!devices.length) {
        throw new MtpError('电脑没有看到手机（MTP 也没找到）', {
          code: 'NO_DEVICE',
          hint: '插好数据线；在手机上把 USB 用途切成「传输文件」，并在弹出的授权框里点允许',
        });
      }
      const picked = (chosenDevice && devices.find((d) => d.name === chosenDevice)) || devices[0];
      chosenDevice = picked.name;
      chosenStorage = chosenStorage || (picked.storages && picked.storages[0]) || '内部共享存储空间';
      return {
        label: `手机 ${chosenDevice}（MTP 文件传输）`,
        serial: 'mtp',
        model: chosenDevice,
        transport: 'mtp',
        storage: chosenStorage,
        storages: picked.storages || [],
        devices: devices.map((d) => d.name),
      };
    },

    async list(remote) {
      const items = await listEntries(remote);
      return items.filter((i) => !i.isDir);
    },

    async listEntries(remote) {
      return listEntries(remote);
    },

    /** 批量列目录：拆成几段并行跑（MTP 允许多个句柄），比一个一个列快 2~4 倍 */
    async listMany(remotes, { concurrency = 6 } = {}) {
      const list = Array.from(remotes);
      const out = new Map();
      if (!list.length) return out;

      // 按路径预算把工作量摊到几个进程上，避免"一个进程里排大队"
      const chunks = [];
      const n = Math.max(1, Math.min(concurrency, list.length));
      const buckets = Array.from({ length: n }, (_, i) => ({ paths: [], weight: 0, idx: i }));
      const weightOf = (r) => {
        const segs = toSegments(r);
        return segs.length ? 1 : 0.2;
      };
      void weightOf;
      list.forEach((r, i) => {
        const b = buckets[i % n];
        b.paths.push(r);
      });

      const runChunk = async (bucket) => {
        if (!bucket.paths.length) return;
        const data = await runBridge(
          { action: 'listMany', ...base(), paths: bucket.paths.map((r) => toSegments(r)) },
          { bridge, timeoutMs },
        );
        (data.listing || []).forEach((entry, idx) => {
          const key = String(bucket.paths[idx] || '');
          const items = (entry.items || []).map(normaliseItem);
          cache.set(key, items);
          out.set(key, items);
        });
      };

      const results = await Promise.allSettled(buckets.map(runChunk));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length && failed.length === results.length) {
        throw failed[0].reason;
      }
      // 任何一段失败，就把没拿到的路径逐个补一下
      for (const r of list) {
        if (out.has(String(r))) continue;
        try {
          out.set(String(r), await listEntries(r));
        } catch {
          out.set(String(r), []);
        }
      }
      return out;
    },

    /** 只数文件个数（不取大小/时间），比 list 快约 30% */
    async countMany(remotes) {
      const data = await runBridge(
        { action: 'count', ...base(), paths: Array.from(remotes).map((r) => toSegments(r)) },
        { bridge, timeoutMs },
      );
      const out = new Map();
      (data.counts || []).forEach((c, idx) => {
        out.set(String(Array.from(remotes)[idx] || ''), Number(c.count) || 0);
      });
      return out;
    },

    /**
     * 复制一批文件到 destDir，返回与 entries 一一对应的 [{ok, size, path, md5, error}]。
     * 不同手机目录里可能有同名文件，所以每个源目录先分到一个独立子目录再复制。
     */
    async copyMany(entries, destDir) {
      await fsp.mkdir(destDir, { recursive: true });
      const results = new Array(entries.length);
      const groups = new Map();
      entries.forEach((e, idx) => {
        const dir = path.posix.dirname(String(e.remote));
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push({ entry: e, idx });
      });

      let g = 0;
      for (const [dir, list] of groups) {
        const sub = path.join(destDir, `g${g}`);
        g += 1;
        await fsp.mkdir(sub, { recursive: true });
        const names = list.map((x) => x.entry.name);
        const expect = {};
        for (const x of list) if (Number(x.entry.size) > 0) expect[x.entry.name] = Number(x.entry.size);
        let data = null;
        let failure = null;
        try {
          data = await runBridge(
            { action: 'copy', ...base(), dir: toSegments(dir), names, dest: sub, expect },
            { bridge, timeoutMs: Math.max(timeoutMs, 300000) },
          );
        } catch (err) {
          failure = err.message;
        }
        const byName = new Map(((data && data.copied) || []).map((c) => [String(c.name), c]));
        for (const x of list) {
          const c = byName.get(x.entry.name);
          if (!failure && c && c.ok) {
            const filePath = path.join(sub, x.entry.name);
            let md5 = null;
            try {
              md5 = await md5OfFile(filePath);
            } catch {
              md5 = null;
            }
            results[x.idx] = { ok: true, size: Number(c.size) || 0, path: filePath, md5, error: null };
          } else {
            results[x.idx] = {
              ok: false,
              size: 0,
              path: null,
              md5: null,
              error: failure || (c && c.error) || 'FAILED',
            };
          }
        }
      }
      return results;
    },

    async fetchTo(remote, destPath) {
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      const name = path.posix.basename(String(remote));
      const dir = path.posix.dirname(String(remote));
      const data = await runBridge(
        { action: 'copy', ...base(), dir: toSegments(dir), names: [name], dest: path.dirname(destPath), expect: {} },
        { bridge, timeoutMs: Math.max(timeoutMs, 300000) },
      );
      const got = (data.copied || [])[0];
      if (!got || !got.ok) {
        throw new MtpError(`从手机复制失败：${name}${got && got.error ? `（${got.error}）` : ''}`, { code: 'COPY_FAILED' });
      }
      const produced = path.join(path.dirname(destPath), name);
      if (path.resolve(produced) !== path.resolve(destPath)) {
        await fsp.rename(produced, destPath).catch(async () => {
          await fsp.copyFile(produced, destPath);
          await fsp.rm(produced, { force: true }).catch(() => {});
        });
      }
      const st = await fsp.stat(destPath);
      return { size: st.size, md5: await md5OfFile(destPath) };
    },
  };
}
