/* 手机备份助手 · 界面逻辑（原生 JS，无依赖）
   来源可以是手机，也可以是任意一块硬盘上的文件夹；
   来源按"大文件夹 → 小文件夹"分栏，每个小文件夹单独对应到目标。 */

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  volumes: [],
  paths: {},
  sourceKind: 'phone',
  sourceRoot: '',
  sourceLabel: '',
  tree: null, // {kind, root, groups:[{name,count,children:[...]}]}
  childByPath: new Map(),
  picks: new Map(), // path -> {checked, subdir}
  destRoot: '',
  destFolders: [],
  destDeep: [],
  scan: null,
  selected: new Set(),
  batches: [],
  importing: false,
  extCats: new Set(['photo', 'video']),
};

/* ------------------------------ 小工具 ------------------------------ */

function log(msg, kind = '') {
  const pre = $('#log');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = `[${t}] ${msg}`;
  pre.appendChild(line);
  pre.scrollTop = pre.scrollHeight;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(pathname, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(pathname, opt);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `请求失败：${pathname}`);
  return json;
}

async function pollJob(jobId, onTick) {
  for (let i = 0; i < 20000; i += 1) {
    await sleep(400);
    const { job } = await api(`/api/job?id=${encodeURIComponent(jobId)}`);
    if (onTick) onTick(job);
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw new Error(job.error || '任务失败');
  }
  throw new Error('任务超时');
}

function setProgress(sel, job) {
  const wrap = $(sel);
  wrap.classList.remove('hidden');
  const p = job.progress || {};
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  wrap.querySelector('.bar i').style.width = `${pct}%`;
  wrap.querySelector('.pct').textContent = p.total ? `${p.done}/${p.total}（${pct}%）` : job.message || '处理中…';
}

function hideProgress(sel) {
  $(sel).classList.add('hidden');
}

/* ------------------------------ 初始化 ------------------------------ */

async function loadOverview() {
  const data = await api('/api/overview');
  S.volumes = data.volumes || [];
  S.paths = data.paths || {};
  S.batches = data.batches || [];
  S.sourceKind = data.sourceSpec?.kind || 'phone';
  S.sourceRoot = data.sourceSpec?.root || '';

  const p = data.source || data.phone || {};
  if (p.ok) S.sourceLabel = p.label || '';
  updateBadge(p);

  fillDriveSelect('#driveSel');
  fillDriveSelect('#srcDriveSel');

  const curRoot = data.config.root || '';
  const curLetter = (curRoot.match(/^([A-Za-z]:)/) || [])[1];
  if (curLetter) $('#driveSel').value = curLetter;
  $('#rootInput').value = curRoot;
  $('#targetSel').value = data.config.target || 'disk';
  $('#exportDir').value = `${S.paths.desktop || ''}\\手机备份-导出`;
  S.destRoot = curRoot;

  updateDriveInfo();
  renderBatches();
  applySourceKindUI();

  if (S.sourceKind === 'folder') {
    $('#srcRoot').value = S.sourceRoot;
    const l = (S.sourceRoot.match(/^([A-Za-z]:)/) || [])[1];
    if (l) $('#srcDriveSel').value = l;
  }

  if (curRoot) await listDestFolders().catch(() => {});
}

function fillDriveSelect(sel) {
  const el = $(sel);
  el.innerHTML = '';
  for (const v of S.volumes) {
    const o = document.createElement('option');
    o.value = v.letter;
    o.textContent = `${v.letter}${v.label ? ` ${v.label}` : ''}（剩 ${fmtBytes(v.free)}）`;
    el.appendChild(o);
  }
}

function updateDriveInfo() {
  const letter = $('#driveSel').value;
  const v = S.volumes.find((x) => x.letter === letter);
  $('#driveInfo').textContent = v ? `共 ${fmtBytes(v.total)}，剩 ${fmtBytes(v.free)}` : '';
}

function updateBadge(source) {
  const badge = $('#phoneBadge');
  if (source?.ok) {
    badge.className = 'phone ok';
    badge.textContent = `✓ ${source.label}`;
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  } else {
    badge.className = 'phone bad';
    badge.textContent = `✗ ${source?.error || '来源不可用'}`;
    if (S.sourceKind === 'phone') scheduleRetry();
  }
}

