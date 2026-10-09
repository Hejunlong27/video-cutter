import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { config } from '../config';
import { processCutJob } from '../workers/process-task';
import type { DispatcherStats, TaskDispatcher } from './types';

export const QUEUE_NAME = 'video-cut';

export interface CutJobData {
  taskId: string;
}

export function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    // BullMQ 要求：阻塞式命令不能被 ioredis 的自动重试打断
    maxRetriesPerRequest: null,
  };
}

/**
 * BullMQ + Redis 调度 —— 生产形态。
 *
 * Queue 负责入队，Worker 负责取任务执行；业务逻辑仍在 process-task.ts。
 * 想横向扩容时，把 worker 拆成独立进程/容器，只 import 这一个文件即可。
 */
export class BullMqDispatcher implements TaskDispatcher {
  readonly driver = 'redis' as const;

  private readonly queue: Queue<CutJobData>;
  private readonly worker: Worker<CutJobData>;
  private readonly connection: ConnectionOptions;

  constructor() {
    this.connection = parseRedisUrl(config.redisUrl);

    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1, // 切割任务重试意义不大，失败即失败
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });

    this.worker = new Worker(QUEUE_NAME, processCutJob, {
      connection: this.connection,
      concurrency: config.maxConcurrency,
    });

    this.worker.on('failed', (job, err) => {
      // 进程级异常兜底（processCutJob 内部已处理业务错误）
      console.error(`[worker] job ${job?.id} failed:`, err.message);
    });
    this.worker.on('error', (err) => {
      console.error('[worker] error:', err.message);
    });
  }

  async enqueue(taskId: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('入队超时，Redis 可能不可达')),
        8000,
      );
    });

    try {
      // jobId 用 taskId，天然去重
      await Promise.race([
        this.queue.add('cut', { taskId } satisfies CutJobData, { jobId: taskId }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async remove(taskId: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    });

    try {
      return await Promise.race([
        (async () => {
          const job = await this.queue.getJob(taskId);
          if (!job) return false;
          await job.remove();
          return true;
        })().catch(() => false),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stats(): Promise<DispatcherStats> {
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
      return {
        pending: (counts.waiting ?? 0) + (counts.delayed ?? 0),
        active: counts.active ?? 0,
      };
    } catch {
      return { pending: 0, active: 0 };
    }
  }

  async close(): Promise<void> {
    await this.worker.close().catch(() => undefined);
    await this.queue.close().catch(() => undefined);
  }
}
