// 落盘的唯一入口：先写 .part → 校验 → 改时间 → rename 成正式文件。
// 任何一步失败都不会在目标目录留下半个文件。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class CopyError extends Error {
  constructor(message, { code = 'COPY', target = null } = {}) {
    super(message);
    this.name = 'CopyError';
    this.code = code;
    this.target = target;
  }
}

async function md5OfFile(filePath) {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 把暂存文件就位到备份目录。
 * @param {object} p
 * @param {string} p.stagingPath 已下载/暂存的文件
 * @param {string} p.targetPath  最终路径
 * @param {string} p.md5         暂存文件的 MD5（由源计算）
 * @param {number} p.size        期望字节数
 * @param {number} p.mtimeMs     要还原的修改时间
 * @param {boolean} p.verifyHash 是否再校验一次 MD5
 */
export async function placeFile({ stagingPath, targetPath, md5, size, mtimeMs, verifyHash = false }) {
  const dir = path.dirname(targetPath);
  await ensureDir(dir);

  const partPath = `${targetPath}.part`;
  try {
    await fsp.copyFile(stagingPath, partPath);
    const st = await fsp.stat(partPath);
    if (Number.isFinite(size) && st.size !== size) {
      throw new CopyError(`写入后大小不符（期望 ${size}，实际 ${st.size}）`, { code: 'SIZE', target: targetPath });
    }
    if (verifyHash && md5) {
      const got = await md5OfFile(partPath);
      if (got !== md5) {
        throw new CopyError(`写入后 MD5 不符`, { code: 'HASH', target: targetPath });
      }
    }
    if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
      const t = new Date(mtimeMs);
      await fsp.utimes(partPath, t, t);
    }
    // Windows 上 rename 覆盖已存在文件的行为不稳定，先确保目标不存在
    await fsp.rm(targetPath, { force: true });
    await fsp.rename(partPath, targetPath);
    return { targetPath, size: st.size };
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    if (err instanceof CopyError) throw err;
    throw new CopyError(err.message, { code: 'COPY', target: targetPath });
  } finally {
    await fsp.rm(stagingPath, { force: true }).catch(() => {});
  }
}

export async function cleanupStaging(stagingDir) {
  try {
    const entries = await fsp.readdir(stagingDir, { withFileTypes: true });
    let removed = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      await fsp.rm(path.join(stagingDir, e.name), { force: true }).catch(() => {});
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

export { md5OfFile };
