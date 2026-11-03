// 源（手机）抽象层。
//   adb  —— 真手机，通过 USB + adb 读取（主力）
//   dir  —— 把本地某个目录当作"手机"（演练、没插手机时自测）
//
// 统一接口：
//   describe()                      → {label, serial, model}
//   list(remoteDir)                 → [{name, size, mtimeMs, isDir}]
//   fetchTo(remotePath, destPath)   → {md5, size}   （写入 destPath 并算 MD5）

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ADB_CANDIDATES = [
  'adb',
  'C:\\Users\\TYB\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\\platform-tools\\adb.exe',
];

export class SourceError extends Error {
  constructor(message, { code = 'SOURCE', hint = null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.hint = hint;
  }
}

/** 解析 `adb devices -l` 的输出 */
export function parseAdbDevices(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const devices = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^List of devices/i.test(t) || t.startsWith('*')) continue;
    const parts = t.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    const extra = {};
    for (const p of parts.slice(2)) {
      const i = p.indexOf(':');
      if (i > 0) extra[p.slice(0, i)] = p.slice(i + 1);
    }
    devices.push({ serial, state, model: extra.model || '', product: extra.product || '' });
  }
  return devices;
}

/** 解析 `stat -c '%s|%Y|%n'` 的每一行 */
export function parseStatLine(line) {
  const m = /^(\d+)\|(\d+)\|(.+)$/.exec(String(line).trim());
  if (!m) return null;
  return { size: Number(m[1]), mtimeMs: Number(m[2]) * 1000, name: m[3] };
}

/** 解析 `ls -l` 的单行（stat 不可用时的兜底） */
export function parseLsLine(line) {
  const t = String(line || '').trim();
  if (!t || t.startsWith('total ')) return null;
  const m = /^([dl-])[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/.exec(t);
  if (!m) return null;
  const name = m[5];
  if (m[1] === 'd') return { name, size: 0, mtimeMs: 0, isDir: true };
  const [y, mo, d] = m[3].split('-').map(Number);
  const [hh, mi] = m[4].split(':').map(Number);
  return { name, size: Number(m[2]), mtimeMs: new Date(y, mo - 1, d, hh, mi, 0).getTime(), isDir: false };
}

async function md5OfFile(filePath) {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function quoteShellArg(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

/* ------------------------------------------------------------------ */
/* dir 源                                                              */
/* ------------------------------------------------------------------ */

export function createDirSource({ root, prefix = '/sdcard/' } = {}) {
  if (!root) throw new SourceError('dir 源缺少 root 配置', { code: 'CONFIG' });

  function toLocal(remotePath) {
    const norm = String(remotePath).replace(/\\/g, '/');
    const pfx = String(prefix).replace(/\/+$/, '');
    let rel = norm;
    if (pfx && norm.startsWith(pfx)) rel = norm.slice(pfx.length);
    rel = rel.replace(/^\/+/, '');
    return path.join(root, ...rel.split('/').filter(Boolean));
  }

  return {
    kind: 'dir',
    async describe() {
      return { label: `本地目录（模拟手机）：${root}`, serial: 'dir', model: 'dir-source' };
    },
    async list(remoteDir) {
      const dir = toLocal(remoteDir);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
        throw err;
      }
      const out = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push({ name: e.name, size: 0, mtimeMs: 0, isDir: true });
        } else if (e.isFile()) {
          const st = await fsp.stat(full);
          out.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs, isDir: false });
        }
      }
      return out;
    },
    async fetchTo(remotePath, destPath) {
      const src = toLocal(remotePath);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(src, destPath);
      const st = await fsp.stat(destPath);
      const md5 = await md5OfFile(destPath);
      return { md5, size: st.size };
    },
  };
}

/* ------------------------------------------------------------------ */
/* adb 源                                                              */
/* ------------------------------------------------------------------ */

