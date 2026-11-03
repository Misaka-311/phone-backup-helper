// 状态库：记录"哪些文件已经成功落盘 / 已上传云端"，保证重跑幂等、断点可续。
// 存储为单个 JSON，写入走「临时文件 + rename」的原子替换，Ctrl+C 不会写坏。

import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;

function emptyState() {
  return {
    version: VERSION,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastSuccessAt: null,
    files: {},
    pending: [],
    cloud: {},
    batches: [],
    counters: { runs: 0, copiedTotal: 0, uploadedTotal: 0 },
  };
}

export function recordKey(sourceId, remote) {
  return `${sourceId}|${String(remote).replace(/\\/g, '/')}`;
}

export class StateStore {
  constructor(filePath, data) {
    this.filePath = filePath;
    this.data = data || emptyState();
    if (!this.data.version) this.data.version = VERSION;
    if (!this.data.files) this.data.files = {};
    if (!Array.isArray(this.data.pending)) this.data.pending = [];
    if (!this.data.cloud) this.data.cloud = {};
    if (!Array.isArray(this.data.batches)) this.data.batches = [];
    if (!this.data.counters) this.data.counters = { runs: 0, copiedTotal: 0, uploadedTotal: 0 };
  }

  /* ---- 批次：每次导入记一笔，供"把这次新导入的导出到某处"使用 ---- */

  addBatch(batch) {
    this.data.batches.unshift(batch);
    if (this.data.batches.length > 50) this.data.batches.length = 50;
    return batch;
  }

  listBatches(limit = 10) {
    return this.data.batches.slice(0, limit);
  }

  getBatch(id) {
    return this.data.batches.find((b) => b.id === id) || null;
  }

  static async load(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return new StateStore(filePath, parsed);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // 文件损坏时保留现场，重新开一个新库
        try {
          await fs.rename(filePath, `${filePath}.broken.${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      return new StateStore(filePath, emptyState());
    }
  }

  getRecord(key) {
    return this.data.files[key] || null;
  }

  setRecord(key, record) {
    this.data.files[key] = { ...record, updatedAt: new Date().toISOString() };
  }

  removeRecord(key) {
    delete this.data.files[key];
  }

  get size() {
    return Object.keys(this.data.files).length;
  }

  markRunStart() {
    this.data.lastRunAt = new Date().toISOString();
    this.data.counters.runs = (this.data.counters.runs || 0) + 1;
  }

  markRunSuccess() {
    this.data.lastSuccessAt = new Date().toISOString();
  }

  addPending(item) {
    const key = item.key;
    const idx = this.data.pending.findIndex((p) => p.key === key);
    const entry = { ...item, key, queuedAt: new Date().toISOString(), attempts: 0 };
    if (idx >= 0) {
      this.data.pending[idx] = { ...this.data.pending[idx], ...entry, attempts: (this.data.pending[idx].attempts || 0) + 1 };
    } else {
      this.data.pending.push(entry);
    }
  }

  removePending(key) {
    this.data.pending = this.data.pending.filter((p) => p.key !== key);
  }

  listPending() {
    return this.data.pending.slice();
  }

  getToken() {
    const t = this.data.cloud && this.data.cloud.token;
    if (!t || !t.value) return null;
    if (t.expiresAt && Date.parse(t.expiresAt) - 10 * 60 * 1000 < Date.now()) return null;
    return t;
  }

  setToken(token) {
    this.data.cloud = this.data.cloud || {};
    this.data.cloud.token = token;
  }

  clearToken() {
    if (this.data.cloud) delete this.data.cloud.token;
  }

  async save() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const body = JSON.stringify(this.data, null, 1);
    await fs.writeFile(tmp, body, 'utf8');
    try {
      await fs.copyFile(this.filePath, `${this.filePath}.bak`);
    } catch {
      /* 首次没有旧文件，忽略 */
    }
    await fs.rename(tmp, this.filePath);
  }
}
