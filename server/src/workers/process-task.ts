import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../db';
import { config, taskOutputDir } from '../config';
import { cutVideo, probeDuration, countSegments } from '../services/ffmpeg';
import { eventBus } from '../services/events';
import { runningTasks } from '../services/registry';
import { TASK_STATUS, type CutMode, type ProgressEvent } from '../types';

/**
 * BullMQ Job 的最小结构。
 *
 * 只依赖 `data.taskId`，所以测试可以直接传 `{ data: { taskId } }` 来驱动，
 * 不需要真的起 Redis。BullMQ 的 Job 对象在结构上兼容这个接口。
 */
export interface CutJobLike {
  data: { taskId: string };
}

async function setStatus(
  taskId: string,
  patch: Record<string, unknown>,
  extra?: Partial<ProgressEvent>,
): Promise<void> {
  const task = await prisma.task.update({
    where: { id: taskId },
    data: patch,
  });

  eventBus.publish({
    taskId,
    status: task.status as ProgressEvent['status'],
    progress: task.progress,
    processedSeconds: task.processedSeconds,
    totalSeconds: task.totalSeconds ?? null,
    segments: task.segmentCount,
    message: task.message ?? '',
    error: task.error,
    ...extra,
  });
}

/**
 * 单个切割任务的完整业务逻辑。
 *
 * 状态流转：
 *   queued → processing → completed
 *                       → cancelled（用户取消）
 *                       → failed（源文件缺失 / ffmpeg 报错 / 超时 / 0 片段）
 *
 * 这个函数不关心「任务是怎么被调度过来的」，因此可以脱离 BullMQ 单独测试。
 */
export async function processCutJob(job: CutJobLike): Promise<void> {
  const { taskId } = job.data;

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { upload: true },
  });

  if (!task) {
    throw new Error(`任务 ${taskId} 不存在`);
  }

  // 已被取消的任务不再执行
  if (task.status === TASK_STATUS.CANCELLED) {
    return;
  }

  const inputPath = path.join(config.uploadDir, task.upload.storedName);
  if (!fs.existsSync(inputPath)) {
    await setStatus(taskId, {
      status: TASK_STATUS.FAILED,
      message: '源文件不存在',
      error: '上传文件已被删除或移动，请重新上传',
      finishedAt: new Date(),
    });
    return;
  }

  const outputDir = taskOutputDir(taskId);

  // 清空可能存在的旧片段，保证重跑干净
  for (const f of fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []) {
    try {
      fs.rmSync(path.join(outputDir, f), { force: true });
    } catch {
      /* ignore */
    }
  }

  const totalSeconds =
    task.totalSeconds ?? (await probeDuration(inputPath)) ?? null;

  // 排队期间可能已被取消 —— 起 ffmpeg 之前再确认一次状态，
  // 避免「用户刚点取消，任务恰好开始跑」这种竞态。
  const fresh = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true },
  });
  if (!fresh || fresh.status === TASK_STATUS.CANCELLED) {
    return;
  }

  await setStatus(taskId, {
    status: TASK_STATUS.PROCESSING,
    startedAt: new Date(),
    totalSeconds,
    message: '正在切割...',
    error: null,
  });

  let lastDbWrite = 0;

  const handle = cutVideo({
    input: inputPath,
    outputDir,
    segmentTime: task.segmentTime,
    mode: task.mode as CutMode,
    onProgress: (p) => {
      // SSE 每次都推（要实时）；DB 写入节流到 800ms，减轻 SQLite 压力
      eventBus.publish({
        taskId,
        status: TASK_STATUS.PROCESSING,
        progress: p.progress,
        processedSeconds: p.processedSeconds,
        totalSeconds: p.totalSeconds,
        segments: p.segments,
        message: p.message,
        error: null,
      });

      const now = Date.now();
      if (now - lastDbWrite > 800) {
        lastDbWrite = now;
        void prisma.task
          .update({
            where: { id: taskId },
            data: {
              progress: p.progress,
              processedSeconds: p.processedSeconds,
              totalSeconds: p.totalSeconds,
              segmentCount: p.segments,
              message: p.message,
            },
          })
          .catch(() => undefined);
      }
    },
  });

  runningTasks.register(taskId, handle);

  try {
    await handle.done;

    // 取消优先于完成：用户已取消但 ffmpeg 恰好跑完时，不要把状态改回 completed
    const latest = await prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!latest || latest.status === TASK_STATUS.CANCELLED) {
      return;
    }

    const segmentCount = countSegments(outputDir);
    if (segmentCount === 0) {
      throw new Error('FFmpeg 未生成任何片段，请检查输入文件是否可解码');
    }

    await setStatus(
      taskId,
      {
        status: TASK_STATUS.COMPLETED,
        progress: 100,
        segmentCount,
        message: `已完成，共 ${segmentCount} 个片段`,
        finishedAt: new Date(),
        error: null,
      },
      { progress: 100, segments: segmentCount },
    );
  } catch (err) {
    const e = err as Error & { code?: string };

    if (e.code === 'CANCELLED') {
      await setStatus(taskId, {
        status: TASK_STATUS.CANCELLED,
        message: '任务已取消',
        finishedAt: new Date(),
      });
      return;
    }

    const isTimeout = /信号 SIGKILL/.test(e.message);
    await setStatus(taskId, {
      status: TASK_STATUS.FAILED,
      message: isTimeout ? '任务超时' : '切割失败',
      error: isTimeout
        ? `FFmpeg 执行超过 ${config.ffmpegTimeoutMs / 60000} 分钟被终止`
        : e.message,
      finishedAt: new Date(),
    });
  } finally {
    runningTasks.unregister(taskId);
  }
}
