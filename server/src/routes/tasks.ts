import { Router } from 'express';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Upload, Task } from '@prisma/client';
import { prisma } from '../db';
import { config, taskOutputDir } from '../config';
import { getDispatcher } from '../dispatch';
import { runningTasks } from '../services/registry';
import { eventBus } from '../services/events';
import { purgeTaskFiles } from '../services/cleanup';
import { asyncHandler, badRequest, conflict, notFound } from '../utils/errors';
import { clampSegmentTime, isSafeSegmentName, isValidId } from '../utils/validate';
import {
  TASK_STATUS,
  type ApiTask,
  type CutMode,
  type ProgressEvent,
  type SegmentInfo,
  type TaskStatus,
} from '../types';

const router = Router();

type TaskWithUpload = Task & { upload: Upload };

const TERMINAL: TaskStatus[] = [
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
];

function toApiTask(task: TaskWithUpload): ApiTask {
  return {
    id: task.id,
    uploadId: task.uploadId,
    originalName: task.upload.originalName,
    segmentTime: task.segmentTime,
    mode: task.mode as CutMode,
    outputFormat: task.outputFormat,
    status: task.status as TaskStatus,
    progress: task.progress,
    processedSeconds: task.processedSeconds,
    totalSeconds: task.totalSeconds ?? null,
    segmentCount: task.segmentCount,
    message: task.message,
    error: task.error,
    size: task.upload.size,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    finishedAt: task.finishedAt?.toISOString() ?? null,
  };
}

function toProgressEvent(task: TaskWithUpload): ProgressEvent {
  return {
    taskId: task.id,
    status: task.status as TaskStatus,
    progress: task.progress,
    processedSeconds: task.processedSeconds,
    totalSeconds: task.totalSeconds ?? null,
    segments: task.segmentCount,
    message: task.message ?? '',
    error: task.error,
  };
}

async function loadTask(id: string): Promise<TaskWithUpload> {
  if (!isValidId(id)) throw badRequest('任务 ID 格式非法');
  const task = await prisma.task.findUnique({
    where: { id },
    include: { upload: true },
  });
  if (!task) throw notFound('任务不存在');
  return task;
}

/** 列出任务输出目录中的片段 */
function listSegments(taskId: string): SegmentInfo[] {
  const dir = taskOutputDir(taskId);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('part_') && f.endsWith('.mp4'))
    .sort()
    .map((name, idx) => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        name,
        size: stat.size,
        index: idx,
        url: `/api/tasks/${taskId}/segments/${name}`,
      };
    });
}

// ---------------------------------------------------------------------------
// POST /api/tasks —— 创建切割任务
// ---------------------------------------------------------------------------
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { fileId, segmentTime, mode, outputFormat } = req.body ?? {};

    if (!fileId || typeof fileId !== 'string' || !isValidId(fileId)) {
      throw badRequest('缺少或非法的 fileId');
    }
    if (mode !== undefined && mode !== 'fast' && mode !== 'precise') {
      throw badRequest('mode 只能是 fast 或 precise');
    }
    const fmt = (outputFormat ?? 'mp4').toString().toLowerCase();
    if (fmt !== 'mp4') {
      throw badRequest('当前仅支持 mp4 输出格式');
    }

    const upload = await prisma.upload.findUnique({ where: { id: fileId } });
    if (!upload) throw notFound('上传文件不存在，请重新上传');

    // 并发闸门：限制排队中 + 处理中的任务总数
    const activeLimit = config.maxConcurrency * 5;
    const active = await prisma.task.count({
      where: {
        status: { in: [TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING, TASK_STATUS.PENDING] },
      },
    });
    if (active >= activeLimit) {
      throw conflict(`当前进行中的任务过多（上限 ${activeLimit}），请稍后再试`);
    }

    const taskId = crypto.randomUUID();
    const outputDir = taskOutputDir(taskId);

    const created = await prisma.task.create({
      data: {
        id: taskId,
        uploadId: upload.id,
        segmentTime: clampSegmentTime(segmentTime, config.defaultSegmentTime),
        mode: mode ?? 'fast',
        outputFormat: fmt,
        status: TASK_STATUS.QUEUED,
        message: '已加入队列',
        outputDir,
        totalSeconds: upload.duration,
      },
      include: { upload: true },
    });

    try {
      await getDispatcher().enqueue(taskId);
    } catch (err) {
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: TASK_STATUS.FAILED,
          message: '入队失败',
          error: `任务调度不可用：${(err as Error).message}`,
          finishedAt: new Date(),
        },
      });
      throw new Error(`任务入队失败：${(err as Error).message}`);
    }

    res.status(201).json({ task: toApiTask(created) });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/tasks —— 任务列表