/* --------------------------- 1 数据来源 --------------------------- */

function applySourceKindUI() {
  document.querySelectorAll('#sourceSeg .segBtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.kind === S.sourceKind);
  });
  $('#sourceFolderRow').classList.toggle('hidden', S.sourceKind !== 'folder');
  $('#sourceHint').textContent =
    S.sourceKind === 'phone'
      ? `当前来源：手机（${S.sourceLabel || '未连接'}）`
      : `当前来源：硬盘文件夹 ${S.sourceRoot || '（未选择）'}`;
}

document.querySelectorAll('#sourceSeg .segBtn').forEach((btn) => {
  btn.onclick = async () => {
    const kind = btn.dataset.kind;
    if (kind === S.sourceKind) return;
    if (kind === 'folder') {
      S.sourceKind = 'folder';
      applySourceKindUI();
      return;
    }
    try {
      const { source } = await api('/api/source/choose', { kind: 'phone' });
      S.sourceKind = 'phone';
      S.sourceLabel = source.ok ? source.label : '';
      resetTree();
      applySourceKindUI();
      updateBadge(source);
      log('已切到手机来源', 'ok');
    } catch (e) {
      log(e.message, 'bad');
    }
  };
});

$('#srcDriveSel').onchange = () => {
  $('#srcRoot').value = `${$('#srcDriveSel').value}\\`;
};

$('#btnChooseSource').onclick = async () => {
  const root = $('#srcRoot').value.trim();
  if (!root) return alert('先填要作为来源的文件夹');
  try {
    const { source } = await api('/api/source/choose', { kind: 'folder', root });
    const letter = (root.match(/^([A-Za-z]:)/) || [])[1];
    if (letter) $('#srcDriveSel').value = letter;
    S.sourceKind = 'folder';
    S.sourceRoot = root;
    S.sourceLabel = source.ok ? source.label : '';
    resetTree();
    applySourceKindUI();
    updateBadge(source);
    log(`来源已切换：${root}`, 'ok');
  } catch (e) {
    alert(e.message);
  }
};

function resetTree() {
  S.tree = null;
  S.childByPath = new Map();
  S.picks = new Map();
  $('#tree').innerHTML = '';
  $('#cmpBody').innerHTML = '';
  $('#compareBox').classList.add('hidden');
  $('#groups').innerHTML = '';
  $('#scanSummary').classList.add('hidden');
  $('#mapHint').textContent = '先扫描来源文件夹';
}

/* ----------------------------- 2 目标 ----------------------------- */

$('#driveSel').onchange = () => {
  const letter = $('#driveSel').value;
  const v = S.volumes.find((x) => x.letter === letter);
  $('#rootInput').value = `${letter}\\${v && v.label ? v.label : '手机备份'}`;
  updateDriveInfo();
  listDestFolders().catch((e) => log(e.message, 'bad'));
};

$('#btnListRoot').onclick = () => listDestFolders().catch((e) => log(e.message, 'bad'));

$('#btnNewFolder').onclick = async () => {
  const name = $('#newFolderName').value.trim();
  const base = $('#rootInput').value.trim();
  if (!name || !base) return alert('先填目标路径和文件夹名');
  try {
    const made = await api('/api/fs/mkdir', { dir: `${base}\\${name}` });
    $('#rootInput').value = made.dir;
    $('#newFolderName').value = '';
    await listDestFolders();
    log(`已创建：${made.dir}`, 'ok');
  } catch (e) {
    log(e.message, 'bad');
  }
};

async function listDestFolders() {
  const dir = $('#rootInput').value.trim();
  if (!dir) return;
  const res = await api('/api/fs/list', { dir, withNames: true });
  S.destRoot = dir;
  S.destFolders = res.exists ? res.folders : [];
  S.destDeep = res.deepFolders || [];
  const letter = (dir.match(/^([A-Za-z]:)/) || [])[1];
  if (letter) {
    $('#driveSel').value = letter;
    updateDriveInfo();
  }
  // 记住这次选的目标（下次打开界面直接用）
  api('/api/config', { root: dir }).catch(() => {});
  renderChips(res);
  if (S.tree) renderTree();
}

