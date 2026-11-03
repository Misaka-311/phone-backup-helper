import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（手机备份\），本文件位于 src\util\ 下 */
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const SRC_DIR = path.join(PROJECT_ROOT, 'src');
export const STATE_DIR = path.join(PROJECT_ROOT, 'state');
export const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
export const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');

export function fromRoot(...segments) {
  return path.join(PROJECT_ROOT, ...segments);
}

/** 把反斜杠路径统一成正斜杠，便于做 glob/正则匹配 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 去掉盘符与根，得到相对路径 */
export function relativeSafe(base, target) {
  const rel = path.relative(base, target);
  return rel === '' ? '.' : rel;
}

/** Windows 文件名非法字符替换 */
export function sanitizeFileName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .trim();
}

/** 判断路径是否位于 root 之内（用于安全校验，避免写到目标根之外） */
export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
