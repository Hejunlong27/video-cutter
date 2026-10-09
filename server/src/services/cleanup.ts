import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { config, taskRootDir } from '../config';
import { TASK_STATUS } from '../types';

function rmDirSafe(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[cleanup] 删除目录失败 ${dir}:`, (err as Error).message);
  }
}

/** 删除单个任务的磁盘产物（片段目录 + zip） */
export function purgeTaskFiles(taskId: string): void {
  rmDirSafe(taskRootDir(taskId));
}

/** 删除上传源文件 */
export function purgeUploadFile(storedName: string): void {
  try {
    fs.rmSync(path.join(config.uploadDir, storedName), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 清理过期任务：
 * 1. 终态（completed/failed/cancelled）且超过 RETENTION_HOURS 的任务 —— 删文件 + 删记录
 * 2. 孤儿上传文件（没有任何任务引用且超过保留期）—— 删文件
 */
export async function runCleanup(): Promise<{ tasks: number; uploads: number }> {
  const cutoff = new Date(Date.now() - config.retentionHours * 3600 * 1000);
  const terminal = [
    TASK_STATUS.COMPLETED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
  ];

  const expiredTasks = await prisma.task.findMany({
    where: {
      status: { in: terminal },
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
  });

  for (const t of expiredTasks) {
    purgeTaskFiles(t.id);
    await prisma.task.delete({ where: { id: t.id } }).catch(() => undefined);
  }

  // 孤儿上传：没有关联任务、且创建时间超过保留期
  const orphanUploads = await prisma.upload.findMany({
    where: {
      createdAt: { lt: cutoff },
      tasks: { none: {} },
    },
    select: { id: true, storedName: true },
  });

  for (const u of orphanUploads) {
    purgeUploadFile(u.storedName);
    await prisma.upload.delete({ where: { id: u.id } }).catch(() => undefined);
  }

  if (expiredTasks.length || orphanUploads.length) {
    console.log(
      `[cleanup] 清理任务 ${expiredTasks.length} 个，孤儿上传 ${orphanUploads.length} 个`,
    );
  }

  return { tasks: expiredTasks.length, uploads: orphanUploads.length };
}

/** 启动定时清理（返回停止函数） */
export function startCleanupScheduler(): () => void {
  const intervalMs = config.cleanupIntervalMinutes * 60 * 1000;

  const timer = setInterval(() => {
    runCleanup().catch((err) =>
      console.error('[cleanup] 执行失败:', (err as Error).message),
    );
  }, intervalMs);
  timer.unref?.();

  // 启动 10 秒后先跑一次，清掉上次进程遗留的过期数据
  const boot = setTimeout(() => {
    runCleanup().catch(() => undefined);
  }, 10_000);
  boot.unref?.();

  console.log(
    `[cleanup] 已启动：每 ${config.cleanupIntervalMinutes} 分钟清理一次，保留 ${config.retentionHours} 小时`,
  );

  return () => {
    clearInterval(timer);
    clearTimeout(boot);
  };
}
