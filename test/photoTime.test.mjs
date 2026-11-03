import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFromName, resolvePhotoTime, CONFIDENCE } from '../src/time/photoTime.mjs';

const d = (s) => new Date(s);

test('IMG_14位：你手机的主力命名', () => {
  const r = parseFromName('IMG20260901181943.heic');
  assert.ok(r);
  assert.equal(r.date.getFullYear(), 2026);
  assert.equal(r.date.getMonth(), 8); // 9 月
  assert.equal(r.date.getDate(), 1);
  assert.equal(r.date.getHours(), 18);
  assert.equal(r.date.getMinutes(), 19);
  assert.equal(r.date.getSeconds(), 43);
  assert.equal(r.confidence, CONFIDENCE.FILENAME);
});

test('IMG_14位带后缀', () => {
  const r = parseFromName('IMG20260901181943_01.heic');
  assert.ok(r);
  assert.equal(r.date.getDate(), 1);
});

test('VID 视频命名也能识别', () => {
  const r = parseFromName('VID20270101093000.mp4');
  assert.ok(r);
  assert.equal(r.date.getFullYear(), 2027);
  assert.equal(r.date.getMonth(), 0);
});

test('截图：8 位 + 6 位', () => {
  const r = parseFromName('Screenshot_20261015_093012_com.honor.xxx.png');
  assert.ok(r);
  assert.equal(r.date.getFullYear(), 2026);
  assert.equal(r.date.getMonth(), 9);
  assert.equal(r.date.getDate(), 15);
  assert.equal(r.date.getHours(), 9);
  assert.equal(r.date.getMinutes(), 30);
});

test('微信图片：下划线分隔的 14 位', () => {
  const r = parseFromName('微信图片_20261020112233.jpg');
  assert.ok(r);
  assert.equal(r.date.getDate(), 20);
});

test('微信导出：13 位毫秒时间戳', () => {
  const ms = new Date(2027, 2, 5, 10, 0, 0).getTime();
  const r = parseFromName(`mmexport${ms}.jpg`);
  assert.ok(r);
  assert.equal(r.date.getFullYear(), 2027);
  assert.equal(r.date.getMonth(), 2);
  assert.equal(r.date.getDate(), 5);
});

test('10 位秒时间戳', () => {
  const sec = Math.floor(new Date(2026, 9, 1, 12, 0, 0).getTime() / 1000);
  const r = parseFromName(`${sec}.jpg`);
  assert.ok(r);
  assert.equal(r.date.getFullYear(), 2026);
});

test('不合法的 14 位数字要拒绝（不是日期）', () => {
  assert.equal(parseFromName('12345678901234.jpg'), null);
  assert.equal(parseFromName('99999999999999.jpg'), null);
  assert.equal(parseFromName('20261301181943.jpg'), null); // 13 月
  assert.equal(parseFromName('20260231181943.jpg'), null); // 2 月 31 日
});

test('普通文件名不瞎猜', () => {
  assert.equal(parseFromName('photo.jpg'), null);
  assert.equal(parseFromName('IMG_0001.jpg'), null);
  assert.equal(parseFromName('证件照.png'), null);
});

test('没有文件名时间时退回 mtime', () => {
  const mtimeMs = d('2026-10-15T10:00:00+08:00').getTime();
  const r = resolvePhotoTime({ name: 'photo.jpg', mtimeMs });
  assert.equal(r.confidence, CONFIDENCE.MTIME);
  assert.equal(r.date.getTime(), mtimeMs);
});

test('文件名时间优先于 mtime', () => {
  const mtimeMs = d('2026-10-15T10:00:00+08:00').getTime();
  const r = resolvePhotoTime({ name: 'IMG20270101093000.heic', mtimeMs });
  assert.equal(r.confidence, CONFIDENCE.FILENAME);
  assert.equal(r.date.getFullYear(), 2027);
});

test('mtime 缺失时返回 null', () => {
  assert.equal(resolvePhotoTime({ name: 'photo.jpg', mtimeMs: 0 }), null);
});
