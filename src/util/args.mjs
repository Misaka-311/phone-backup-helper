// 极简命令行参数解析：支持 --k v、--k=v、--flag
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq > -1) {
        out[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith('--')) {
        out[body] = next;
        i++;
      } else {
        out[body] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function isFlagOn(v) {
  if (v === true) return true;
  if (v === undefined || v === null || v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
