// 界面流程测试：扫描 → 勾选导入 → 导出（保留目录结构与原始时间）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normalizeConfig, loadConfig } from '../src/config.mjs';
import { buildSource } from '../src/sources/source.mjs';
import { StateStore } from '../src/state.mjs';
import { listPhoneDirs, listFolderSource, listSourceTree, scanAll, importSelected, exportBatch } from '../src/pipeline.mjs';

const BASE = path.join(process.cwd(), '_test_out', `gui-${Date.now()}`);
const quiet = {
  raw() {},
  plain() {},
  info() {},
  step() {},
  ok() {},
  warn() {},
  error() {},
  debug() {},
  close() {},
};

async function makePhone() {
  const root = path.join(BASE, 'phone');
  const cam = path.join(root, 'DCIM', 'Camera');
  const wx = path.join(root, 'Pictures', 'WeiXin');
  await fsp.mkdir(cam, { recursive: true });
  await fsp.mkdir(wx, { recursive: true });
  const specs = [
    [cam, 'IMG20270101093000.heic', '2027-01-01T09:30:00'],
    [cam, 'IMG20270305101010.heic', '2027-03-05T10:10:10'],
    [cam, 'IMG20260901181943.heic', '2026-09-01T18:19:43'],
    [wx, 'mmexport1800000000000.jpg', '2027-01-15T08:00:00'],
  ];
  for (const [dir, name, iso] of specs) {
    const p = path.join(dir, name);
    await fsp.writeFile(p, Buffer.alloc(4096, 65));
    const t = new Date(iso);
    await fsp.utimes(p, t, t);
  }
  return root;
}

async function makeCfg(phoneRoot, outRoot) {
  return normalizeConfig({
    local: { root: outRoot },
    phone: {
      transport: 'dir',
      dir: { root: phoneRoot, prefix: '/sdcard/' },
      sources: [],
      includeExt: ['.heic', '.jpg', '.png'],
      minSizeBytes: 1024,
    },
    cloud: { mode: 'off' },
  });
}

test('列出手机目录：能按父目录展开并统计文件数', async () => {
  const phoneRoot = await makePhone();
  const cfg = await makeCfg(phoneRoot, path.join(BASE, 'out0'));
  const source = buildSource(cfg);

  const dirs = await listPhoneDirs({ source });
  const camera = dirs.find((d) => d.remote === '/sdcard/DCIM/Camera');
  const weixin = dirs.find((d) => d.remote === '/sdcard/Pictures/WeiXin');
  assert.ok(camera, '应该列出 DCIM/Camera');
  assert.equal(camera.count, 3);
  assert.ok(weixin);
  assert.equal(weixin.count, 1);
});

test('扫描：按映射算出每个文件夹的新增，并按日期过滤', async () => {
  const phoneRoot = await makePhone();
  const outRoot = path.join(BASE, 'out1');
  const cfg = await makeCfg(phoneRoot, outRoot);
  const source = buildSource(cfg);
  const state = new StateStore(path.join(BASE, 'state1.json'));

  const mapping = [
    { remote: '/sdcard/DCIM/Camera', subdir: 'Camera' },
    { remote: '/sdcard/Pictures/WeiXin', subdir: 'WeiXin' },
  ];

  const all = await scanAll({
    cfg,
    source,
    mapping,
    since: null,
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  });
  assert.equal(all.plan.copy.length, 4);
  assert.equal(all.summary.toDisk, 4);

  const only2027 = await scanAll({
    cfg,
    source,
    mapping,
    since: new Date('2027-01-01T00:00:00'),
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  });
  assert.equal(only2027.plan.copy.length, 3, '2027 年应有 3 个');
  const names = only2027.plan.copy.map((i) => i.name).sort();
  assert.deepEqual(names, ['IMG20270101093000.heic', 'IMG20270305101010.heic', 'mmexport1800000000000.jpg']);
});

test('勾选导入：只导选中的那几个，并记一个批次', async () => {
  const phoneRoot = await makePhone();
  const outRoot = path.join(BASE, 'out2');
  const cfg = await makeCfg(phoneRoot, outRoot);
  const source = buildSource(cfg);
  const state = new StateStore(path.join(BASE, 'state2.json'));

  const scan = await scanAll({
    cfg,
    source,
    mapping: [{ remote: '/sdcard/DCIM/Camera', subdir: 'Camera' }],
    since: null,
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  });

  const chosen = scan.plan.copy.slice(0, 2).map((i) => i.key);
  const res = await importSelected({
    cfg,
    source,
    state,
    planCopy: scan.plan.copy,
    keys: chosen,
    targets: { disk: true, cloud: false },
    log: quiet,
  });

  assert.equal(res.stats.copied, 2);
  assert.equal(res.count, 2);
  assert.ok(res.batchId);

  const outFiles = fs.readdirSync(path.join(outRoot, 'Camera'));
  assert.equal(outFiles.length, 2, '只应该有选中的 2 个文件');
  assert.ok(state.getBatch(res.batchId));
  assert.equal(state.getBatch(res.batchId).count, 2);
});

