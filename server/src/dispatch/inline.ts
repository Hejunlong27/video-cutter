import { config } from '../config';
import { processCutJob } from '../workers/process-task';
import { runningTasks } from '../services/registry';
import type { DispatcherStats, TaskDispatcher } from './types';

/**
 * 进程内任务调度 —— 完全不需要 Redis。
 *
 * 一个待执行队列 + 并发闸门，直接把任务喂给 processCutJob。
 * 因为 API 与调度器同进程，SSE 进度是零延迟的。
 *
 * 局限：进程重启会丢掉排队中的任务；无法横向扩容。
 * 适合本地试用、CI、以及不想装 Redis 的场景。
 */
export class InlineDispatcher implements TaskDispatcher {
  readonly driver = 'inline' as const;

  private pending: string[] = [];
  private active = 0;
  private closed = false;

  async enqueue(taskId: string): Promise<void> {
    if (this.closed) throw new Error('调度器已关闭');

    // 去重：同一个任务不重复排队
    if (this.pending.includes(taskId) || runningTasks.isRunning(taskId)) return;

    this.pending.push(taskId);
    // 用 setImmediate 让当前 HTTP 响应先返回，再开始跑 ffmpeg
    setImmediate(() => this.pump());
  }

  async remove(taskId: string): Promise<boolean> {
    const idx = this.pending.indexOf(taskId);
    if (idx === -1) {
      // 已经在执行 → 交给调用方用 runningTasks.cancel() 杀进程
      return false;
    }
    this.pending.splice(idx, 1);
    return true;
  }

  async stats(): Promise<DispatcherStats> {
    return { pending: this.pending.length, active: this.active };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending = [];
  }

  private pump(): void {
    while (
      !this.closed &&
      this.active < config.maxConcurrency &&
      this.pending.length > 0
    ) {
      const taskId = this.pending.shift()!;
      this.active += 1;

      void processCutJob({ data: { taskId } })
        .catch((err) => {
          console.error(
            `[inline] 任务 ${taskId.slice(0, 8)} 执行异常:`,
            (err as Error).message,
          );
        })
        .finally(() => {
          this.active -= 1;
          setImmediate(() => this.pump());
        });
    }
  }
}