function renderChips(res) {
  const chips = $('#rootChips');
  chips.innerHTML = '';
  if (!res.exists) {
    chips.innerHTML = '<span class="hint">这个路径还不存在，执行时会自动创建。</span>';
    return;
  }
  if (!res.folders.length) {
    chips.innerHTML = '<span class="hint">这个文件夹里还没有子文件夹。</span>';
    return;
  }
  for (const f of res.folders) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `${escapeHtml(f.name)}<span class="n">${f.items == null ? '' : f.items}</span>`;
    c.title = f.path;
    c.onclick = async () => {
      $('#rootInput').value = f.path;
      document.querySelectorAll('#rootChips .chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      await listDestFolders();
    };
    chips.appendChild(c);
  }
}

/* --------------------- 3 来源分栏 + 逐个对应 --------------------- */

$('#btnListSource').onclick = async () => {
  $('#btnListSource').disabled = true;
  $('#mapHint').textContent = '正在读来源…（文件夹多的话要等几秒）';
  try {
    if (!S.destFolders.length) await listDestFolders().catch(() => {});
    const tree = await api('/api/source/tree', {});
    S.tree = tree;
    S.childByPath = new Map();
    S.picks = new Map();
    for (const g of tree.groups) {
      for (const c of g.children) {
        S.childByPath.set(c.path, c);
        S.picks.set(c.path, { checked: false, subdir: defaultSubdir(c) });
      }
    }
    autoPick();
    renderTree();
    $('#btnPickAll').disabled = false;
    $('#btnPickNone').disabled = false;
    const n = [...S.picks.values()].filter((p) => p.checked).length;
    $('#mapHint').textContent = `读到 ${tree.groups.length} 个大文件夹、${S.childByPath.size} 个小文件夹；已按内容勾选 ${n} 个，你可以逐个改`;
    log(`来源目录树：${tree.groups.length} 组 / ${S.childByPath.size} 个小文件夹`, 'ok');
  } catch (e) {
    $('#mapHint').textContent = '读取失败';
    log(e.message, 'bad');
  } finally {
    $('#btnListSource').disabled = false;
  }
};

$('#btnAutoMap').onclick = () => {
  if (!S.tree) return;
  autoPick();
  renderTree();
  const n = [...S.picks.values()].filter((p) => p.checked).length;
  $('#mapHint').textContent = `已按内容自动勾选 ${n} 个（只有内容高度重合的才会自动勾）`;
};

function normalizeName(s) {
  return String(s).toLowerCase().replace(/[\s_\-（）()]+/g, '');
}

function scorePair(child, dest) {
  const a = new Set((child.names || []).map((n) => String(n).toLowerCase()));
  const b = new Set((dest.names || []).map((n) => String(n).toLowerCase()));
  let inter = 0;
  for (const n of a) if (b.has(n)) inter += 1;
  const denom = Math.max(1, Math.min(a.size, b.size));
  const overlap = a.size && b.size ? inter / denom : 0;

  const na = normalizeName(child.name);
  const nb = normalizeName(dest.name);
  const nameScore = na === nb ? 1 : na && nb && (na.includes(nb) || nb.includes(na)) ? 0.7 : 0;

  return { score: overlap * 0.75 + nameScore * 0.25, overlap, inter, dest };
}

function bestSuggestion(child) {
  const cands = [
    ...S.destFolders.map((d) => ({ ...d, sub: d.name })),
    ...(S.destDeep || []).map((d) => ({ ...d, sub: d.relPath })),
  ];
  let best = null;
  for (const d of cands) {
    const r = scorePair(child, d);
    if (!best || r.score > best.score) best = { ...r, dest: d, sub: d.sub };
  }
  return best;
}

/** 找到 child 默认对应路径（大文件夹\小文件夹）在目标里的那个文件夹，并算出同名情况 */
function targetInfo(child) {
  const struct = defaultSubdir(child);
  const d =
    (S.destDeep || []).find((x) => x.relPath === struct) ||
    (S.destFolders || []).find((x) => x.name === struct) ||
    null;
  if (!d) return null;
  const r = scorePair(child, d);
  return {
    relPath: struct,
    items: Number.isFinite(d.items) ? d.items : (d.names || []).length,
    inter: r.inter,
    overlap: r.overlap,
  };
}