test('导出：保留子目录结构与原始修改时间', async () => {
  const phoneRoot = await makePhone();
  const outRoot = path.join(BASE, 'out3');
  const cfg = await makeCfg(phoneRoot, outRoot);
  const source = buildSource(cfg);
  const state = new StateStore(path.join(BASE, 'state3.json'));

  const scan = await scanAll({
    cfg,
    source,
    mapping: [
      { remote: '/sdcard/DCIM/Camera', subdir: 'Camera' },
      { remote: '/sdcard/Pictures/WeiXin', subdir: 'WeiXin' },
    ],
    since: null,
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  });

  const keys = scan.plan.copy.map((i) => i.key);
  const imp = await importSelected({
    cfg,
    source,
    state,
    planCopy: scan.plan.copy,
    keys,
    targets: { disk: true, cloud: false },
    log: quiet,
  });

  const destDir = path.join(BASE, 'exported');
  const res = await exportBatch({ cfg, state, batchId: imp.batchId, destDir });
  assert.equal(res.copied.length, 4);
  assert.equal(res.failed.length, 0);

  // 结构：dest/Camera/... 与 dest/WeiXin/...
  assert.ok(fs.existsSync(path.join(destDir, 'Camera', 'IMG20270101093000.heic')));
  assert.ok(fs.existsSync(path.join(destDir, 'WeiXin', 'mmexport1800000000000.jpg')));

  // 时间：与源文件一致（误差 2 秒内）
  const src = await fsp.stat(path.join(phoneRoot, 'DCIM', 'Camera', 'IMG20270101093000.heic'));
  const dst = await fsp.stat(path.join(destDir, 'Camera', 'IMG20270101093000.heic'));
  assert.ok(Math.abs(dst.mtimeMs - src.mtimeMs) < 2000, `导出后时间应保持，实际 ${new Date(dst.mtimeMs).toISOString()}`);
});

test('导出：批次不存在时给出明确错误', async () => {
  const phoneRoot = await makePhone();
  const cfg = await makeCfg(phoneRoot, path.join(BASE, 'out4'));
  const state = new StateStore(path.join(BASE, 'state4.json'));
  await assert.rejects(() => exportBatch({ cfg, state, batchId: null, destDir: path.join(BASE, 'x') }), /没有找到可导出的批次/);
});

test('来源也可以是硬盘文件夹：列出它的子文件夹与文件名样本', async () => {
  const srcRoot = path.join(BASE, 'olddisk');
  await fsp.mkdir(path.join(srcRoot, 'DCIM 1'), { recursive: true });
  await fsp.mkdir(path.join(srcRoot, '好图'), { recursive: true });
  await fsp.writeFile(path.join(srcRoot, 'DCIM 1', 'a.jpg'), Buffer.alloc(2048));
  await fsp.writeFile(path.join(srcRoot, 'DCIM 1', 'b.jpg'), Buffer.alloc(2048));
  await fsp.writeFile(path.join(srcRoot, '好图', 'c.jpg'), Buffer.alloc(2048));

  const folders = await listFolderSource({ root: srcRoot });
  const dcim = folders.find((f) => f.name === 'DCIM 1');
  assert.ok(dcim, '应列出 DCIM 1');
  assert.equal(dcim.count, 2);
  assert.equal(dcim.path, '/DCIM 1');
  assert.deepEqual(dcim.names.sort(), ['a.jpg', 'b.jpg']);
});

