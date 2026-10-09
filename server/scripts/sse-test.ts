/**
 * SSE 进度推送验证。
 *
 * 在同一个进程内启动 API 并手动向事件总线 publish 进度，
 * 用真实 HTTP 连接读流，验证：响应头、首帧补发、进度帧、终态收尾与自动断连。
 *
 * 不依赖 Redis。用法：npx tsx scripts/sse-test.ts
 */
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { eventBus } from '../src/services/events';
import type { ProgressEvent } from '../src/types';

const PORT = 4101;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${label} — ${detail || '断言失败'}`);
  }
}

async function main(): Promise<void> {
  const uploadId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  await prisma.upload.create({
    data: {
      id: uploadId,
      originalName: 'sse-test.mp4',
      storedName: `${uploadId}.mp4`,
      ext: 'mp4',
      mimeType: 'video/mp4',
      size: 1024,
      duration: 60,
    },
  });

  await prisma.task.create({
    data: {
      id: taskId,
      uploadId,
      segmentTime: 10,
      mode: 'fast',
      status: 'processing',
      message: '正在切割...',
      outputDir: 'unused-in-test',
      totalSeconds: 60,
      progress: 0,
    },
  });

  const app = createApp();
  const server: Server = app.listen(PORT);
  await sleep(300);

  console.log('\n[SSE] 连接 /api/tasks/:id/events');

  const res = await fetch(`${BASE}/api/tasks/${taskId}/events`, {
    headers: { Accept: 'text/event-stream' },
  });

  check('HTTP 200', res.status === 200, `HTTP ${res.status}`);
  check(
    'Content-Type 为 text/event-stream',
    (res.headers.get('content-type') || '').includes('text/event-stream'),
    res.headers.get('content-type') || '',
  );
  check(
    'X-Accel-Buffering: no（防反代缓冲）',
    res.headers.get('x-accel-buffering') === 'no',
    String(res.headers.get('x-accel-buffering')),
  );

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';

  const collect = (async (): Promise<boolean> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return true;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          frames.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      }
    } catch {
      return true;
    }
  })();

  // 首帧（服务端应立即补发当前状态）
  await sleep(400);
  check('收到首帧当前状态', frames.length >= 1, frames[0]?.replace(/\n/g, ' | ') || '(无)');
  check(
    '首帧携带 status=processing',
    (frames[0] || '').includes('"status":"processing"'),
  );

  // 推一帧进度
  const base: ProgressEvent = {
    taskId,
    status: 'processing',
    progress: 50,
    processedSeconds: 30,
    totalSeconds: 60,
    segments: 3,
    message: '正在切割...',
    error: null,
  };
  eventBus.publish(base);
  await sleep(400);
  check(
    '收到实时进度帧（progress=50）',
    frames.some((f) => f.includes('"progress":50')),
    `已收 ${frames.length} 帧`,
  );
  check(
    '进度帧格式为 event: progress + data: JSON',
    frames.some((f) => f.startsWith('event: progress') && f.includes('data: {')),
  );

  // 推终态
  eventBus.publish({
    ...base,
    status: 'completed',
    progress: 100,
    segments: 6,
    message: '切割完成',
  });

  const closed = await Promise.race([
    collect.then(() => true),
    sleep(2500).then(() => false),
  ]);

  check('收到 done 事件', frames.some((f) => f.includes('event: done')));
  check('终态后服务端主动关闭连接', closed);

  // 清理测试数据
  await prisma.task.delete({ where: { id: taskId } }).catch(() => undefined);
  await prisma.upload.delete({ where: { id: uploadId } }).catch(() => undefined);

  server.close();
  await prisma.$disconnect();

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('SSE 测试异常:', err);
  process.exit(1);
});
