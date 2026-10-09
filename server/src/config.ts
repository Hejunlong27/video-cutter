import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

const STORAGE_ROOT = path.resolve(
  process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage'),
);

export const config = {
  port: num('PORT', 4000),
  host: process.env.HOST || '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // 存储目录：所有落盘路径都由这里派生，禁止外部传入
  storageRoot: STORAGE_ROOT,
  uploadDir: path.join(STORAGE_ROOT, 'uploads'),
  taskDir: path.join(STORAGE_ROOT, 'tasks'),
  tmpDir: path.join(STORAGE_ROOT, 'tmp'),

  // 业务限制
  maxUploadBytes: Math.floor(num('MAX_UPLOAD_MB', 2048) * 1024 * 1024),
  defaultSegmentTime: num('DEFAULT_SEGMENT_TIME', 10),
  maxConcurrency: Math.max(1, Math.floor(num('MAX_CONCURRENCY', 2))),
  retentionHours: num('RETENTION_HOURS', 24),
  cleanupIntervalMinutes: Math.max(1, num('CLEANUP_INTERVAL_MINUTES', 30)),

  // FFmpeg
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  ffmpegTimeoutMs: Math.max(1, num('FFMPEG_TIMEOUT_MINUTES', 60)) * 60 * 1000,

  // 队列
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  /**
   * 任务调度驱动：
   *   auto   —— 能连上 Redis 就用队列，连不上自动降级为进程内调度（默认）
   *   redis  —— 强制使用 BullMQ + Redis，连不上直接启动失败
   *   inline —— 强制进程内调度，完全不依赖 Redis（适合本地快速试用）
   */
  queueDriver: ((): 'auto' | 'redis' | 'inline' => {
    const raw = (process.env.QUEUE_DRIVER || 'auto').toLowerCase();
    return raw === 'redis' || raw === 'inline' ? raw : 'auto';
  })(),

  allowedExtensions: (process.env.ALLOWED_EXTENSIONS ||
    'mp4,mov,mkv,avi,webm,m4v,flv,ts,mpeg,mpg,wmv')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
} as const;

export function ensureStorageDirs(): void {
  for (const dir of [
    config.storageRoot,
    config.uploadDir,
    config.taskDir,
    config.tmpDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 返回任务输出目录（绝对路径），并确保存在 */
export function taskOutputDir(taskId: string): string {
  const dir = path.join(config.taskDir, taskId, 'segments');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 返回任务根目录（绝对路径） */
export function taskRootDir(taskId: string): string {
  return path.join(config.taskDir, taskId);
}
