// 盘符枚举与目录枚举（给界面用：选哪块硬盘、硬盘上有哪些文件夹）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function volumeLabel(letter) {
  try {
    const buf = execFileSync('cmd.exe', ['/c', 'vol', letter], {
      windowsHide: true,
      encoding: 'buffer',
      timeout: 3000,
    });
    let text = '';
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = buf.toString('utf8');
    }
    const m = /卷是\s*(.+)/.exec(text) || /卷\s*在\s*驱动器\s*\S*\s*中\s*是\s*(.+)/.exec(text) || /is\s+(.+)/i.exec(text);
    return m ? m[1].split(/\r?\n/)[0].trim() : '';
  } catch {
    return '';
  }
}

/** 列出所有可用的盘（含卷标、容量、剩余） */
export function listVolumes() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    try {
      const st = fs.statfsSync(root);
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      out.push({
        letter: `${letter}:`,
        root,
        label: volumeLabel(`${letter}:`),
        total,
        free,
        type: total > 0 && free / total < 1 ? 'fixed' : 'unknown',
      });
    } catch {
      /* 该盘不存在或未就绪 */
    }
  }
  return out;
}

/** 列出某个目录下的一级子文件夹（带文件数，用于"硬盘上有哪些文件夹"） */
export async function listFolders(dir, { withCounts = true, withNames = false, max = 300 } = {}) {
  const base = path.resolve(dir);
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { dir: base, exists: false, folders: [], files: [] };
    throw err;
  }

  const folders = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    if (e.isDirectory()) folders.push({ name: e.name, path: path.join(base, e.name) });
    else if (e.isFile()) files.push({ name: e.name });
  }

  if (withCounts || withNames) {
    for (const f of folders.slice(0, max)) {
      try {
        const list = await fsp.readdir(f.path, { withFileTypes: true });
        f.items = list.length;
        f.subFolders = list.filter((x) => x.isDirectory()).map((x) => x.name).slice(0, 30);
        if (withNames) f.names = list.filter((x) => x.isFile()).map((x) => x.name).slice(0, 300);
      } catch {
        f.items = null;
      }
    }
  }

  const deepFolders = [];
  if (withNames) {
    for (const f of folders.slice(0, max)) {
      let subs = [];
      try {
        subs = await fsp.readdir(f.path, { withFileTypes: true });
      } catch {
        subs = [];
      }
      for (const s of subs.filter((x) => x.isDirectory()).slice(0, 60)) {
        let inner = [];
        try {
          inner = await fsp.readdir(path.join(f.path, s.name), { withFileTypes: true });
        } catch {
          inner = [];
        }
        deepFolders.push({
          name: s.name,
          relPath: `${f.name}\\${s.name}`,
          items: inner.length,
          names: inner.filter((x) => x.isFile()).map((x) => x.name).slice(0, 300),
        });
        if (deepFolders.length >= 400) break;
      }
      if (deepFolders.length >= 400) break;
    }
  }

  return { dir: base, exists: true, folders: folders.slice(0, max), files: files.slice(0, 50), deepFolders };
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