/** 默认勾选：目标已有同名文件夹、或内容高度重合的才勾；其余留给你自己决定 */
function autoPick() {
  let forced = 0;
  for (const [path, pick] of S.picks) {
    const child = S.childByPath.get(path);
    const struct = defaultSubdir(child);
    const info = targetInfo(child);

    if (info) {
      pick.checked = true;
      pick.subdir = struct;
      pick.reason =
        info.inter > 0
          ? `同名文件夹：目标 ${info.items} 个，同名 ${info.inter} 个（${Math.round(info.overlap * 100)}%）`
          : '同名文件夹已存在，但里面没有同名文件';
      forced += 1;
      continue;
    }

    const best = bestSuggestion(child);
    if (best && best.score >= 0.5) {
      pick.checked = true;
      pick.subdir = best.sub;
      pick.reason = `名字不同，但内容重合 ${Math.round(best.overlap * 100)}%`;
      forced += 1;
    } else {
      pick.checked = false;
      pick.subdir = pick.subdir || struct;
      pick.reason = '';
    }
  }
  return forced;
}

function childGroupName(path) {
  const c = S.childByPath.get(path);
  return c?.parent || '';
}

/** 默认目标：保持「大文件夹\小文件夹」的结构 */
function defaultSubdir(child) {
  return child.parent ? `${child.parent}\\${child.name}` : child.name;
}

function renderTree() {
  const wrap = $('#tree');
  wrap.innerHTML = '';
  if (!S.tree) return;

  const shows = S.tree.groups.filter((g) => g.children.length);

  for (const g of shows) {
    const card = document.createElement('div');
    card.className = 'tgroup';

    const head = document.createElement('div');
    head.className = 'tgroupHead';
    const name = document.createElement('span');
    name.className = 'tgroupName';
    name.textContent = g.name;
    const cnt = document.createElement('span');
    cnt.className = 'badge';
    cnt.textContent = `${g.children.length} 个子文件夹 · ${g.count} 个文件`;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const all = document.createElement('button');
    all.className = 'ghost mini';
    all.textContent = '全选';
    const none = document.createElement('button');
    none.className = 'ghost mini';
    none.textContent = '全不选';
    none.style.marginLeft = '6px';
    head.append(name, cnt, spacer, all, none);

    const body = document.createElement('div');
    body.className = 'tgroupBody';

    for (const c of g.children) {
      const pick = S.picks.get(c.path);
      const row = document.createElement('div');
      row.className = 'trow';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = pick.checked;
      cb.onchange = () => {
        pick.checked = cb.checked;
        updateMapHint();
      };

      const label = document.createElement('div');
      label.className = 'tlabel';
      const info = targetInfo(c);
      const subline = info
        ? info.inter > 0
          ? `目标已有 ${info.items} 个 · 同名 ${info.inter} 个（${Math.round(info.overlap * 100)}%）`
          : `目标已有这个文件夹（${info.items} 个文件），但没同名文件`
        : '';
      label.innerHTML =
        `<span class="tname">${escapeHtml(c.name)}</span>` +
        `<span class="tcount">${c.count} 个</span>` +
        (subline ? `<span class="tsub">${subline}</span>` : '');

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';

      const sel = document.createElement('select');
      sel.className = 'tdest';

      const struct = defaultSubdir(c);
      const structExists =
        (S.destDeep || []).some((d) => d.relPath === struct) || (S.destFolders || []).some((d) => d.name === struct);

      const structOpt = document.createElement('option');
      structOpt.value = struct;
      structOpt.textContent = structExists ? `✔ 已有：${struct}` : `＋ 新建：${struct}`;
      sel.appendChild(structOpt);

      if (c.parent) {
        const flatExists = (S.destFolders || []).some((d) => d.name === c.name);
        const flatOpt = document.createElement('option');
        flatOpt.value = c.name;
        flatOpt.textContent = flatExists ? `✔ 已有：${c.name}（平铺）` : `＋ 新建：${c.name}（平铺）`;
        sel.appendChild(flatOpt);
      }

      for (const d of S.destFolders) {
        if (d.name === struct || d.name === c.name) continue;
        const o = document.createElement('option');
        o.value = d.name;
        o.textContent = `✔ 已有：${d.name}`;
        sel.appendChild(o);
      }
      for (const d of S.destDeep || []) {
        if (d.relPath === struct) continue;
        const o = document.createElement('option');
        o.value = d.relPath;
        o.textContent = `✔ 已有：${d.relPath}`;
        sel.appendChild(o);
      }

      sel.value = pick.subdir && [...sel.options].some((o) => o.value === pick.subdir) ? pick.subdir : struct;
      sel.onchange = () => {
        pick.subdir = sel.value;
        pick.checked = true;
        cb.checked = true;
        updateMapHint();
      };

      const sugg = document.createElement('span');
      sugg.className = 'tsugg';
      if (pick.checked && pick.reason) {
        sugg.textContent = '✓ 自动勾选';
        sugg.title = pick.reason;
        sugg.classList.add('on');
      }

      row.append(cb, label, arrow, sel, sugg);
      body.appendChild(row);
    }

    all.onclick = () => {
      for (const c of g.children) {
        const p = S.picks.get(c.path);
        p.checked = true;
        if (!p.subdir) p.subdir = c.name;
      }
      renderTree();
      updateMapHint();
    };
    none.onclick = () => {
      for (const c of g.children) S.picks.get(c.path).checked = false;
      renderTree();
      updateMapHint();
    };

    card.append(head, body);
    wrap.appendChild(card);
  }
}

