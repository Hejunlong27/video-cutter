import { EventEmitter } from 'node:events';
import type { ProgressEvent } from '../types';

/**
 * 进程内事件总线。
 *
 * API 进程与 Worker 进程运行在同一个 Node 实例中（见 src/index.ts），
 * 所以用 EventEmitter 把 worker 的进度直接推给 SSE 连接，零额外依赖。
 *
 * 如果将来把 worker 拆成独立进程/容器，把这里替换为 Redis pub/sub 即可：
 *   publish  -> redis.publish(`task:${taskId}`, JSON.stringify(evt))
 *   subscribe-> redis.subscribe(...) 再 eventBus.emit(...)
 */
class TaskEventBus extends EventEmitter {
  publish(event: ProgressEvent): void {
    this.emit(`task:${event.taskId}`, event);
    this.emit('task:*', event);
  }

  subscribe(taskId: string, listener: (event: ProgressEvent) => void): () => void {
    const channel = `task:${taskId}`;
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
}

export const eventBus = new TaskEventBus();
// SSE 长连接数量可能较多，去掉默认 10 个监听器告警
eventBus.setMaxListeners(0);
