/**
 * 端到端验证 —— 走完整 HTTP API + 进程内调度，全程不需要 Redis。
 *
 * 覆盖用户真实操作路径：
 *   上传 → 建任务 → SSE 实时进度 → 片段列表 → 单片段播放 → 打包 ZIP 下载 → 删除任务
 *
 * 这条链路跑通，就等于「一键启动后能正常用」。
 *
 * 用法：npx tsx scripts/e2e-test.ts <视频路径> [每段秒数]
 */
import fs from 'node:fs';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { setDispatcher } from '../src/dispatch';
import { InlineDispatcher } from '../src/dispatch/inline';
import { config, ensureStorageDirs, taskRootDir } from '../src/config';
import type { ApiTask, SegmentInfo } from '../src/types';

const SAMPLE = process.argv[2];
const SEGMENT_TIME = Number(process.argv[3] || 10);
const PORT = 4102;
const BASE = `http://127.0.0.1:${PORT}`;

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
  if (!SAMPLE || !fs.existsSync(SAMPLE)) {
    console.error(`测试视频不存在: ${SAMPLE}`);
    console.error('用法: npx tsx scripts/e2e-test.ts <视频路径> [每段秒数]');
    process.exit(1);
  }

  // 强制走进程内调度 —— 证明没有 Redis 也能完整跑通
  setDispatcher(new InlineDispatcher());

  // 上一次跑完会清掉 storage 目录，这里必须重建
  ensureStorageDirs();

  const app = createApp();
  const server: Server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 300));

  let taskId: string | null = null;

  try {
    console.log(`测试视频: ${SAMPLE}  每段 ${SEGMENT_TIME}s  端口 ${PORT}`);

    // --- 1. 健康检查，确认驱动是 inline ---
    console.log('\n[1] 服务与驱动');
    const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
    check('GET /api/health', health.ok === true);
    check('调度驱动为 inline（未用 Redis）', health.driver === 'inline', String(health.driver));

    // --- 2. 上传 ---
    console.log('\n[2] 上传');
    const buf = fs.readFileSync(SAMPLE);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'video/mp4' }), 'sample.mp4');
    const upRes = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
    const uploaded = await upRes.json();
    check('POST /api/upload 返回 201', upRes.status === 201, `HTTP ${upRes.status}`);
    check('拿到 fileId', typeof uploaded.fileId === 'string', uploaded.fileId?.slice(0, 8));

    // --- 3. 建任务 ---
    console.log('\n[3] 创建任务');
    const createRes = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: uploaded.fileId, segmentTime: SEGMENT_TIME, mode: 'fast' }),
    });
    const created = await createRes.json();
    check('POST /api/tasks 返回 201', createRes.status === 201, `HTTP ${createRes.status}`);
    taskId = created.task?.id ?? null;
    check('拿到 taskId', typeof taskId === 'string', String(taskId).slice(0, 8));
    if (!taskId) throw new Error('创建任务失败，后续步骤无法继续（检查上传是否成功）');

    // --- 4. SSE 实时进度，直到终态 ---
    console.log('\n[4] SSE 实时进度');
    const sseRes = await fetch(`${BASE}/api/tasks/${taskId}/events`);
    check(
      'SSE Content-Type 正确',
      (sseRes.headers.get('content-type') || '').includes('text/event-stream'),
    );

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const frames: string[] = [];
    let buffer = '';

    const done = await Promise.race([
      (async () => {
        for (;;) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) return true;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            frames.push(frame);
            buffer = buffer.slice(idx + 2);
            if (frame.includes('event: done')) return true;
          }
        }
      })(),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 60000)),
    ]);

    check('SSE 收到终态（任务跑完）', done, `共 ${frames.length} 帧`);
    check('推送过 processing 状态', frames.some((f) => f.includes('"status":"processing"')));
    check('终态为 completed', frames.some((f) => f.includes('"status":"completed"')));

    // --- 5. 任务详情 + 片段列表 ---
    console.log('\n[5] 任务详情与片段');
    const detail = await fetch(`${BASE}/api/tasks/${taskId}`).then((r) => r.json());
    const task: ApiTask = detail.task;
    check('任务状态为 completed', task.status === 'completed', task.status);
    check('进度为 100', task.progress === 100, String(task.progress));

    const segRes = await fetch(`${BASE}/api/tasks/${taskId}/segments`).then((r) => r.json());
    const segments: SegmentInfo[] = segRes.segments;
    const expected = Math.ceil((task.totalSeconds ?? 0) / SEGMENT_TIME);
    check('片段数量符合预期', segments.length === expected, `${segments.length} 段（预期 ${expected}）`);
    check('片段命名规范', segments.every((s) => /^part_\d{3}\.mp4$/.test(s.name)));
    check('片段都有非零大小', segments.every((s) => s.size > 0));

    // --- 6. 单个片段下载 ---
    console.log('\n[6] 单片段下载');
    const oneRes = await fetch(`${BASE}/api/tasks/${taskId}/segments/${segments[0].name}`);
    check('GET 单片段返回 200', oneRes.status === 200, `HTTP ${oneRes.status}`);
    check('Content-Type 为 video/mp4', oneRes.headers.get('content-type') === 'video/mp4');
    const oneBuf = Buffer.from(await oneRes.arrayBuffer());
    check('单片段字节数与列表一致', oneBuf.length === segments[0].size,
      `${oneBuf.length} vs ${segments[0].size}`);

    // --- 7. 打包 ZIP ---
    console.log('\n[7] 打包 ZIP');
    const zipRes = await fetch(`${BASE}/api/tasks/${taskId}/download`);
    check('GET /download 返回 200', zipRes.status === 200, `HTTP ${zipRes.status}`);
    check(
      'Content-Type 为 application/zip',
      zipRes.headers.get('content-type') === 'application/zip',
      String(zipRes.headers.get('content-type')),
    );
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    check('ZIP 魔数为 PK\\x03\\x04', zipBuf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
    // ZIP 的本地文件头里存的是明文文件名，直接扫即可
    const zipText = zipBuf.toString('latin1');
    const missing = segments.filter((s) => !zipText.includes(s.name));
    check('ZIP 内含全部片段', missing.length === 0,
      missing.length ? `缺 ${missing.map((m) => m.name).join(',')}` : `${segments.length} 个`);

    // --- 8. 取消路径（新建一个任务立刻取消） ---
    console.log('\n[8] 取消任务');
    const create2 = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: uploaded.fileId, segmentTime: SEGMENT_TIME, mode: 'precise' }),
    }).then((r) => r.json());
    const cancelId = create2.task.id;
    const cancelRes = await fetch(`${BASE}/api/tasks/${cancelId}/cancel`, { method: 'POST' });
    check('POST /cancel 返回 200', cancelRes.status === 200, `HTTP ${cancelRes.status}`);
    const cancelled = await fetch(`${BASE}/api/tasks/${cancelId}`).then((r) => r.json());
    check(
      '取消后状态为 cancelled 或已完成',
      ['cancelled', 'completed'].includes(cancelled.task.status),
      cancelled.task.status,
    );
    await fetch(`${BASE}/api/tasks/${cancelId}`, { method: 'DELETE' });

    // --- 9. 删除任务，文件应一并清除 ---
    console.log('\n[9] 删除任务');
    const delRes = await fetch(`${BASE}/api/tasks/${taskId}`, { method: 'DELETE' });
    check('DELETE /api/tasks/:id 返回 200', delRes.status === 200, `HTTP ${delRes.status}`);
    check('任务目录已从磁盘删除', !fs.existsSync(taskRootDir(taskId!)));
    const after = await fetch(`${BASE}/api/tasks/${taskId}`).then((r) => r.status);
    check('再查该任务返回 404', after === 404, `HTTP ${after}`);
    taskId = null;

    // --- 10. 数据库应无残留 ---
    console.log('\n[10] 收尾检查');
    await fetch(`${BASE}/api/upload/${uploaded.fileId}`, { method: 'DELETE' });
    const leftTasks = await prisma.task.count();
    const leftUploads = await prisma.upload.count();
    check('数据库无任务残留', leftTasks === 0, `${leftTasks} 条`);
    check('数据库无上传残留', leftUploads === 0, `${leftUploads} 条`);
  } finally {
    // 出错时也别把数据留在库里
    if (taskId) {
      await prisma.task.deleteMany({ where: { id: taskId } }).catch(() => undefined);
      fs.rmSync(taskRootDir(taskId), { recursive: true, force: true });
    }
    await prisma.task.deleteMany({}).catch(() => undefined);
    await prisma.upload.deleteMany({}).catch(() => undefined);
    fs.rmSync(config.taskDir, { recursive: true, force: true });
    fs.rmSync(config.uploadDir, { recursive: true, force: true });

    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('端到端测试异常:', err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
