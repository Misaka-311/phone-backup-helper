import fs from 'node:fs';
import path from 'node:path';

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[36m',
  gray: '\u001b[90m',
};

function paint(text, color, enabled) {
  return enabled ? `${color}${text}${COLORS.reset}` : text;
}

export function createLogger({ logDir, logName, silent = false, color } = {}) {
  const useColor =
    color !== undefined
      ? color
      : Boolean(process.stdout && process.stdout.isTTY) && !process.env.NO_COLOR;
  let fileStream = null;

  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const name = logName || `${new Date().toISOString().slice(0, 10)}.log`;
      fileStream = fs.createWriteStream(path.join(logDir, name), { flags: 'a' });
      // 目录只读或磁盘满时，写流会异步抛 error；必须吞掉，不能让它把整个程序带崩
      fileStream.on('error', () => {
        fileStream = null;
      });
    } catch {
      fileStream = null;
    }
  }

  const write = (line) => {
    if (fileStream) {
      try {
        fileStream.write(line.replace(/\u001b\[[0-9;]*m/g, '') + '\n');
      } catch {
        /* 日志写失败不影响主流程 */
      }
    }
    if (!silent) process.stdout.write(line + '\n');
  };

  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  return {
    raw: write,
    plain: (s = '') => write(s),
    info: (s) => write(`${paint('·', COLORS.gray, useColor)} ${s}`),
    step: (s) => write(`\n${paint('▶', COLORS.blue, useColor)} ${s}`),
    ok: (s) => write(`${paint('✓', COLORS.green, useColor)} ${s}`),
    warn: (s) => write(`${paint('!', COLORS.yellow, useColor)} ${s}`),
    error: (s) => write(`${paint('✗', COLORS.red, useColor)} ${s}`),
    debug: (s) => write(paint(`  ${stamp()} ${s}`, COLORS.dim, useColor)),
    close: () => {
      if (fileStream) {
        try {
          fileStream.end();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export { COLORS };
