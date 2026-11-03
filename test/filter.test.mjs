import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFilter, parseDateBoundary, rangeFromYears, globToRegExp, normalizeExtList } from '../src/filter.mjs';

const at = (s) => new Date(s);
const file = (over = {}) => ({
  name: 'IMG20270101093000.heic',
  relPath: 'Camera/IMG20270101093000.heic',
  size: 4 * 1024 * 1024,
  date: at('2027-01-01T09:30:00'),
  confidence: 'filename',
  ...over,
});

test('解析日期边界', () => {
  const d1 = parseDateBoundary('2026-10-01', { which: '起始' });
  assert.equal(d1.getFullYear(), 2026);
  assert.equal(d1.getMonth(), 9);
  assert.equal(d1.getDate(), 1);
  assert.equal(d1.getHours(), 0);
  assert.equal(d1.getMinutes(), 0);

  assert.equal(parseDateBoundary('', {}), null);
  assert.equal(parseDateBoundary(null, {}), null);
  assert.throws(() => parseDateBoundary('2026/13/01', {}), /看不懂|超出/);
  assert.throws(() => parseDateBoundary('昨天', {}), /看不懂/);
});

test('区间：含 since、不含 until', () => {
  const f = makeFilter({ since: at('2027-01-01T00:00:00'), until: at('2028-01-01T00:00:00') });
  assert.equal(f.check(file({ date: at('2026-12-31T23:59:59') })).code, 'before');
  assert.equal(f.check(file({ date: at('2027-01-01T00:00:00') })).ok, true);
  assert.equal(f.check(file({ date: at('2027-06-15T12:00:00') })).ok, true);
  assert.equal(f.check(file({ date: at('2027-12-31T23:59:59') })).ok, true);
  assert.equal(f.check(file({ date: at('2028-01-01T00:00:00') })).code, 'after');
});

test('这就是用户要的核心断言：2027 之后才要', () => {
  const f = makeFilter({ since: at('2027-01-01T00:00:00') });
  const oldPhotos = [
    file({ name: 'IMG20260901181943.heic', date: at('2026-09-01T18:19:43') }),
    file({ name: 'IMG20261003120000.heic', date: at('2026-10-03T12:00:00') }),
    file({ name: 'IMG20261231235959.heic', date: at('2026-12-31T23:59:59') }),
  ];
  const newPhotos = [
    file({ name: 'IMG20270101000000.heic', date: at('2027-01-01T00:00:00') }),
    file({ name: 'IMG20270305101010.heic', date: at('2027-03-05T10:10:10') }),
  ];
  for (const p of oldPhotos) assert.equal(f.check(p).ok, false, `${p.name} 不该通过`);
  for (const p of newPhotos) assert.equal(f.check(p).ok, true, `${p.name} 应该通过`);
});

test('扩展名过滤', () => {
  const f = makeFilter({ includeExt: ['.heic', '.jpg'] });
  assert.equal(f.check(file({ name: 'a.heic' })).ok, true);
  assert.equal(f.check(file({ name: 'a.HEIC' })).ok, true);
  assert.equal(f.check(file({ name: 'a.mp4' })).code, 'ext');
});

test('大小过滤', () => {
  const f = makeFilter({ minSizeBytes: 1024 });
  assert.equal(f.check(file({ size: 100 })).code, 'small');
  assert.equal(f.check(file({ size: 2048 })).ok, true);
});

test('目录前缀过滤', () => {
  const f = makeFilter({ pathPrefixes: ['Camera'] });
  assert.equal(f.check(file({ relPath: 'Camera/a.heic' })).ok, true);
  assert.equal(f.check(file({ relPath: 'Screenshots/a.jpg' })).code, 'path');
});

test('文件名通配', () => {
  const f = makeFilter({ nameGlob: '*.heic' });
  assert.equal(f.check(file({ name: 'a.heic' })).ok, true);
  assert.equal(f.check(file({ name: 'a.jpg' })).code, 'glob');
});

test('时间不确定的文件可被排除', () => {
  const f = makeFilter({ excludeUncertain: true });
  assert.equal(f.check(file({ confidence: 'mtime' })).code, 'uncertain');
  assert.equal(f.check(file({ confidence: 'filename' })).ok, true);
});

test('没有日期的文件被跳过', () => {
  const f = makeFilter({});
  assert.equal(f.check(file({ date: null })).code, 'nodate');
});

test('glob 转正则', () => {
  assert.equal(globToRegExp('*.heic').test('a.heic'), true);
  assert.equal(globToRegExp('*.heic').test('dir/a.heic'), false);
  assert.equal(globToRegExp('**/*.heic').test('dir/a.heic'), true);
  assert.equal(globToRegExp('IMG2027*').test('IMG20270101.heic'), true);
});

test('年份区间', () => {
  const r = rangeFromYears('2027');
  assert.equal(r.since.getFullYear(), 2027);
  assert.equal(r.until.getFullYear(), 2028);
  const r2 = rangeFromYears('2026,2027');
  assert.equal(r2.since.getFullYear(), 2026);
  assert.equal(r2.until.getFullYear(), 2028);
});

test('扩展名列表归一化', () => {
  const s = normalizeExtList(['HEIC', '.jpg', ' png ']);
  assert.ok(s.has('.heic'));
  assert.ok(s.has('.jpg'));
  assert.ok(s.has('.png'));
});