function updateMapHint() {
  const n = [...S.picks.values()].filter((p) => p.checked).length;
  $('#mapHint').textContent = n ? `已选 ${n} 个小文件夹参与对比` : '还没有勾选任何文件夹';
  $('#scanHint').textContent = n ? `已对应 ${n} 个文件夹` : '还没有对应任何文件夹';
}

function currentMapping() {
  const out = [];
  for (const [path, pick] of S.picks) {
    if (!pick.checked) continue;
    const child = S.childByPath.get(path);
    out.push({
      remote: path,
      subdir: pick.subdir || defaultSubdir(child),
      depth: Number.isFinite(child.depth) ? child.depth : undefined,
      name: child.name,
    });
  }
  return out;
}

$('#btnPickAll').onclick = () => {
  for (const [path, pick] of S.picks) {
    pick.checked = true;
    if (!pick.subdir) pick.subdir = defaultSubdir(S.childByPath.get(path));
  }
  renderTree();
  updateMapHint();
};

$('#btnPickNone').onclick = () => {
  for (const pick of S.picks.values()) pick.checked = false;
  renderTree();
  updateMapHint();
};

/* --------------------------- 4 对比与勾选 --------------------------- */

const EXT_CATS = {
  photo: ['.jpg', '.jpeg', '.jfif', '.heic', '.heif', '.png', '.webp', '.dng'],
  video: ['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.3gp', '.wmv', '.ts', '.flv'],
  doc: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.md', '.rtf', '.epub'],
  archive: ['.zip', '.rar', '.7z', '.tar', '.gz'],
};

function currentExts() {
  if (S.extCats.has('all')) return null; // null = 不按扩展名筛
  const out = [];
  for (const cat of S.extCats) {
    if (cat === 'all') continue;
    out.push(...(EXT_CATS[cat] || []));
  }
  return [...new Set(out)];
}

function renderExtCats() {
  document.querySelectorAll('#extCats .cat').forEach((b) => {
    b.classList.toggle('active', S.extCats.has(b.dataset.cat));
  });
  const exts = currentExts();
  if (S.extCats.has('all')) $('#extHint').textContent = '不按扩展名筛：什么文件都要（含未知类型）';
  else if (!S.extCats.size) $('#extHint').textContent = '至少选一类文件';
  else $('#extHint').textContent = `共 ${exts.length} 种扩展名：${exts.slice(0, 8).join(' ')}${exts.length > 8 ? ' …' : ''}`;
  $('#btnScanNew').disabled = S.extCats.size === 0;
}

document.querySelectorAll('#extCats .cat').forEach((btn) => {
  btn.onclick = () => {
    const cat = btn.dataset.cat;
    if (cat === 'all') {
      S.extCats = S.extCats.has('all') ? new Set() : new Set(['all']);
    } else {
      S.extCats.delete('all');
      if (S.extCats.has(cat)) S.extCats.delete(cat);
      else S.extCats.add(cat);
    }
    renderExtCats();
  };
});

