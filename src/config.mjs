// 配置加载：默认值 ← config.json ← config.local.json（后者覆盖前者）
// 所有个人路径、密钥都放在 config.local.json，不写死在代码里。

import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './util/paths.mjs';

export const DEFAULT_CONFIG = {
  phone: {
    transport: 'adb', // adb | dir
    adbPath: null, // null = 用 PATH 里的 adb
    dir: { root: null, prefix: '/sdcard/' }, // 用本地目录模拟手机（演练/测试用）
    sources: [
      { id: 'camera', remote: '/sdcard/DCIM/Camera', targetSubdir: 'Camera', enabled: true },
      { id: 'screenshots', remote: '/sdcard/Pictures/Screenshots', targetSubdir: 'Screenshots', enabled: true },
      { id: 'weixin', remote: '/sdcard/Pictures/WeiXin', targetSubdir: 'WeiXin', enabled: true },
    ],
    includeExt: ['.jpg', '.jpeg', '.jfif', '.heic', '.heif', '.png', '.webp', '.dng', '.mp4', '.mov'],
    excludeNames: ['.nomedia', 'thumbs.db', '.ds_store'],
    excludeDirs: ['.thumbnails', '.trashed', '.trash', 'cache'],
    minSizeBytes: 1024,
    maxDepth: 3,
  },
  local: {
    root: 'F:\\heic格式照片',
    stagingDir: null, // 默认 <root>\._phone_backup_tmp
    collision: 'skip', // skip | rename
    verifyHash: false, // true = 落盘后再算一次 MD5（慢，但更稳）
    keepPhoneMtime: true,
  },
  filter: {
    since: null,
    until: null,
    excludeUncertain: false,
    nameGlob: null,
    pathPrefixes: [],
  },
  cloud: {
    mode: 'handoff', // handoff | mount | open123 | off
    handoff: { watchDirs: ['Camera', 'Screenshots', 'WeiXin'] },
    mount: { driveLetter: null, remoteRoot: '\\手机备份' },
    open123: {
      enabled: false,
      baseURL: 'https://open-api.123pan.com',
      clientId: '',
      clientSecret: null,
      clientSecretEnv: 'PAN123_CLIENT_SECRET',
      remoteRoot: '/手机备份/F-heic格式照片',
      concurrency: 3,
      duplicate: 1,
      verify: true,
    },
  },
  run: { confirm: true, dryRun: false, maxFiles: 0, target: 'both' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

async function readJsonIfExists(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    // 记事本/PowerShell 保存的 UTF-8 可能带 BOM，JSON.parse 会直接报错，这里先去掉
    const text = raw.replace(/^\uFEFF/, '');
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`配置文件格式不对（${file}）：${err.message}\n  提示：可以删掉这个文件，界面会重新生成。`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`读取配置文件失败：${file}\n${err.message}`);
  }
}

function lastSegment(p) {
  const parts = String(p).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'src';
}

export function normalizeConfig(cfg, projectRoot = PROJECT_ROOT) {
  const out = deepMerge(DEFAULT_CONFIG, cfg);

  out.phone.sources = (out.phone.sources || [])
    .filter((s) => s && s.remote)
    .map((s, i) => {
      const remote = String(s.remote);
      const seg = lastSegment(remote);
      return {
        id: s.id || (slugify(seg) || `src${i}`),
        remote,
        targetSubdir: s.targetSubdir ?? seg,
        enabled: s.enabled !== false,
      };
    });

  // 同一 targetSubdir 允许多个来源（方案 B：合并进同一个目录）
  out.phone.enabledSources = out.phone.sources.filter((s) => s.enabled);

  if (!out.local.root) throw new Error('配置里缺少 local.root（硬盘备份根目录），例如 "F:\\\\heic格式照片"');
  out.local.root = path.resolve(out.local.root);
  if (!out.local.stagingDir) out.local.stagingDir = path.join(out.local.root, '._phone_backup_tmp');
  out.local.stagingDir = path.resolve(out.local.stagingDir);

  if (!['skip', 'rename'].includes(out.local.collision)) out.local.collision = 'skip';
  if (!['handoff', 'mount', 'open123', 'off'].includes(out.cloud.mode)) out.cloud.mode = 'handoff';

  out.paths = {
    projectRoot,
    state: path.join(projectRoot, 'state', 'state.json'),
    logs: path.join(projectRoot, 'logs'),
    reports: path.join(projectRoot, 'reports'),
  };

  return out;
}

export async function loadConfig({ projectRoot = PROJECT_ROOT } = {}) {
  const base = await readJsonIfExists(path.join(projectRoot, 'config.json'));
  const local = await readJsonIfExists(path.join(projectRoot, 'config.local.json'));
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, base || {}), local || {});
  return normalizeConfig(merged, projectRoot);
}

export async function saveConfigLocal(patch, { projectRoot = PROJECT_ROOT } = {}) {
  const file = path.join(projectRoot, 'config.local.json');
  const existing = (await readJsonIfExists(file)) || {};
  const merged = deepMerge(existing, patch);
  await fs.writeFile(file, JSON.stringify(merged, null, 2), 'utf8');
  return file;
}

export function resolveClientSecret(cfg) {
  const o = (cfg.cloud && cfg.cloud.open123) || {};
  if (o.clientSecretEnv && process.env[o.clientSecretEnv]) return process.env[o.clientSecretEnv];
  if (o.clientSecret) return String(o.clientSecret);
  return null;
}