class AdbRunner {
  constructor(adbPath) {
    this.adbPath = adbPath;
    this.resolved = null;
  }

  async resolve() {
    if (this.resolved) return this.resolved;
    const candidates = this.adbPath ? [this.adbPath] : ADB_CANDIDATES;
    const failures = [];
    for (const c of candidates) {
      if (c !== 'adb' && !fs.existsSync(c)) {
        failures.push(`${c}（文件不存在）`);
        continue;
      }
      try {
        await this.run(['version'], { timeout: 10000, exe: c });
        this.resolved = c;
        return c;
      } catch (err) {
        failures.push(`${c}（${String(err.message).split('\n')[0]}）`);
      }
    }
    throw new SourceError('找不到可用的 adb 命令', {
      code: 'ADB_MISSING',
      hint: `请在 config.local.json 里把 phone.adbPath 指向 adb.exe。尝试记录：${failures.slice(0, 3).join('；')}`,
    });
  }

  run(args, { timeout = 60000, exe = null } = {}) {
    const bin = exe || this.resolved || this.adbPath || 'adb';
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new SourceError(`adb 超时：${args.join(' ')}`));
      }, timeout);
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new SourceError(`adb 启动失败：${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new SourceError(`adb 失败(${code})：${args.join(' ')}\n${stderr.trim()}`));
        else resolve(stdout);
      });
    });
  }

  /** 二进制安全地把设备文件流式写到 destPath，同时算 MD5 */
  streamOut(remotePath, destPath) {
    const exe = this.resolved || this.adbPath || 'adb';
    return new Promise((resolve, reject) => {
      const child = spawn(exe, ['exec-out', `cat ${quoteShellArg(remotePath)}`], { windowsHide: true });
      const ws = fs.createWriteStream(destPath);
      const hash = crypto.createHash('md5');
      let size = 0;
      let exitCode = null;
      let finished = false;
      let failure = null;

      const settle = () => {
        if (failure) return reject(failure);
        if (exitCode !== null && finished) {
          if (exitCode !== 0) return reject(new SourceError(`拉取失败(${exitCode})：${remotePath}`));
          return resolve({ md5: hash.digest('hex'), size });
        }
        return undefined;
      };

      child.stdout.on('data', (chunk) => {
        hash.update(chunk);
        size += chunk.length;
      });
      child.stderr.on('data', () => {});
      child.on('error', (err) => {
        failure = new SourceError(`拉取失败：${err.message}`);
        try {
          ws.destroy();
        } catch {
          /* ignore */
        }
        settle();
      });
      child.on('close', (code) => {
        exitCode = code;
        settle();
      });
      ws.on('finish', () => {
        finished = true;
        settle();
      });
      ws.on('error', (err) => {
        failure = err;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        settle();
      });
      child.stdout.pipe(ws);
    });
  }
}

export function createAdbSource(cfg = {}) {
  const runner = new AdbRunner(cfg.adbPath || null);
  let deviceSerial = cfg.serial || null;

  async function ensureDevice() {
    await runner.resolve();
    const out = await runner.run(['devices', '-l']);
    const devices = parseAdbDevices(out);
    if (!devices.length) {
      throw new SourceError('没有检测到手机', {
        code: 'NO_DEVICE',
        hint: '用数据线连接手机；然后在「设置 → 关于手机」连点版本号开启开发者选项，再到「开发者选项」里打开「USB 调试」',
      });
    }
    const unauthorized = devices.find((d) => d.state === 'unauthorized');
    if (unauthorized && !deviceSerial) {
      throw new SourceError('手机已连接，但还没授权这台电脑', {
        code: 'UNAUTHORIZED',
        hint: '解锁手机屏幕，在弹窗里点「允许 USB 调试」；没弹窗就拔插一次数据线',
      });
    }
    const ready = devices.filter((d) => d.state === 'device');
    if (!ready.length) {
      throw new SourceError('手机状态异常，无法访问文件', {
        code: 'DEVICE_STATE',
        hint: `当前状态：${devices.map((d) => `${d.serial}=${d.state}`).join(', ')}`,
      });
    }
    const chosen = deviceSerial ? ready.find((d) => d.serial === deviceSerial) : ready[0];
    if (!chosen) throw new SourceError(`指定的设备 ${deviceSerial} 不在线`, { code: 'NO_DEVICE' });
    deviceSerial = chosen.serial;
    return chosen;
  }

  return {
    kind: 'adb',
    async describe() {
      const d = await ensureDevice();
      return { label: `手机 ${d.model || d.serial}（adb 已授权）`, serial: d.serial, model: d.model };
    },
    async list(remoteDir) {
      const quoted = quoteShellArg(remoteDir);
      let out = '';
      try {
        out = await runner.run(['shell', `stat -c "%s|%Y|%n" ${quoted}/* 2>/dev/null`]);
      } catch {
        out = '';
      }
      const items = [];
      for (const line of String(out).split(/\r?\n/)) {
        const parsed = parseStatLine(line);
        if (!parsed) continue;
        const name = String(parsed.name).replace(/\\/g, '/').split('/').pop();
        items.push({ name, size: parsed.size, mtimeMs: parsed.mtimeMs, isDir: false });
      }
      if (items.length) return items;

      try {
        out = await runner.run(['shell', `ls -l ${quoted}`]);
      } catch {
        return [];
      }
      for (const line of String(out).split(/\r?\n/)) {
        const parsed = parseLsLine(line);
        if (parsed) items.push(parsed);
      }
      return items;
    },
    async fetchTo(remotePath, destPath) {
      await runner.resolve();
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      return runner.streamOut(remotePath, destPath);
    },
    // 需要区分文件/目录时用这个（ls -l 的首字母是 d/l）
    async listEntries(remoteDir) {
      const quoted = quoteShellArg(remoteDir);
      let out = '';
      try {
        out = await runner.run(['shell', `ls -l ${quoted}`]);
      } catch {
        return [];
      }
      const items = [];
      for (const line of String(out).split(/\r?\n/)) {
        const parsed = parseLsLine(line);
        if (!parsed) continue;
        items.push({ ...parsed, name: path.posix.basename(String(parsed.name)) });
      }
      return items;
    },
  };
}

export function buildSource(cfg) {
  const phone = cfg.phone || {};
  if (phone.transport === 'dir') {
    const root = phone.dir && phone.dir.root;
    if (!root) throw new SourceError('phone.transport=dir 时必须在配置里给 phone.dir.root', { code: 'CONFIG' });
    return createDirSource({ root, prefix: (phone.dir && phone.dir.prefix) || '/sdcard/' });
  }
  return createAdbSource({ adbPath: phone.adbPath, serial: phone.serial });
}

/** 递归列出某个远程目录下的文件（限制深度，跳过缩略图等目录） */
export async function walkRemote(source, remoteDir, { maxDepth = 3, excludeDirs = [] } = {}) {
  const out = [];
  const skip = new Set(excludeDirs.map((d) => String(d).toLowerCase()));
  const listFn = source.listEntries ? (d) => source.listEntries(d) : (d) => source.list(d);

  async function visit(dir, relPrefix, depth) {
    const entries = await listFn(dir);
    for (const e of entries) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDir) {
        if (depth <= 0) continue;
        if (skip.has(String(e.name).toLowerCase())) continue;
        await visit(`${dir.replace(/\/+$/, '')}/${e.name}`, rel, depth - 1);
      } else {
        out.push({ remote: `${dir.replace(/\/+$/, '')}/${e.name}`, relPath: rel, name: e.name, size: e.size, mtimeMs: e.mtimeMs });
      }
    }
  }

  await visit(String(remoteDir).replace(/\/+$/, ''), '', maxDepth);
  return out;
}