async function scanNew() {
  const mapping = currentMapping();
  if (!mapping.length) return alert('先在「文件夹对应」里勾选至少一个小文件夹');
  const root = $('#rootInput').value.trim();
  if (!root) return alert('先选目标盘和路径');
  if (!S.extCats.size) return alert('先在下面选至少一类文件（照片/视频/文档…）');

  const target = $('#targetSel').value;
  const targets = { disk: target !== 'cloud', cloud: target !== 'disk' };
  const exts = currentExts();
  const onlyMedia = !S.extCats.has('all') && [...S.extCats].every((c) => c === 'photo' || c === 'video');

  $('#btnScanNew').disabled = true;
  $('#scanHint').textContent = '正在对比…';
  $('#groups').innerHTML = '';
  $('#compareBox').classList.add('hidden');
  $('#scanSummary').classList.add('hidden');

  try {
    const { jobId } = await api('/api/scan', {
      root,
      mapping,
      since: $('#since').value || null,
      until: $('#until').value || null,
      exts,
      minSizeBytes: onlyMedia ? 1024 : 0,
      targets,
    });
    const result = await pollJob(jobId, (job) => {
      $('#scanHint').textContent = `${job.message} ${job.progress?.total ? `(${job.progress.done}/${job.progress.total})` : ''}`;
    });
    S.scan = result;
    S.selected = new Set(result.files.map((f) => f.key));
    renderCompare(result);
    renderGroups(result);
    log(`对比完成：新增 ${result.totals.count} 个（${fmtBytes(result.totals.bytes)}）`, 'ok');
  } catch (e) {
    $('#scanHint').textContent = '对比失败';
    log(e.message, 'bad');
  } finally {
    $('#btnScanNew').disabled = false;
  }
}

