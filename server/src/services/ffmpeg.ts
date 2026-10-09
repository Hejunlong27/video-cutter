import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import type { CutMode, CutProgress } from '../types';

/** 匹配 ffmpeg stderr 中的 Duration: 00:10:23.45 */
const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
/** 匹配 time=00:10:23.45，全局扫描取最后一个 */
const TIME_RE = /time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g;

function toSeconds(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * 用 ffprobe 读取精确时长（秒）。
 * 失败返回 null —— 此时由 stderr 里的 Duration 兜底。
 */
export function probeDuration(input: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      config.ffprobePath,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        input,
      ],
      { windowsHide: true },
    );

    let out = '';
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const value = parseFloat(out.trim());
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

/**
 * 构造 ffmpeg 参数数组（关键：全程数组传参，绝不拼字符串，杜绝命令注入）。
 */
export function buildCutArgs(opts: {
  input: string;
  outputPattern: string;
  segmentTime: number;
  mode: CutMode;
}): string[] {
  const { input, outputPattern, segmentTime, mode } = opts;

  const head = ['-hide_banner', '-nostdin', '-y', '-i', input];

  const segment = [
    '-map', '0',
    '-f', 'segment',
    '-segment_time', String(segmentTime),
    '-reset_timestamps', '1',
    '-segment_format', 'mp4',
  ];

  if (mode === 'fast') {
    // 快速无损：直接流拷贝，不重新编码，秒级完成
    return [...head, '-c', 'copy', ...segment, outputPattern];
  }

  // 精确重编码：强制每个片段边界都是关键帧，片段时长严格贴近 segmentTime
  return [
    ...head,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-map', '0',
    '-f', 'segment',
    '-segment_time', String(segmentTime),
    '-reset_timestamps', '1',
    '-force_key_frames', `expr:gte(t,n_forced*${segmentTime})`,
    '-segment_format', 'mp4',
    outputPattern,
  ];
}

export interface CutHandle {
  /** 底层子进程，取消时 kill */
  proc: ChildProcess;
  /** 完成 / 失败 / 取消 */
  done: Promise<void>;
  /** 主动取消：标记后 kill 进程 */
  cancel: () => void;
}

/** 统计输出目录里已生成的片段数 */
export function countSegments(outputDir: string): number {
  try {
    return fs
      .readdirSync(outputDir)
      .filter((f) => f.startsWith('part_') && f.endsWith('.mp4')).length;
  } catch {
    return 0;
  }
}

/** 从 stderr 里提炼一段可读的错误信息 */
function extractError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('frame=') && !l.startsWith('size='));

  const meaningful = lines.filter((l) =>
    /error|invalid|failed|unable|could not|no such|not found|permission|denied|moov|corrupt/i.test(
      l,
    ),
  );
  const picked = (meaningful.length ? meaningful : lines).slice(-4);
  return picked.join(' | ').slice(0, 800);
}

/**
 * 启动一次切割。返回句柄，进度通过 onProgress 实时回调。
 *
 * 进度来源：解析 stderr 的 `time=` 与 `Duration:`，
 * 百分比 = 已处理秒数 / 总秒数；片段数直接数输出目录。
 */
export function cutVideo(opts: {
  input: string;
  outputDir: string;
  segmentTime: number;
  mode: CutMode;
  onProgress: (p: CutProgress) => void;
}): CutHandle {
  const { input, outputDir, segmentTime, mode, onProgress } = opts;

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPattern = path.join(outputDir, 'part_%03d.mp4');
  const args = buildCutArgs({ input, outputPattern, segmentTime, mode });

  const proc = spawn(config.ffmpegPath, args, { windowsHide: true });

  let totalSeconds: number | null = null;
  let processedSeconds = 0;
  let stderrTail = '';
  let stderrAll = '';
  let lastReportAt = 0;
  let cancelled = false;

  const report = (message: string, force = false): void => {
    const now = Date.now();
    // 节流：最多每 400ms 上报一次，避免 SSE/DB 被刷爆
    if (!force && now - lastReportAt < 400) return;
    lastReportAt = now;

    const progress =
      totalSeconds && totalSeconds > 0
        ? Math.max(0, Math.min(99, (processedSeconds / totalSeconds) * 100))
        : 0;

    onProgress({
      processedSeconds: Math.round(processedSeconds * 10) / 10,
      totalSeconds,
      progress: Math.round(progress * 10) / 10,
      segments: countSegments(outputDir),
      message,
    });
  };

  const onStderr = (chunk: Buffer): void => {
    const text = chunk.toString();
    stderrAll += text;
    if (stderrAll.length > 20000) stderrAll = stderrAll.slice(-20000);

    // 保留尾部缓冲，避免时间戳被数据块边界切断
    stderrTail += text;
    if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);

    if (totalSeconds === null) {
      const m = stderrTail.match(DURATION_RE);
      if (m) totalSeconds = toSeconds(m[1], m[2], m[3]);
    }

    TIME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let latest: number | null = null;
    while ((match = TIME_RE.exec(stderrTail)) !== null) {
      latest = toSeconds(match[1], match[2], match[3]);
    }
    if (latest !== null) {
      processedSeconds = latest;
      report('正在切割...');
    }
  };

  proc.stderr?.on('data', onStderr);

  const timeout = setTimeout(() => {
    cancelled = true;
    proc.kill('SIGKILL');
  }, config.ffmpegTimeoutMs);

  const cancel = (): void => {
    cancelled = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 进程可能已退出 */
    }
  };

  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`无法启动 FFmpeg：${err.message}（检查 FFMPEG_PATH）`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);

      if (cancelled) {
        reject(Object.assign(new Error('任务已取消'), { code: 'CANCELLED' }));
        return;
      }
      if (signal) {
        reject(new Error(`FFmpeg 被信号 ${signal} 终止`));
        return;
      }
      if (code === 0) {
        const finalSeconds = totalSeconds ?? processedSeconds;
        onProgress({
          processedSeconds: Math.round(finalSeconds * 10) / 10,
          totalSeconds,
          progress: 100,
          segments: countSegments(outputDir),
          message: '切割完成',
        });
        resolve();
        return;
      }

      const detail = extractError(stderrAll);
      reject(new Error(detail || `FFmpeg 退出码 ${code}`));
    });
  });

  return { proc, done, cancel };
}
