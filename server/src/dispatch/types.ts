/**
 * 任务调度抽象。
 *
 * 项目有两种运行形态：
 *   redis  —— BullMQ + Redis，任务可跨进程/跨机器，适合生产
 *   inline —— 进程内队列，零外部依赖，适合本地试用与自动化测试
 *
 * 两者共用同一份业务逻辑（workers/process-task.ts），所以行为一致，
 * 上层（路由）只依赖这个接口，不关心底下是哪种。
 */
export type DriverName = 'redis' | 'inline';

export interface DispatcherStats {
  /** 排队等待执行的任务数 */
  pending: number;
  /** 正在执行的任务数 */
  active: number;
}

export interface TaskDispatcher {
  readonly driver: DriverName;

  /** 把任务交给调度器执行。抛错表示没能入队。 */
  enqueue(taskId: string): Promise<void>;

  /**
   * 尝试摘掉还没开始执行的任务。
   * 返回 true 表示已摘除（后续不会再跑）；
   * 返回 false 表示任务已经在执行中 —— 此时应改用 registry 取消 ffmpeg 进程。
   */
  remove(taskId: string): Promise<boolean>;

  stats(): Promise<DispatcherStats>;

  /** 进程退出前调用，释放连接/停止取任务 */
  close(): Promise<void>;
}