function renderCompare(result) {
  const stats = result.folderStats || [];
  const body = $('#cmpBody');
  body.innerHTML = '';
  for (const s of stats) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="mono">${escapeHtml(s.remote)}</span></td>
      <td><span class="mono">${escapeHtml(s.folder)}</span></td>
      <td class="num">${s.sourceCount}</td>
      <td class="num">${s.destCount}</td>
      <td class="num ${s.add ? 'hl' : ''}">${s.add}</td>
      <td class="num">${fmtBytes(s.addBytes)}</td>`;
    body.appendChild(tr);
  }
  $('#compareBox').classList.toggle('hidden', !stats.length);

  const sum = $('#scanSummary');
  sum.classList.remove('hidden');
  sum.innerHTML = `
    <div>新增<b>${result.totals.count}</b>个</div>
    <div>体积<b>${fmtBytes(result.totals.bytes)}</b></div>
    <div>跳过<b>${result.totals.skipped}</b>个</div>
    <div>涉及<b>${stats.length}</b>个文件夹</div>`;
}

function renderGroups(result) {
  const wrap = $('#groups');
  wrap.innerHTML = '';

  if (result.sourceErrors?.length) {
    const warn = document.createElement('div');
    warn.className = 'hint';
    warn.style.color = 'var(--bad)';
    warn.textContent = `有 ${result.sourceErrors.length} 个文件夹读不了：` +
      result.sourceErrors.map((e) => `${e.remote}（${e.error}）`).join('；');
    wrap.appendChild(warn);
  }

  if (!result.files.length) {
    wrap.insertAdjacentHTML('beforeend', '<div class="hint">没有新增文件。</div>');
    updateSelCount();
    return;
  }

  const byFolder = new Map();
  for (const f of result.files) {
    if (!byFolder.has(f.folder)) byFolder.set(f.folder, []);
    byFolder.get(f.folder).push(f);
  }

  for (const [folder, files] of byFolder) {
    const g = document.createElement('div');
    g.className = 'group';

    const head = document.createElement('div');
    head.className = 'groupHead';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = `→ ${folder}`;
    const badge = document.createElement('span');
    badge.className = 'badge';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const toggle = document.createElement('span');
    toggle.className = 'hint';
    toggle.textContent = '收起';
    head.append(cb, title, badge, spacer, toggle);

    const body = document.createElement('div');
    body.className = 'groupBody';
    const rows = [];
    const RENDER_MAX = 200;
    const shown = files.slice(0, RENDER_MAX);

    for (const f of shown) {
      const row = document.createElement('label');
      row.className = 'fileRow';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = S.selected.has(f.key);
      c.onchange = () => {
        if (c.checked) S.selected.add(f.key);
        else S.selected.delete(f.key);
        syncHead();
        updateSelCount();
      };
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = f.relPath || f.name;
      name.title = f.remote;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${fmtDate(f.date)} · ${fmtBytes(f.size)}`;

      const actions = document.createElement('span');
      actions.className = 'rowActions';

      const eye = document.createElement('button');
      eye.className = 'iconBtn';
      eye.textContent = '👁';
      eye.title = '用 Windows 看图打开（没导到硬盘的会先从手机取过来）';
      eye.onclick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        eye.disabled = true;
        try {
          await api('/api/preview', { key: f.key });
          log(`已用系统看图打开：${f.name}`, 'ok');
        } catch (e) {
          log(`预览失败：${e.message}`, 'bad');
        } finally {
          eye.disabled = false;
        }
      };

      const locate = document.createElement('button');
      locate.className = 'iconBtn';
      locate.textContent = '📁';
      locate.title = '在文件夹里定位这个文件';
      locate.onclick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          await api('/api/reveal', { key: f.key });
        } catch (e) {
          log(`定位失败：${e.message}`, 'bad');
        }
      };

      actions.append(eye, locate);
      row.append(c, name, meta, actions);
      body.appendChild(row);
      rows.push({ c, key: f.key });
    }

    if (files.length > RENDER_MAX) {
      const more = document.createElement('div');
      more.className = 'hint';
      more.style.padding = '8px 14px';
      more.textContent = `还有 ${files.length - RENDER_MAX} 个没列出来（勾选整组会连同它们一起处理）`;
      body.appendChild(more);
    }

    function syncHead() {
      const on = files.filter((f) => S.selected.has(f.key));
      cb.checked = on.length === files.length;
      cb.indeterminate = on.length > 0 && on.length < files.length;
      badge.textContent = `${on.length}/${files.length} 个 · ${fmtBytes(on.reduce((a, b) => a + b.size, 0))}`;
    }

    cb.onchange = () => {
      for (const f of files) {
        if (cb.checked) S.selected.add(f.key);
        else S.selected.delete(f.key);
      }
      for (const r of rows) r.c.checked = cb.checked;
      syncHead();
      updateSelCount();
    };

    head.onclick = (ev) => {
      if (ev.target === cb) return;
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      toggle.textContent = hidden ? '收起' : '展开';
    };

    syncHead();
    g.append(head, body);
    wrap.appendChild(g);
  }

  updateSelCount();
}

function updateSelCount() {
  const files = S.scan?.files || [];
  const picked = files.filter((f) => S.selected.has(f.key));
  const bytes = picked.reduce((a, b) => a + b.size, 0);
  $('#selCount').textContent = `已选 ${picked.length} 个（${fmtBytes(bytes)}）`;
  $('#btnImport').disabled = picked.length === 0 || S.importing;
}

/* ----------------------------- 5 执行 ----------------------------- */

async function doImport() {
  const keys = [...S.selected];
  if (!keys.length) return;
  const target = $('#targetSel').value;
  const targets = { disk: target !== 'cloud', cloud: target !== 'disk' };

  S.importing = true;
  $('#btnImport').disabled = true;
  $('#importProgress').classList.remove('hidden');
  log(`开始执行 ${keys.length} 个文件…`);

  try {
    const { jobId } = await api('/api/import', { keys, targets });
    const result = await pollJob(jobId, (job) => setProgress('#importProgress', job));
    log(
      `执行完成：落盘 ${result.copied}，上云 ${result.uploaded}` +
        (result.failures?.length ? `，失败 ${result.failures.length}` : ''),
      'ok',
    );
    $('#exportHint').textContent = `刚才导入了 ${result.batchCount} 个，可在下面再复制一份到别处。`;
    S.importing = false;
    await refreshBatches(result.batchId);
    for (const k of keys) S.selected.delete(k);
    updateSelCount();
  } catch (e) {
    log(`执行失败：${e.message}`, 'bad');
    S.importing = false;
    updateSelCount();
  } finally {
    hideProgress('#importProgress');
  }
}

