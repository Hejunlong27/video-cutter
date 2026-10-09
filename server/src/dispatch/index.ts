import IORedis from 'ioredis';
import { config } from '../config';
import { InlineDispatcher } from './inline';
import type { TaskDispatcher } from './types';

let current: TaskDispatcher | null = null;

/** 快速探测 Redis 是否可达（不重试、不排队，最多等 timeoutMs） */
async function canReachRedis(timeoutMs = 1500): Promise<boolean> {
  const client = new IORedis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // 连不上时会 emit error，这里吞掉，避免变成未处理异常
  client.on('error', () => undefined);

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.ping();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis probe timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    client.disconnect();
  }
}

/**
 * 按 QUEUE_DRIVER 创建调度器。
 *
 * auto（默认）会先探测 Redis：通就用 BullMQ，不通就自动降级为进程内调度，
 * 这样本地不装 Redis 也能直接把整个应用跑起来。
 */
export async function createDispatcher(): Promise<TaskDispatcher> {
  const mode = config.queueDriver;

  if (mode === 'inline') {
    console.log('[dispatch] 驱动 = inline（进程内调度，不依赖 Redis）');
    return new InlineDispatcher();
  }

  if (mode === 'redis') {
    const { BullMqDispatcher } = await import('./bullmq');
    console.log(`[dispatch] 驱动 = redis（${config.redisUrl}）`);
    return new BullMqDispatcher();
  }

  // auto
  if (await canReachRedis()) {
    const { BullMqDispatcher } = await import('./bullmq');
    console.log(`[dispatch] 驱动 = redis（${config.redisUrl}）`);
    return new BullMqDispatcher();
  }

  console.log('[dispatch] 驱动 = inline（未探测到 Redis，已自动降级为进程内调度）');
  return new InlineDispatcher();
}

export function setDispatcher(dispatcher: TaskDispatcher): void {
  current = dispatcher;
}

/**
 * 取当前调度器。
 * 兜底：如果没显式初始化过（例如只 createApp() 的测试场景），
 * 就用进程内调度 —— 保证路由永远可用。
 */
export function getDispatcher(): TaskDispatcher {
  if (!current) current = new InlineDispatcher();
  return current;
}

export type { TaskDispatcher, DriverName, DispatcherStats } from './types';
