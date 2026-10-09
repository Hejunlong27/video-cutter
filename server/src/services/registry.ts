import type { CutHandle } from './ffmpeg';

/**
 * 正在运行的 FFmpeg 句柄注册表。
 *
 * 单独成模块（而不是放在 dispatch/ 里）的原因：
 * 路由层需要「查任务是否在跑 / 取消任务」，如果直接从 worker 模块导入，
 * 会连带把 BullMQ Worker 实例拉起来、建立 Redis 连接。
 * 抽出来后，路由与队列完全解耦。
 */
const running = new Map<string, CutHandle>();

export const runningTasks = {
  register(taskId: string, handle: CutHandle): void {
    running.set(taskId, handle);
  },
  unregister(taskId: string): void {
    running.delete(taskId);
  },
  isRunning(taskId: string): boolean {
    return running.has(taskId);
  },
  /** 取消运行中的任务，返回是否真的找到了进程 */
  cancel(taskId: string): boolean {
    const handle = running.get(taskId);
    if (!handle) return false;
    handle.cancel();
    return true;
  },
  size(): number {
    return running.size;
  },
  ids(): string[] {
    return [...running.keys()];
  },
};