/* ----------------------------- 6 导出 ----------------------------- */

function renderBatches(selectId) {
  const sel = $('#batchSel');
  sel.innerHTML = '';
  if (!S.batches.length) {
    sel.innerHTML = '<option value="">还没有导入过</option>';
    return;
  }
  for (const b of S.batches) {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = `${new Date(b.at).toLocaleString('zh-CN')} · ${b.count} 个`;
    sel.appendChild(o);
  }
  if (selectId) sel.value = selectId;
}

async function refreshBatches(selectId) {
  try {
    const { batches } = await api('/api/batches');
    S.batches = batches;
    renderBatches(selectId);
  } catch (e) {
    log(e.message, 'bad');
  }
}

async function doExport() {
  const destDir = $('#exportDir').value.trim();
  if (!destDir) return alert('先填要复制到哪个文件夹');
  $('#btnExport').disabled = true;
  $('#exportProgress').classList.remove('hidden');
  try {
    const { jobId } = await api('/api/export', { destDir, batchId: $('#batchSel').value || null });
    const r = await pollJob(jobId, (job) => setProgress('#exportProgress', job));
    $('#exportHint').textContent = `已复制 ${r.copied} 个到 ${r.dest}（跳过 ${r.skipped}，失败 ${r.failed.length}）`;
    log(`导出完成：${r.copied} 个 → ${r.dest}`, 'ok');
  } catch (e) {
    $('#exportHint').textContent = e.message;
    log(`导出失败：${e.message}`, 'bad');
  } finally {
    $('#btnExport').disabled = false;
    hideProgress('#exportProgress');
  }
}

/* ------------------------------ 绑定 ------------------------------ */

$('#btnQuit').onclick = async () => {
  const ok = window.confirm(
    '退出会停止后台服务，这个网页就打不开了。\n\n下次双击桌面上的「手机备份助手」图标即可重新启动。\n\n确定退出？',
  );
  if (!ok) return;
  try {
    await api('/api/quit', {});
  } catch {
    /* 服务已经没了也无所谓 */
  }
  document.body.innerHTML =
    '<div style="font:15px/1.8 \'Microsoft YaHei\',system-ui;padding:80px;text-align:center;color:#40506a">' +
    '<div style="font-size:40px">✅</div>' +
    '<h2 style="margin:12px 0 6px">已退出</h2>' +
    '<p>后台服务已停止，可以关掉这个标签页了。<br>下次双击桌面上的「手机备份助手」图标重新启动。</p>' +
    '</div>';
};

$('#btnReconnect').onclick = async () => {
  $('#btnReconnect').disabled = true;
  try {
    const { source } = await api('/api/source/probe', {});
    updateBadge(source);
    if (source.ok) {
      S.sourceLabel = source.label || '';
      resetTree();
      log('来源已连上', 'ok');
    } else {
      log(`还是没连上：${source.error}`, 'bad');
    }
  } catch (e) {
    log(e.message, 'bad');
  } finally {
    $('#btnReconnect').disabled = false;
    applySourceKindUI();
  }
};

// 手机掉线后自动重试，不用重启黑窗口
let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    if (S.sourceKind !== 'phone') return;
    try {
      const { source } = await api('/api/source/probe', {});
      if (source.ok) {
        clearInterval(retryTimer);
        retryTimer = null;
        S.sourceLabel = source.label || '';
        updateBadge(source);
        applySourceKindUI();
        log('检测到手机已重新连接', 'ok');
      }
    } catch {
      /* 继续等 */
    }
  }, 4000);
  setTimeout(() => {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }, 10 * 60 * 1000);
}

const _updateBadge = updateBadge;
updateBadge = function (source) {
  _updateBadge(source);
  if (!source?.ok && S.sourceKind === 'phone') scheduleRetry();
};

$('#btnScanNew').onclick = scanNew;
$('#btnImport').onclick = doImport;
$('#btnExport').onclick = doExport;

(async function init() {
  log('界面已启动，正在读取配置…');
  try {
    renderExtCats();
    await loadOverview();
    log('就绪。顺序：选来源 → 选目标 → 扫描来源 → 分栏勾选对应 → 对比 → 执行。', 'ok');
  } catch (e) {
    log(`初始化失败：${e.message}`, 'bad');
  }
})();
