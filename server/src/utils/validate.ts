import path from 'node:path';
import { config } from '../config';

/** 只允许 part_000.mp4 这类安全文件名，杜绝路径穿越 */
export const SEGMENT_NAME_RE = /^part_\d{3,6}\.mp4$/;

export function isSafeSegmentName(name: string): boolean {
  return SEGMENT_NAME_RE.test(name);
}

/** 校验扩展名是否在白名单内 */
export function isAllowedExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  return config.allowedExtensions.includes(ext);
}

/** 校验 MIME 是否为视频类 */
export function isAllowedMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return mime.toLowerCase().startsWith('video/') || mime === 'application/octet-stream';
}

/** 校验 UUID v4 形式的 fileId / taskId */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function clampSegmentTime(value: unknown, fallback = 10): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  // 1 秒 ~ 3600 秒
  return Math.min(3600, Math.max(1, n));
}