// ---------------------------------------------------------------------------
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const status = req.query.status as string | undefined;

    const tasks = await prisma.task.findMany({
      where: status ? { status } : undefined,
      include: { upload: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const active = await prisma.task.count({
      where: { status: { in: [TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING] } },
    });

    res.json({
      tasks: tasks.map(toApiTask),
      active,
      maxConcurrency: config.maxConcurrency,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/tasks/:id —— 任务详情
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await loadTask(req.params.id);
    res.json({
      task: toApiTask(task),
      segments: task.status === TASK_STATUS.COMPLETED ? listSegments(task.id) : [],
      running: runningTasks.isRunning(task.id),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/events —— SSE 实时进度
// ---------------------------------------------------------------------------
router.get(
  '/:id/events',
  asyncHandler(async (req, res) => {
    const task = await loadTask(req.params.id);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关键：告诉 nginx / 反代不要缓冲
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const write = (eventName: string, payload: unknown): void => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // 先补一帧当前状态，避免前端等待
    write('progress', toProgressEvent(task));

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    const handleEvent = (event: ProgressEvent): void => {
      if (closed) return;
      write('progress', event);
      if (TERMINAL.includes(event.status)) {
        write('done', event);
        cleanup();
      }
    };

    const unsubscribe = eventBus.subscribe(task.id, handleEvent);

    // 心跳，防止代理/浏览器 60s 断连
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);

    // 任务若已是终态，上面首帧已经推过，这里直接收尾
    if (TERMINAL.includes(task.status as TaskStatus)) {
      write('done', toProgressEvent(task));
      cleanup();
      return;
    }

    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }),
);

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/segments —— 片段列表
// ---------------------------------------------------------------------------
router.get(
  '/:id/segments',
  asyncHandler(async (req, res) => {
    const task = await loadTask(req.params.id);
    res.json({
      taskId: task.id,
      status: task.status,
      segmentTime: task.segmentTime,
      mode: task.mode,
      segments: listSegments(task.id),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/segments/:name —— 单个片段下载 / 在线播放
// ---------------------------------------------------------------------------
router.get(
  '/:id/segments/:name',
  asyncHandler(async (req, res) => {
    const { id, name } = req.params;
    if (!isSafeSegmentName(name)) throw badRequest('非法的片段文件名');

    const task = await loadTask(id);
    const filePath = path.join(taskOutputDir(task.id), name);

    // 二次确认：解析后的路径必须仍在任务目录内
    const root = path.resolve(taskOutputDir(task.id));
    if (!path.resolve(filePath).startsWith(root + path.sep)) {
      throw badRequest('非法路径');
    }
    if (!fs.existsSync(filePath)) throw notFound('片段不存在');

    const download = req.query.download === '1';
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${name}"`,
    );
    fs.createReadStream(filePath).pipe(res);
  }),
);

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/download —— 打包 ZIP 下载
// ---------------------------------------------------------------------------
router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const task = await loadTask(req.params.id);

    if (task.status !== TASK_STATUS.COMPLETED) {
      throw conflict(`任务尚未完成（当前状态：${task.status}）`);
    }

    const segments = listSegments(task.id);
    if (segments.length === 0) throw notFound('没有可下载的片段');

    const dir = taskOutputDir(task.id);
    const filename = `segments_${task.id}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      console.error('[zip] 打包失败:', err.message);
      res.destroy(err);
    });

    archive.pipe(res);
    for (const seg of segments) {
      archive.file(path.join(dir, seg.name), { name: seg.name });
    }
    await archive.finalize();
  }),
);

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/cancel —— 取消任务
// ---------------------------------------------------------------------------
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const task = await loadTask(req.params.id);

    if (TERMINAL.includes(task.status as TaskStatus)) {
      res.json({ ok: true, task: toApiTask(task), note: '任务已处于终态' });
      return;
    }

    // 1) 正在跑：kill ffmpeg，worker 的 catch 会落 cancelled
    const killed = runningTasks.cancel(task.id);

    // 2) 还在排队：从调度器摘掉
    if (!killed) {
      await getDispatcher().remove(task.id).catch(() => false);
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: TASK_STATUS.CANCELLED,
        message: '任务已取消',
        finishedAt: new Date(),
      },
      include: { upload: true },
    });

    res.json({ ok: true, task: toApiTask(updated), killedProcess: killed });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id —— 删除任务与全部文件
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await loadTask(req.params.id);

    if (runningTasks.isRunning(task.id)) {
      runningTasks.cancel(task.id);
      // 给 ffmpeg 一点时间释放文件句柄（Windows 上文件被占用会导致删不掉）
      await new Promise((r) => setTimeout(r, 400));
    }
    await getDispatcher().remove(task.id).catch(() => false);

    purgeTaskFiles(task.id);
    await prisma.task.delete({ where: { id: task.id } });

    res.json({ ok: true, deleted: task.id });
  }),
);

export default router;
