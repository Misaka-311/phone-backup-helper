// 从 JPEG 头部的 APP1 段里读 EXIF 的 DateTimeOriginal。
// 只做"够用"的最小实现：不依赖任何第三方库，不解析 HEIC（二期再做）。

const EXIF_IFD_POINTER = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_DATETIME = 0x0132;

function parseExifDateTimeString(s) {
  if (!s) return null;
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (y < 1990 || y > 2100) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || se > 60) return null;
  const date = new Date(y, mo - 1, d, h, mi, Math.min(se, 59));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTiff(tiff) {
  if (!tiff || tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;

  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));

  if (u16(2) !== 42) return null;

  const values = new Map();

  const readIfd = (offset) => {
    if (!Number.isFinite(offset) || offset < 8 || offset + 2 > tiff.length) return;
    const count = u16(offset);
    if (count > 512) return;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > tiff.length) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      if (type === 2 && n > 0 && n <= 128) {
        const valueOffset = n <= 4 ? entry + 8 : u32(entry + 8);
        if (valueOffset + n <= tiff.length) {
          const s = tiff.toString('latin1', valueOffset, valueOffset + n).replace(/\0+$/g, '');
          values.set(tag, s);
        }
      } else if (type === 4 && n === 1) {
        values.set(tag, u32(entry + 8));
      } else if (type === 3 && n === 1) {
        values.set(tag, u16(entry + 8));
      }
    }
  };

  const ifd0 = u32(4);
  readIfd(ifd0);
  const exifIfd = values.get(EXIF_IFD_POINTER);
  if (typeof exifIfd === 'number') readIfd(exifIfd);

  const raw =
    values.get(TAG_DATETIME_ORIGINAL) ??
    values.get(TAG_DATETIME_DIGITIZED) ??
    values.get(TAG_DATETIME);
  return parseExifDateTimeString(raw);
}

/**
 * 从文件头部缓冲里读拍摄时间。
 * @param {Buffer} buf 文件前若干字节（建议 >= 128KB，至少要覆盖 EXIF 段）
 * @returns {Date|null}
 */
export function readExifDate(buf) {
  try {
    if (!buf || buf.length < 16) return null;
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // 不是 JPEG
    let offset = 2;
    let guard = 0;
    while (offset + 4 <= buf.length && guard++ < 256) {
      if (buf[offset] !== 0xff) return null;
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null; // 到图像数据了，EXIF 不会在后面
      const len = buf.readUInt16BE(offset + 2);
      if (len < 2) return null;
      if (marker === 0xe1) {
        const segStart = offset + 4;
        const segEnd = offset + 2 + len;
        if (segEnd <= buf.length && segEnd - segStart > 6) {
          const isExif = buf.toString('latin1', segStart, segStart + 4) === 'Exif';
          if (isExif) {
            const tiff = buf.subarray(segStart + 6, segEnd);
            const d = parseTiff(tiff);
            if (d) return d;
          }
        }
      }
      offset += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

export { parseExifDateTimeString };
