/**
 * 冒烟测试：验证「上传 → FFmpeg 切割 → 进度解析 → 片段下载」整条链路。
 *
 * 不依赖 Redis（不启动 BullMQ Worker），所以可以在没装 Redis 的机器上先跑通
 * FFmpeg 集成与 HTTP 路由。完整队列链路请用 docker compose 起 redis 后验证。
 *
 * 用法：
 *   npx tsx scripts/smoke.ts <测试视频路径> [每段秒数]
 *
 * 例：
 *   npx tsx scripts/smoke.ts ./sample.mp4 10
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { config, ensureStorageDirs } from '../src/config';
import { probeDuration, cutVideo, countSegments } from '../src/services/ffmpeg';
import { createApp } from '../src/app';
import { prisma } from '../src/db';

const SAMPLE = process.argv[2];
const SEGMENT_TIME = Number(process.argv[3] || 10);
const PORT = 4100;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(label: string, detail = ''): void {
  passed += 1;
  console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  console.error(`  \u2717 ${label} — ${detail}`);
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) ok(label, detail);
  else fail(label, detail || '断言失败');
}

async function testFfmpeg(): Promise<void> {
  console.log('\n[1] FFmpeg 集成');

  const duration = await probeDuration(SAMPLE);
  check(
    'probeDuration 读取时长',
    duration !== null && duration > 0,
    `${duration?.toFixed(2)}s`,
  );

  for (const mode of ['fast', 'precise'] as const) {
    const outDir = path.join(config.tmpDir, `smoke-${mode}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    const progressSamples: number[] = [];
    const t0 = Date.now();

    const handle = cutVideo({
      input: SAMPLE,
      outputDir: outDir,
      segmentTime: SEGMENT_TIME,
      mode,
      onProgress: (p) => progressSamples.push(p.progress),
    });
    await handle.done;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const count = countSegments(outDir);
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.mp4')).sort();

    check(`${mode} 模式生成片段`, count >= 1, `${count} 个: ${files.join(', ')}`);
    check(`${mode} 模式有进度回调`, progressSamples.length > 0, `${progressSamples.length} 次`);
    check(
      `${mode} 模式最终进度为 100`,
      progressSamples.at(-1) === 100,
      `最后一次 ${progressSamples.at(-1)}`,
    );

    // 逐段校验实际时长
    const durations: number[] = [];
    for (const f of files) {
      const d = await probeDuration(path.join(outDir, f));
      if (d !== null) durations.push(d);
    }
    const maxDrift = Math.max(...durations.map((d) => Math.abs(d - SEGMENT_TIME)));
    console.log(
      `      片段时长: [${durations.map((d) => d.toFixed(2)).join(', ')}]  耗时 ${elapsed}s  最大偏差 ${maxDrift.toFixed(2)}s`,
    );

    if (mode === 'fast') {
      ok('fast 模式：偏差允许存在（关键帧对齐）', '');
    } else {
      check(
        'precise 模式：片段时长贴合设定值',
        maxDrift < 1.0,
        `最大偏差 ${maxDrift.toFixed(2)}s`,
      );
    }
  }
}

async function testHttp(server: Server): Promise<void> {
  console.log('\n[2] HTTP 路由');

  // health
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('GET /api/health', health.ok === true, `ffmpeg=${health.ffmpeg}`);

  // limits
  const limits = await fetch(`${BASE}/api/upload/limits`).then((r) => r.json());
  check(
    'GET /api/upload/limits',
    Array.isArray(limits.allowedExtensions) && limits.maxUploadMB > 0,
    `上限 ${limits.maxUploadMB}MB，默认 ${limits.defaultSegmentTime}s`,
  );

  // 上传（multipart 流式）
  const buf = fs.readFileSync(SAMPLE);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'video/mp4' }), 'sample.mp4');
  const upRes = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  const uploaded = await upRes.json();
  check(
    'POST /api/upload 流式上传',
    upRes.status === 201 && typeof uploaded.fileId === 'string',
    `fileId=${uploaded.fileId?.slice(0, 8)} size=${uploaded.size}`,
  );
  check(
    '上传后 ffprobe 自动读到时长',
    typeof uploaded.duration === 'number' && uploaded.duration > 0,
    `${uploaded.duration?.toFixed(2)}s`,
  );

  // 拒绝非法扩展名
  const badForm = new FormData();
  badForm.append(
    'file',
    new Blob([Buffer.from('#!/bin/sh\necho pwned')], { type: 'text/x-sh' }),
    'evil.sh',
  );
  const badRes = await fetch(`${BASE}/api/upload`, { method: 'POST', body: badForm });
  check('拒绝非视频扩展名', badRes.status === 400, `HTTP ${badRes.status}`);

  // 任务列表（空）
  const list = await fetch(`${BASE}/api/tasks`).then((r) => r.json());
  check('GET /api/tasks', Array.isArray(list.tasks), `${list.tasks.length} 条`);

  // 不存在的任务
  const missing = await fetch(
    `${BASE}/api/tasks/00000000-0000-4000-8000-000000000000`,
  );
  check('GET 不存在的任务返回 404', missing.status === 404, `HTTP ${missing.status}`);

  // 非法 ID 格式
  const badId = await fetch(`${BASE}/api/tasks/..%2F..%2Fetc%2Fpasswd`);
  check('拒绝路径穿越形式的 ID', badId.status === 400 || badId.status === 404, `HTTP ${badId.status}`);

  // 删除未被引用的上传
  const delRes = await fetch(`${BASE}/api/upload/${uploaded.fileId}`, {
    method: 'DELETE',
  });
  check('DELETE /api/upload/:id', delRes.status === 200, `HTTP ${delRes.status}`);
}

async function testCleanup(): Promise<void> {
  console.log('\n[3] 文件清理');

  const dir = path.join(config.taskDir, 'smoke-cleanup', 'segments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'part_000.mp4'), 'x');

  const { purgeTaskFiles } = await import('../src/services/cleanup');
  purgeTaskFiles('smoke-cleanup');
  check(
    'purgeTaskFiles 删除任务目录',
    !fs.existsSync(path.join(config.taskDir, 'smoke-cleanup')),
    path.join(config.taskDir, 'smoke-cleanup'),
  );
}

async function main(): Promise<void> {
  if (!SAMPLE || !fs.existsSync(SAMPLE)) {
    console.error(`测试视频不存在: ${SAMPLE}`);
    console.error('用法: npx tsx scripts/smoke.ts <视频路径> [每段秒数]');
    process.exit(1);
  }

  ensureStorageDirs();
  console.log(`测试视频: ${SAMPLE}`);
  console.log(`每段秒数: ${SEGMENT_TIME}`);

  await testFfmpeg();
  await testCleanup();

  const app = createApp();
  const server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 300));
  try {
    await testHttp(server);
  } finally {
    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
