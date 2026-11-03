// 控制台表格 + HTML 报告

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { formatBytes, formatDay, formatDateTime, padEnd, table } from './util/format.mjs';
import { SKIP_LABELS } from './plan.mjs';

export async function getFreeSpace(p) {
  let probe = path.resolve(p);
  for (let i = 0; i < 8; i++) {
    try {
      const st = await fsp.statfs(probe);
      return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize), at: probe };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return null;
}

function line(width = 62) {
  return '─'.repeat(width);
}

export function renderPlanText({ plan, summary, ctx }) {
  const out = [];
  const showDisk = ctx.showDisk !== false;
  const title = ctx.dry ? '预演（本次不会修改任何文件）' : '执行前确认';
  out.push('');
  out.push('═'.repeat(62));
  out.push(`  手机备份助手 · ${title}`);
  out.push('═'.repeat(62));
  out.push(`手机：${ctx.phoneLabel}`);
  if (showDisk) out.push(`硬盘根：${ctx.root}${ctx.free ? `     剩余 ${formatBytes(ctx.free)}` : ''}`);
  out.push(`筛选：${ctx.filterDesc}`);
  out.push(`目标：${ctx.targetLabel || '硬盘 + 云盘'}`);
  out.push(line());

  const rows = summary.sources.map((s) => [
    s.remote,
    showDisk ? `→ ${s.dir.replace(ctx.root, '.')}` : `→ ${s.targetSubdir}`,
    `${s.add} 个`,
    `${formatBytes(s.addBytes)}`,
    `${s.skip} 个`,
  ]);
  out.push(
    table([showDisk ? '手机来源目录' : '手机来源目录', showDisk ? '硬盘落点' : '云盘子目录', '新增', '大小', '跳过'], rows, {
      align: ['left', 'left', 'right', 'right', 'right'],
    }),
  );
  out.push(line());

  if (summary.count === 0) {
    out.push('本次没有需要复制的新文件。');
  } else {
    out.push(`合计：${summary.count} 个文件 / ${formatBytes(summary.bytes)}`);
    const c = summary.byConfidence;
    out.push(`时间依据：文件名 ${c.filename} 个、EXIF ${c.exif} 个、修改时间 ${c.mtime} 个（不确定）`);
    const days = [...summary.byDay.entries()];
    if (days.length) {
      out.push('');
      out.push('按拍摄日期分布：');
      const chunks = [];
      for (let i = 0; i < days.length; i += 4) {
        chunks.push(days.slice(i, i + 4).map(([d, n]) => `${d}  ${String(n).padStart(3)} 个`).join('    '));
      }
      for (const c2 of chunks.slice(0, 12)) out.push(`  ${c2}`);
      if (chunks.length > 12) out.push(`  … 共 ${days.length} 个日期`);
    }
  }

  if (summary.skipped) {
    out.push('');
    const parts = [...summary.skipByCode.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${SKIP_LABELS[code] || code} ${n}`);
    out.push(`跳过 ${summary.skipped} 个：${parts.join('，')}`);
    if (summary.conflicts) out.push(`⚠ 其中 ${summary.conflicts} 个是「同名不同内容」，已按策略保留硬盘原文件`);
  }

  const examples = plan.skip.filter((s) => ['before', 'after', 'conflict', 'exists'].includes(s.code)).slice(0, 5);
  if (examples.length) {
    out.push('');
    out.push('跳过示例：');
    for (const e of examples) {
      const when = e.date ? formatDateTime(e.date) : '时间未知';
      out.push(`  ${padEnd(e.name, 34)} ${padEnd(when, 20)} ${SKIP_LABELS[e.code] || e.code}`);
    }
  }

  out.push(line());
  return out.join('\n');
}

export function renderCloudText(result) {
  if (!result) return '云端：未启用';
  if (result.error) return `云端（${result.mode}）这一步失败：${result.error}`;
  switch (result.mode) {
    case 'handoff': {
      const lines = [`云端：交给 123 云盘客户端「备份盘」增量上传（免费方案）`];
      if (result.watchDirs && result.watchDirs.length) {
        lines.push(`  需在客户端里把备份源指向：`);
        for (const d of result.watchDirs) lines.push(`    ${d}`);
      }
      for (const w of result.warnings || []) lines.push(`  ! ${w}`);
      return lines.join('\n');
    }
    case 'mount':
      return `云端：写挂载盘 ${result.drive}\\${String(result.remoteRoot).replace(/^\\+/, '')} → 成功 ${result.uploaded.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`;
    case 'open123':
      return `云端：123 开放平台 API → 成功 ${result.uploaded}，秒传 ${result.reuse}，失败 ${result.failed}（已进待补传）`;
    case 'off':
      return '云端：本次未启用';
    default:
      return `云端：${result.mode}`;
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderHtml({ ctx, plan, summary, run }) {
  const dayRows = [...summary.byDay.entries()]
    .map(([d, n]) => `<tr><td>${esc(d)}</td><td class="num">${n}</td></tr>`)
    .join('');

  const srcRows = summary.sources
    .map(
      (s) =>
        `<tr><td class="mono">${esc(s.remote)}</td><td class="mono">${esc(s.dir)}</td><td class="num">${s.add}</td><td class="num">${formatBytes(s.addBytes)}</td><td class="num">${s.skip}</td></tr>`,
    )
    .join('');

  const copyRows = plan.copy
    .map(
      (i) =>
        `<tr><td class="mono">${esc(i.relPath)}</td><td>${i.date ? esc(formatDay(i.date)) : '-'}</td><td class="num">${formatBytes(i.size)}</td><td>${esc(i.confidence)}</td></tr>`,
    )
    .join('');

  const skipRows = plan.skip
    .slice(0, 500)
    .map(
      (i) =>
        `<tr class="dim"><td class="mono">${esc(i.relPath)}</td><td>${esc(SKIP_LABELS[i.code] || i.code)}</td><td>${i.date ? esc(formatDay(i.date)) : '-'}</td></tr>`,
    )
    .join('');

  const failureRows = (run.failures || [])
    .map((f) => `<tr class="err"><td class="mono">${esc(f.name || f.path)}</td><td>${esc(f.error)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>手机备份报告 ${esc(ctx.dateLabel)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; margin: 32px; max-width: 1080px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  .sub { color: #888; margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 8px; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 10px 14px; min-width: 120px; }
  .card b { display: block; font-size: 20px; }
  .card span { color: #888; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; }
  th, td { border-bottom: 1px solid #8883; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { font-weight: 600; color: #666; font-size: 12px; }
  .num { text-align: right; white-space: nowrap; }
  .mono { font-family: Consolas, ui-monospace, monospace; word-break: break-all; }
  .dim { color: #888; }
  .err td { color: #c0392b; }
  .note { background: #8881; border-radius: 8px; padding: 10px 14px; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>手机备份报告</h1>
<div class="sub">${esc(ctx.dateLabel)} · 手机：${esc(ctx.phoneLabel)} · 硬盘根：${esc(ctx.root)}</div>

<div class="cards">
  <div class="card"><b>${summary.count}</b><span>本次新增文件</span></div>
  <div class="card"><b>${formatBytes(summary.bytes)}</b><span>新增体积</span></div>
  <div class="card"><b>${run.copied ?? 0}</b><span>已落盘</span></div>
  <div class="card"><b>${summary.skipped}</b><span>跳过</span></div>
  <div class="card"><b>${summary.conflicts}</b><span>同名冲突</span></div>
</div>

<div class="note">目标：${esc(ctx.targetLabel || '硬盘 + 云盘')}
筛选：${esc(ctx.filterDesc)}
云端：${esc(ctx.cloudSummary || '未启用')}</div>

<h2>来源 → 落点</h2>
<table><thead><tr><th>手机来源</th><th>硬盘落点</th><th class="num">新增</th><th class="num">大小</th><th class="num">跳过</th></tr></thead>
<tbody>${srcRows}</tbody></table>

<h2>按拍摄日期</h2>
<table><thead><tr><th>日期</th><th class="num">数量</th></tr></thead><tbody>${dayRows || '<tr><td colspan="2">无</td></tr>'}</tbody></table>

<h2>本次新增清单（${summary.count}）</h2>
<table><thead><tr><th>文件</th><th>拍摄日期</th><th class="num">大小</th><th>时间依据</th></tr></thead>
<tbody>${copyRows || '<tr><td colspan="4">无</td></tr>'}</tbody></table>

${failureRows ? `<h2>失败</h2><table><thead><tr><th>文件</th><th>原因</th></tr></thead><tbody>${failureRows}</tbody></table>` : ''}

<h2>跳过清单（最多显示 500 条，共 ${summary.skipped}）</h2>
<table><thead><tr><th>文件</th><th>原因</th><th>拍摄日期</th></tr></thead><tbody>${skipRows || '<tr><td colspan="3">无</td></tr>'}</tbody></table>

<p class="sub" style="margin-top:28px">由「手机备份助手」自动生成 · ${esc(new Date().toLocaleString('zh-CN'))}</p>
</body>
</html>`;
}

export async function writeHtmlReport({ reportsDir, ctx, plan, summary, run }) {
  await fsp.mkdir(reportsDir, { recursive: true });
  const name = `备份报告-${ctx.dateLabel.replace(/[: ]/g, '-')}${ctx.dry ? '-预演' : ''}.html`;
  const file = path.join(reportsDir, name);
  await fsp.writeFile(file, renderHtml({ ctx, plan, summary, run }), 'utf8');
  return file;
}

export function openInBrowser(file) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', file], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