test('硬盘对硬盘对比：给出 来源/目标已有/新增 三个数字', async () => {
  const srcRoot = path.join(BASE, 'olddisk2', 'Photos');
  await fsp.mkdir(srcRoot, { recursive: true });
  await fsp.writeFile(path.join(srcRoot, '1.jpg'), Buffer.alloc(2048));
  await fsp.writeFile(path.join(srcRoot, '2.jpg'), Buffer.alloc(2048));
  await fsp.writeFile(path.join(srcRoot, '3.jpg'), Buffer.alloc(2048));

  const outRoot = path.join(BASE, 'newdisk2');
  await fsp.mkdir(path.join(outRoot, 'Photos'), { recursive: true });
  await fsp.writeFile(path.join(outRoot, 'Photos', '1.jpg'), Buffer.alloc(2048));

  const cfg = normalizeConfig({
    local: { root: outRoot },
    phone: { transport: 'dir', dir: { root: path.join(BASE, 'olddisk2'), prefix: '' }, sources: [], includeExt: ['.jpg'], minSizeBytes: 1024 },
    cloud: { mode: 'off' },
  });
  const source = buildSource(cfg);
  const state = new StateStore(path.join(BASE, 'state6.json'));

  const scan = await scanAll({
    cfg,
    source,
    mapping: [{ remote: '/Photos', subdir: 'Photos' }],
    since: null,
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  });

  assert.equal(scan.folderStats.length, 1);
  const s = scan.folderStats[0];
  assert.equal(s.sourceCount, 3, '来源 3 个');
  assert.equal(s.destCount, 1, '目标已有 1 个');
  assert.equal(s.add, 2, '新增 2 个');
});

test('来源目录树：大文件夹分栏 + 小文件夹计数（硬盘来源）', async () => {
  const root = path.join(BASE, 'tree-olddisk');
  await fsp.mkdir(path.join(root, 'DCIM 1', 'Camera', '2026'), { recursive: true });
  await fsp.mkdir(path.join(root, 'DCIM 1', 'Screenshots'), { recursive: true });
  await fsp.mkdir(path.join(root, '好图', '1'), { recursive: true });
  await fsp.writeFile(path.join(root, 'DCIM 1', 'Camera', 'a.jpg'), Buffer.alloc(1024));
  await fsp.writeFile(path.join(root, 'DCIM 1', 'Camera', '2026', 'b.jpg'), Buffer.alloc(1024));
  await fsp.writeFile(path.join(root, 'DCIM 1', 'Screenshots', 'c.png'), Buffer.alloc(1024));
  await fsp.writeFile(path.join(root, '好图', '1', 'd.jpg'), Buffer.alloc(1024));

  const tree = await listSourceTree({ kind: 'folder', root });
  assert.equal(tree.kind, 'folder');
  const dcim = tree.groups.find((g) => g.name === 'DCIM 1');
  assert.ok(dcim, '应有 DCIM 1 这一栏');
  assert.equal(dcim.children.length, 2, 'DCIM 1 下应有 2 个小文件夹');
  const camera = dcim.children.find((c) => c.name === 'Camera');
  assert.equal(camera.path, '/DCIM 1/Camera');
  assert.equal(camera.count, 2, 'Camera 递归计数应含子目录里的文件');
  assert.equal(dcim.count, 3);
});

test('目标里已有同名文件 → 一律跳过，不算新增（哪怕大小不同）', async () => {
  const srcRoot = path.join(BASE, 'dup-src');
  await fsp.mkdir(srcRoot, { recursive: true });
  await fsp.writeFile(path.join(srcRoot, 'a.jpg'), Buffer.alloc(2048));
  await fsp.writeFile(path.join(srcRoot, 'b.jpg'), Buffer.alloc(4096));

  const outRoot = path.join(BASE, 'dup-dst');
  await fsp.mkdir(path.join(outRoot, 'Photos'), { recursive: true });
  await fsp.writeFile(path.join(outRoot, 'Photos', 'a.jpg'), Buffer.alloc(1024)); // 同名不同大小
  await fsp.writeFile(path.join(outRoot, 'Photos', 'b.jpg'), Buffer.alloc(4096));

  const cfg = normalizeConfig({
    local: { root: outRoot },
    phone: { transport: 'dir', dir: { root: srcRoot, prefix: '' }, sources: [], includeExt: ['.jpg'], minSizeBytes: 1024 },
    cloud: { mode: 'off' },
  });
  const source = buildSource(cfg);
  const state = new StateStore(path.join(BASE, 'state-dup.json'));

  const scan = await scanAll({
    cfg,
    source,
    mapping: [{ remote: '/', subdir: 'Photos' }],
    since: null,
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  });

  assert.equal(scan.plan.copy.length, 0, '同名文件全应跳过');
  assert.equal(scan.folderStats[0].sourceCount, 2);
  assert.equal(scan.folderStats[0].add, 0);
  const codes = scan.plan.skip.map((s) => s.code);
  assert.equal(codes.filter((c) => c === 'same-name').length, 2, '两个都应记为 same-name');
});

