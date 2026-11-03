// 123 云盘「挂载盘」模式（T2）：客户端把云盘挂成本地盘符后，直接把文件写进去。
// 比 T1 精确（能逐文件确认），但需要客户端已开通并成功挂载。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class MountError extends Error {
  constructor(message, { code = 'MOUNT', hint = null } = {}) {
    super(message);
    this.name = 'MountError';
    this.code = code;
    this.hint = hint;
  }
}

export function listReadyDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const letter = `${String.fromCharCode(c)}:`;
    try {
      fs.accessSync(`${letter}\\`);
      out.push(letter);
    } catch {
      /* 不存在 */
    }
  }
  return out;
}

export function resolveMountDrive(cfg) {
  const letter = cfg.cloud.mount && cfg.cloud.mount.driveLetter;
  if (!letter) {
    throw new MountError('还没配置挂载盘符', {
      code: 'NO_LETTER',
      hint: `可用盘符：${listReadyDrives().join(' ')}。请在 config.local.json 里设置 cloud.mount.driveLetter（例如 "Z:"）`,
    });
  }
  const normalized = String(letter).replace(/([A-Za-z]).*/, (_, l) => `${l.toUpperCase()}:`);
  if (!fs.existsSync(`${normalized}\\`)) {
    throw new MountError(`挂载盘 ${normalized} 不可访问`, {
      code: 'MISSING',
      hint: '请先在 123 云盘客户端里打开「挂载盘」，确认盘符后填入配置',
    });
  }
  return normalized;
}

/**
 * 把已落盘的文件镜像到挂载盘。
 * @param {{cfg: object, copiedItems: Array, log: object}} params
 */
export async function runMountDrive({ cfg, copiedItems, log }) {
  const drive = resolveMountDrive(cfg);
  const remoteRoot = (cfg.cloud.mount && cfg.cloud.mount.remoteRoot) || '\\手机备份';
  const localRoot = cfg.local.root;

  const uploaded = [];
  const skipped = [];
  const failed = [];

  for (const item of copiedItems) {
    const rel = path.relative(localRoot, item.targetPath);
    const dest = path.join(`${drive}\\`, remoteRoot.replace(/^\\+/, ''), rel);
    try {
      const st = fs.existsSync(dest) ? await fsp.stat(dest) : null;
      if (st && st.size === item.size) {
        skipped.push({ src: item.targetPath, dest, reason: '已存在' });
        continue;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      await fsp.copyFile(item.targetPath, part);
      await fsp.rm(dest, { force: true }).catch(() => {});
      await fsp.rename(part, dest);
      uploaded.push({ src: item.targetPath, dest });
      if (log && log.debug) log.debug(`已写挂载盘：${dest}`);
    } catch (err) {
      failed.push({ src: item.targetPath, dest, error: err.message });
    }
  }

  return { mode: 'mount', drive, remoteRoot, uploaded, skipped, failed };
}
