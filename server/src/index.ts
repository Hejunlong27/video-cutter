import { createApp } from './app';
import { config, ensureStorageDirs } from './config';
import { createDispatcher, setDispatcher } from './dispatch';
import { prisma } from './db';
import { startCleanupScheduler } from './services/cleanup';

async function main(): Promise<void> {
  ensureStorageDirs();

  // 按 QUEUE_DRIVER 选择调度方式：auto 会探测 Redis，探测不到就降级为进程内调度
  const dispatcher = await createDispatcher();
  setDispatcher(dispatcher);

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[api] 监听 http://${config.host}:${config.port}`);
    console.log(`[api] 调度驱动: ${dispatcher.driver}`);
    console.log(`[api] 存储目录: ${config.storageRoot}`);
    console.log(
      `[api] 并发: ${config.maxConcurrency} | 上传上限: ${(
        config.maxUploadBytes /
        1024 /
        1024
      ).toFixed(0)}MB`,
    );
    if (dispatcher.driver === 'inline') {
      console.log(
        '[api] 提示: 进程内调度 —— 排队中的任务在进程重启后会丢失；生产环境请配置 Redis',
      );
    }
  });

  const stopCleanup = startCleanupScheduler();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[api] 收到 ${signal}，正在关闭...`);
    stopCleanup();
    server.close();
    await dispatcher.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] 启动失败:', err);
  process.exit(1);
});