test('导出不会覆盖：同名同大小跳过，同名不同大小自动加 (2)', async () => {
  const phoneRoot = await makePhone();
  const outRoot = path.join(BASE, 'out5');
  const cfg = await makeCfg(phoneRoot, outRoot);
  const source = buildSource(cfg);
  const state = new StateStore(path.join(BASE, 'state5.json'));

  const scan = await scanAll({
    cfg,
    source,
    mapping: [{ remote: '/sdcard/DCIM/Camera', subdir: 'Camera' }],
    since: null,
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  });
  const keys = scan.plan.copy.slice(0, 1).map((i) => i.key);
  const imp = await importSelected({ cfg, source, state, planCopy: scan.plan.copy, keys, targets: { disk: true, cloud: false }, log: quiet });

  const destDir = path.join(BASE, 'exp2');
  const first = await exportBatch({ cfg, state, batchId: imp.batchId, destDir });
  assert.equal(first.copied.length, 1);

  const target = first.copied[0].to;
  const before = await fsp.stat(target);

  // 第二次导出：同名同大小 → 跳过，不覆盖
  const second = await exportBatch({ cfg, state, batchId: imp.batchId, destDir });
  assert.equal(second.copied.length, 0);
  assert.equal(second.skipped.length, 1);
  const after = await fsp.stat(target);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);

  // 把导出目录里的文件改成不同大小 → 再导出应生成 (2)，原文件不动
  await fsp.writeFile(target, Buffer.alloc(7));
  const third = await exportBatch({ cfg, state, batchId: imp.batchId, destDir });
  assert.equal(third.copied.length, 1);
  assert.match(third.copied[0].to, /\(\d+\)\.[a-z]+$/i);
  const untouched = await fsp.stat(target);
  assert.equal(untouched.size, 7, '原有文件不应被覆盖');
});

test('配置文件带 BOM（记事本保存的）也能正常读取', async () => {
  const dir = path.join(BASE, 'cfg-bom');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'config.json'), '\uFEFF{"local":{"root":"F:\\\\bomtest"}}', 'utf8');
  const cfg = await loadConfig({ projectRoot: dir });
  assert.equal(cfg.local.root, 'F:\\bomtest');
});

test('文件类型开关：默认只吃照片视频，放开后能吃 PDF/文档', async () => {
  const srcRoot = path.join(BASE, 'ext-src');
  await fsp.mkdir(srcRoot, { recursive: true });
  for (const [n, size] of [['a.jpg', 4000], ['b.heic', 5000], ['合同.pdf', 9000], ['报告.docx', 8000], ['未知.xyz', 3000]]) {
    await fsp.writeFile(path.join(srcRoot, n), Buffer.alloc(size));
  }
  const outRoot = path.join(BASE, 'ext-dst');
  await fsp.mkdir(outRoot, { recursive: true });

  const cfg = normalizeConfig({
    local: { root: outRoot },
    phone: {
      transport: 'dir',
      dir: { root: srcRoot, prefix: '' },
      sources: [],
      includeExt: ['.jpg', '.jpeg', '.heic', '.png', '.mp4', '.mov'],
      minSizeBytes: 1024,
    },
    cloud: { mode: 'off' },
  });
  const source = buildSource(cfg);
  const state = new StateStore(path.join(BASE, 'state-ext.json'));
  const base = {
    cfg,
    source,
    mapping: [{ remote: '/', subdir: 'Docs' }],
    since: null,
    until: null,
    state,
    log: quiet,
    stagingDir: cfg.local.stagingDir,
    targets: { disk: true, cloud: false },
  };

  const media = await scanAll({ ...base, state: new StateStore(path.join(BASE, 'state-ext1.json')) });
  assert.equal(media.plan.copy.length, 2, '默认只应有 jpg + heic');

  const docs = await scanAll({
    ...base,
    state: new StateStore(path.join(BASE, 'state-ext2.json')),
    includeExt: [...cfg.phone.includeExt, '.pdf', '.docx'],
    minSizeBytes: 0,
  });
  assert.equal(docs.plan.copy.length, 4, '放开文档后应有 jpg/heic/pdf/docx');

  const all = await scanAll({
    ...base,
    state: new StateStore(path.join(BASE, 'state-ext3.json')),
    includeExt: null,
    minSizeBytes: 0,
  });
  assert.equal(all.plan.copy.length, 5, '所有文件模式应连 .xyz 也要');
});

test.after(async () => {
  await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
});
