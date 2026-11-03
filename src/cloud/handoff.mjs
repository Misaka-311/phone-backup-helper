// 123 云盘「备份盘」交管模式（T1，默认）。
// 思路：手机→硬盘这一步已经把"该备份哪些"筛完了，云端只要镜像硬盘上的落点目录即可，
// 所以这里不写云代码，只做三件事：
//   1) 检查落点目录是否都在
//   2) 只读地看一眼 123 客户端有没有配对应的备份任务（拿不到就跳过，绝不改它的数据）
//   3) 出一份"这些文件需要客户端上传"的清单交给报告

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const APP_DATA = process.env.APPDATA || '';

async function readClientConfig() {
  if (!APP_DATA) return null;
  const candidates = [path.join(APP_DATA, '123pan', 'config.json')];
  for (const file of candidates) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const json = JSON.parse(raw);
      return { file, json };
    } catch {
      /* 读不到就算了 */
    }
  }
  return null;
}

function findBackupEntries(json) {
  const found = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const lower = k.toLowerCase();
      if ((lower === 'backuplist' || lower === 'backup_list') && Array.isArray(v)) {
        for (const item of v) found.push(item);
      } else if (typeof v === 'string' && /backup/i.test(lower) && /[\\/]/.test(v)) {
        found.push({ [k]: v });
      } else {
        walk(v, depth + 1);
      }
    }
  };
  walk(json, 0);
  return found;
}

/**
 * @param {{cfg: object, copiedItems: Array}} params
 */
export async function runHandoff({ cfg }) {
  const root = cfg.local.root;
  const watchDirs =
    (cfg.cloud.handoff && cfg.cloud.handoff.watchDirs && cfg.cloud.handoff.watchDirs.length
      ? cfg.cloud.handoff.watchDirs
      : cfg.phone.enabledSources.map((s) => s.targetSubdir)) || [];

  const missing = [];
  const present = [];
  for (const d of watchDirs) {
    const full = path.join(root, ...String(d).split(/[\\/]+/));
    if (fs.existsSync(full)) present.push(full);
    else missing.push(full);
  }

  const warnings = [];
  const clientCfg = await readClientConfig();
  let backupEntries = [];
  if (clientCfg) {
    backupEntries = findBackupEntries(clientCfg.json);
  } else {
    warnings.push('没读到 123 客户端配置（可能没登录过），无法自动确认备份任务，请手动检查客户端里的「备份盘」');
  }

  for (const d of missing) {
    warnings.push(`落点目录还不存在：${d}（首次运行落盘后会自动创建，届时请在客户端把备份源指向它）`);
  }

  return {
    mode: 'handoff',
    watchDirs: present.length ? present : watchDirs.map((d) => path.join(root, ...String(d).split(/[\\/]+/))),
    clientConfigFound: Boolean(clientCfg),
    backupEntries: backupEntries.slice(0, 10),
    warnings,
    delegated: true,
  };
}
