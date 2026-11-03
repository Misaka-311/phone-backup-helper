// 123 云盘开放平台（T3，默认关闭）。接口按官方文档实现：
//   POST /api/v1/access_token                      换 token（Header 需 Platform: open_platform）
//   POST /upload/v1/file/mkdir                     建目录 → dirID
//   POST /upload/v1/file/create                    秒传/预上传 → reuse|fileID|preuploadID|sliceSize
//   POST /upload/v1/file/get_upload_url            取某个分片的 presignedURL
//   PUT  <presignedURL>                            传分片（不要带 Authorization / Platform）
//   POST /upload/v1/file/list_upload_parts         查已传分片
//   POST /upload/v1/file/upload_complete           通知完成
//   POST /upload/v1/file/upload_async_result       异步轮询
//   GET  /api/v2/file/list                         列目录（游标 lastFileId）
//
// 注意：token 有效期 30 天，同一 clientID 同时最多 3 个 token，多发会互踢，
// 所以 token 缓存进 state 文件，不要每次运行都重新换。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class Open123Error extends Error {
  constructor(message, { code = 'API', status = 0, body = null, endpoint = '' } = {}) {
    super(message);
    this.name = 'Open123Error';
    this.code = code;
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Open123Client {
  constructor({
    baseURL = 'https://open-api.123pan.com',
    clientId = '',
    clientSecret = '',
    duplicate = 1,
    timeoutMs = 60000,
    fetchImpl = globalThis.fetch,
    token = null,
    onToken = null,
    log = null,
    retries = 5,
  } = {}) {
    this.baseURL = String(baseURL).replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.duplicate = duplicate;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.token = token || null;
    this.onToken = onToken;
    this.log = log;
    this.retries = retries;
    this.dirCache = new Map();
  }

  async rawRequest(url, { method = 'POST', headers = {}, body, baseURL = null } = {}) {
    const target = baseURL ? `${String(baseURL).replace(/\/+$/, '')}${url}` : `${this.baseURL}${url}`;
    const res = await this.fetchImpl(target, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { res, json, text };
  }

  async request(endpoint, { method = 'POST', body, auth = true, query = null } = {}) {
    let url = endpoint;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const headers = { 'Content-Type': 'application/json', Platform: 'open_platform' };
      if (auth) {
        const token = await this.ensureToken();
        headers.Authorization = `Bearer ${token}`;
      }
      const payload = method === 'GET' || body === undefined ? undefined : JSON.stringify(body);
      let res;
      let json;
      let text;
      try {
        ({ res, json, text } = await this.rawRequest(url, { method, headers, body: payload }));
      } catch (err) {
        lastError = new Open123Error(`网络错误：${err.message}`, { code: 'NETWORK', endpoint });
        if (attempt < this.retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      const code = json && typeof json.code !== 'undefined' ? Number(json.code) : res.status === 200 ? 0 : -1;
      if (res.status === 429 || code === 429) {
        lastError = new Open123Error('请求太频繁（429），稍后重试', { code: 'RATE_LIMIT', status: res.status, endpoint });
        if (attempt < this.retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
      if (res.status === 401 || code === 401) {
        this.token = null;
        if (this.onToken) this.onToken(null);
        lastError = new Open123Error('access_token 失效', { code: 'AUTH', status: res.status, endpoint });
        if (attempt < this.retries) continue;
        throw lastError;
      }
      if (res.status >= 500) {
        lastError = new Open123Error(`服务端错误 ${res.status}`, { code: 'SERVER', status: res.status, endpoint });
        if (attempt < this.retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
      if (!res.ok || code !== 0) {
        const msg = (json && (json.message || json.msg)) || text.slice(0, 200) || `HTTP ${res.status}`;
        const extra =
          code === 5113
            ? '（流量/配额超限，可在 123 官网查看套餐或错峰再试）'
            : code === 5066
              ? '（文件不存在）'
              : '';
        throw new Open123Error(`${msg}${extra}`, { code: code || res.status, status: res.status, body: json, endpoint });
      }
      return json ? json.data : null;
    }
    throw lastError || new Open123Error('请求失败', { endpoint });
  }

  async ensureToken() {
    if (this.token && this.token.accessToken) {
      const exp = this.token.expiredAt ? Date.parse(this.token.expiredAt) : 0;
      if (!exp || exp - 10 * 60 * 1000 > Date.now()) return this.token.accessToken;
    }
    if (!this.clientId || !this.clientSecret) {
      throw new Open123Error('缺少 123 开放平台的 clientId / clientSecret', {
        code: 'NO_CREDENTIAL',
        endpoint: '/api/v1/access_token',
      });
    }
    const data = await this.request('/api/v1/access_token', {
      method: 'POST',
      auth: false,
      body: { clientID: this.clientId, clientSecret: this.clientSecret },
    });
    if (!data || !data.accessToken) {
      throw new Open123Error('换 token 失败：返回里没有 accessToken', { code: 'TOKEN', endpoint: '/api/v1/access_token' });
    }
    this.token = { accessToken: data.accessToken, expiredAt: data.expiredAt || null };
    if (this.onToken) this.onToken(this.token);
    if (this.log) this.log.debug(`已获取 access_token（到期 ${this.token.expiredAt || '未知'}）`);
    return this.token.accessToken;
  }

  async mkdir(parentID, name) {
    const data = await this.request('/upload/v1/file/mkdir', { method: 'POST', body: { name, parentID } });
    if (!data || typeof data.dirID === 'undefined') {
      throw new Open123Error(`建目录失败：${name}`, { code: 'MKDIR', endpoint: '/upload/v1/file/mkdir' });
    }
    return Number(data.dirID);
  }

  async listDir(parentFileId, limit = 100) {
    const all = [];
    let lastFileId = 0;
    for (let guard = 0; guard < 200; guard++) {
      const data = await this.request('/api/v2/file/list', {
        method: 'GET',
        query: { parentFileId, limit, lastFileId: lastFileId || undefined },
      });
      const list = (data && data.fileList) || [];
      for (const f of list) all.push(f);
      const next = data && data.lastFileId;
      if (!next || next === -1 || list.length === 0) break;
      lastFileId = next;
    }
    return all;
  }

  /** 解析云端路径（形如 /a/b/c），按需建目录，返回 dirID */
  async resolveDir(remotePath, { create = true } = {}) {
    const parts = String(remotePath)
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    let id = 0;
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      if (this.dirCache.has(acc)) {
        id = this.dirCache.get(acc);
        continue;
      }
      const children = await this.listDir(id);
      const hit = children.find((f) => f.filename === part && Number(f.type) === 1);
      if (hit) {
        id = Number(hit.fileID);
      } else if (create) {
        id = await this.mkdir(id, part);
      } else {
        return null;
      }
      this.dirCache.set(acc, id);
    }
    return id;
  }

  async createFile({ parentFileID, filename, etag, size }) {
    return this.request('/upload/v1/file/create', {
      method: 'POST',
      body: { parentFileID, filename, etag, size, duplicate: this.duplicate },
    });
  }

  async getUploadUrl(preuploadID, sliceNo) {
    const data = await this.request('/upload/v1/file/get_upload_url', {
      method: 'POST',
      body: { preuploadID, sliceNo },
    });
    if (!data || !data.presignedURL) {
      throw new Open123Error('没拿到分片上传地址', { code: 'SIGN', endpoint: '/upload/v1/file/get_upload_url' });
    }
    return data.presignedURL;
  }

  async putSlice(presignedURL, buffer) {
    const res = await this.fetchImpl(presignedURL, {
      method: 'PUT',
      body: buffer,
      headers: { 'Content-Length': String(buffer.length) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Open123Error(`分片上传失败 HTTP ${res.status} ${t.slice(0, 120)}`, { code: 'SLICE' });
    }
  }

  async complete(preuploadID) {
    let data = await this.request('/upload/v1/file/upload_complete', {
      method: 'POST',
      body: { preuploadID },
    });
    if (data && data.async && !data.completed) {
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        data = await this.request('/upload/v1/file/upload_async_result', {
          method: 'POST',
          body: { preuploadID },
        });
        if (data && data.completed) break;
      }
    }
    if (!data || !data.completed || !(Number(data.fileID) > 0)) {
      throw new Open123Error('上传未完成（服务端未确认）', { code: 'INCOMPLETE', endpoint: '/upload/v1/file/upload_complete' });
    }
    return Number(data.fileID);
  }

  async listParts(preuploadID) {
    const data = await this.request('/upload/v1/file/list_upload_parts', {
      method: 'POST',
      body: { preuploadID },
    });
    return (data && data.parts) || [];
  }

  /** 上传一个本地文件，返回 fileID */
  async uploadFile({ localPath, parentFileID, filename, size, md5 }) {
    const etag = md5 || (await md5OfFile(localPath));
    const created = await this.createFile({ parentFileID, filename, etag, size });
    if (!created) throw new Open123Error('create 返回空', { code: 'CREATE', endpoint: '/upload/v1/file/create' });
    if (created.reuse) {
      if (this.log) this.log.debug(`秒传命中：${filename}`);
      return { fileID: Number(created.fileID), reuse: true };
    }
    const { preuploadID, sliceSize } = created;
    if (!preuploadID || !sliceSize) {
      throw new Open123Error('create 返回缺少 preuploadID/sliceSize', { code: 'CREATE' });
    }
    const fh = await fsp.open(localPath, 'r');
    try {
      const total = Math.max(1, Math.ceil(size / sliceSize));
      for (let sliceNo = 1; sliceNo <= total; sliceNo++) {
        const start = (sliceNo - 1) * sliceSize;
        const len = Math.min(sliceSize, size - start);
        const buf = Buffer.allocUnsafe(len);
        await fh.read(buf, 0, len, start);
        const url = await this.getUploadUrl(preuploadID, sliceNo);
        await this.putSlice(url, buf);
      }
    } finally {
      await fh.close();
    }
    const fileID = await this.complete(preuploadID);
    return { fileID, reuse: false };
  }
}

export async function md5OfFile(filePath) {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
