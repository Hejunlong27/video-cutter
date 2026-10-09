/**
 * Worker 业务逻辑验证 —— 不依赖 Redis。
 *
 * 直接调用 processCutJob()（绕过 BullMQ 的调度），验证任务状态流转：
 *   queued → processing → completed
 *                       → cancelled（取消）
 *                       → failed（源文件缺失 / 输入不可解码）
 *
 * 这样除了「BullMQ 从 Redis 取任务」这一跳，其余链路全部真实执行。
 *
 * 用法：
 *   npx tsx scripts/worker-test.ts <短视频路径> <长视频路径>
 *   例：npx tsx scripts/worker-test.ts ./sample.mp4 ./long.mp4
 *   长视频用于取消测试（需要跑得够久，建议 ≥120 秒）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/db';
import { config, ensureStorageDirs, taskOutputDir, taskRootDir } from '../src/config';
import { probeDuration, countSegments } from '../src/services/ffmpeg';
import { eventBus } from '../src/services/events';
import { runningTasks } from '../src/services/registry';
import { processCutJob } from '../src/workers/process-task';
import { TASK_STATUS, type ProgressEvent } from '../src/types';

const SAMPLE = process.argv[2];
const LONG_SAMPLE = process.argv[3];
const SEGMENT_TIME = Number(process.argv[4] || 10);

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

/** 创建一条 upload 记录，并把源文件拷进 uploads 目录 */
async function makeUpload(
  sourcePath: string | null,
  opts: { ext?: string; raw?: Buffer } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const ext = opts.ext ?? 'mp4';
  const storedName = `${id}.${ext}`;
  const target = path.join(config.uploadDir, storedName);

  if (opts.raw) {
    fs.writeFileSync(target, opts.raw);
  } else if (sourcePath) {
    fs.copyFileSync(sourcePath, target);
  }
  // sourcePath 为 null 且无 raw → 故意不落盘，用于测「源文件缺失」

  await prisma.upload.create({
    data: {
      id,
      originalName: `test.${ext}`,
      storedName,
      ext,
      mimeType: 'video/mp4',
      size: opts.raw ? opts.raw.length : sourcePath ? fs.statSync(sourcePath).size : 0,
      duration: sourcePath ? await probeDuration(sourcePath) : null,
    },
  });

  return id;
}

async function makeTask(
  uploadId: string,
  opts: { mode: 'fast' | 'precise'; segmentTime?: number; status?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.task.create({
    data: {
      id,
      uploadId,
      segmentTime: opts.segmentTime ?? SEGMENT_TIME,
      mode: opts.mode,
      status: opts.status ?? TASK_STATUS.QUEUED,
      outputDir: taskOutputDir(id),
    },
  });
  return id;
}

function captureEvents(taskId: string): { events: ProgressEvent[]; stop: () => void } {
  const events: ProgressEvent[] = [];
  const stop = eventBus.subscribe(taskId, (e) => events.push(e));
  return { events, stop };
}

const cleanupIds: { tasks: string[]; uploads: string[] } = { tasks: [], uploads: [] };

// ---------------------------------------------------------------------------

async function testSuccess(mode: 'fast' | 'precise'): Promise<void> {
  console.log(`\n[${mode}] 成功路径`);

  const uploadId = await makeUpload(SAMPLE);
  const taskId = await makeTask(uploadId, { mode });
  cleanupIds.uploads.push(uploadId);
  cleanupIds.tasks.push(taskId);

  const { events, stop } = captureEvents(taskId);
  const t0 = Date.now();
  await processCutJob({ data: { taskId } });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  stop();

  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  const files = fs
    .readdirSync(taskOutputDir(taskId))
    .filter((f) => f.startsWith('part_') && f.endsWith('.mp4'))
    .sort();

  check('状态流转到 completed', task.status === TASK_STATUS.COMPLETED, task.status);
  check('progress 归位到 100', task.progress === 100, String(task.progress));
  check('segmentCount 与磁盘文件数一致', task.segmentCount === files.length,
    `DB=${task.segmentCount} 磁盘=${files.length}`);
  check('片段命名符合 part_%03d.mp4', files.every((f) => /^part_\d{3}\.mp4$/.test(f)),
    files.join(', '));
  check('totalSeconds 已回填', typeof task.totalSeconds === 'number' && task.totalSeconds > 0,
    `${task.totalSeconds?.toFixed(1)}s`);
  check('startedAt / finishedAt 都已写入', !!task.startedAt && !!task.finishedAt);
  check('error 为空', task.error === null, String(task.error));
  check('processCutJob 结束后已从运行注册表移除', !runningTasks.isRunning(taskId));

  check('推送了 processing 事件', events.some((e) => e.status === TASK_STATUS.PROCESSING),
    `${events.length} 条事件`);
  check('最后一条事件是 completed',
    events.at(-1)?.status === TASK_STATUS.COMPLETED,
    events.at(-1)?.status ?? '(无)');
  check('终态事件携带正确片段数',
    events.at(-1)?.segments === files.length,
    `${events.at(-1)?.segments}`);

  console.log(`      耗时 ${elapsed}s，产出 ${files.length} 段，事件 ${events.length} 条`);
}

async function testCancel(): Promise<void> {
  console.log('\n[取消] 处理中取消任务');

  const uploadId = await makeUpload(LONG_SAMPLE);
  const taskId = await makeTask(uploadId, { mode: 'precise' });
  cleanupIds.uploads.push(uploadId);
  cleanupIds.tasks.push(taskId);

  const { events, stop } = captureEvents(taskId);

  // 不 await，先让任务跑起来
  const running = processCutJob({ data: { taskId } });

  // 轮询等待 ffmpeg 真的起来了
  let started = false;
  for (let i = 0; i < 50; i += 1) {
    if (runningTasks.isRunning(taskId)) {
      started = true;
      break;
    }
    await sleep(100);
  }
  check('ffmpeg 已启动并登记到运行注册表', started);

  const cancelled = runningTasks.cancel(taskId);
  check('cancel() 成功找到并终止进程', cancelled);

  await running;
  stop();

  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  check('状态流转到 cancelled', task.status === TASK_STATUS.CANCELLED, task.status);
  check('message 提示已取消', task.message === '任务已取消', String(task.message));
  check('finishedAt 已写入', !!task.finishedAt);
  check('取消后从运行注册表移除', !runningTasks.isRunning(taskId));
  check('推送了 cancelled 终态事件',
    events.some((e) => e.status === TASK_STATUS.CANCELLED));

  console.log(`      事件 ${events.length} 条，末态 ${events.at(-1)?.status}`);
}

async function testMissingSource(): Promise<void> {
  console.log('\n[失败] 源文件缺失');

  // sourcePath 传 null 且不写 raw → 数据库有记录但磁盘没文件
  const uploadId = await makeUpload(null);
  const taskId = await makeTask(uploadId, { mode: 'fast' });
  cleanupIds.uploads.push(uploadId);
  cleanupIds.tasks.push(taskId);

  await processCutJob({ data: { taskId } });

  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  check('状态流转到 failed', task.status === TASK_STATUS.FAILED, task.status);
  check('message 为「源文件不存在」', task.message === '源文件不存在', String(task.message));
  check('error 给出可操作提示',
    (task.error ?? '').includes('重新上传'), String(task.error));
}

async function testUndecodableInput(): Promise<void> {
  console.log('\n[失败] 输入不可解码');

  // 扩展名是 .mp4 但内容是纯文本
  const uploadId = await makeUpload(null, {
    raw: Buffer.from('this is definitely not a video file\n'.repeat(20)),
  });
  const taskId = await makeTask(uploadId, { mode: 'fast' });
  cleanupIds.uploads.push(uploadId);
  cleanupIds.tasks.push(taskId);

  await processCutJob({ data: { taskId } });

  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  check('状态流转到 failed', task.status === TASK_STATUS.FAILED, task.status);
  check('error 非空（来自 ffmpeg stderr）',
    typeof task.error === 'string' && task.error.length > 0,
    (task.error ?? '').slice(0, 90));
}

async function testAlreadyCancelled(): Promise<void> {
  console.log('\n[跳过] 已取消的任务不再执行');

  const uploadId = await makeUpload(SAMPLE);
  const taskId = await makeTask(uploadId, {
    mode: 'fast',
    status: TASK_STATUS.CANCELLED,
  });
  cleanupIds.uploads.push(uploadId);
  cleanupIds.tasks.push(taskId);

  await processCutJob({ data: { taskId } });

  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  const segments = countSegments(taskOutputDir(taskId));
  check('状态保持 cancelled', task.status === TASK_STATUS.CANCELLED, task.status);
  check('没有产生任何片段', segments === 0, `${segments} 个`);
}

// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  // 先删磁盘产物（Windows 上文件句柄未释放会导致 rmSync 失败，单独容错）
  for (const id of cleanupIds.tasks) {
    try {
      fs.rmSync(taskRootDir(id), { recursive: true, force: true });
    } catch (err) {
      console.warn(`  ! 删除任务目录 ${id.slice(0, 8)} 失败: ${(err as Error).message}`);
    }
  }

  for (const id of cleanupIds.uploads) {
    try {
      const up = await prisma.upload.findUnique({ where: { id } });
      if (up) fs.rmSync(path.join(config.uploadDir, up.storedName), { force: true });
    } catch (err) {
      console.warn(`  ! 删除上传文件 ${id.slice(0, 8)} 失败: ${(err as Error).message}`);
    }
  }

  // 再删数据库记录。用 deleteMany 一次性删，并打印实际删除条数，
  // 这样「插了 N 条只删掉 M 条」能立刻看出来，不会被静默吞掉。
  const t = await prisma.task.deleteMany({ where: { id: { in: cleanupIds.tasks } } });
  const u = await prisma.upload.deleteMany({ where: { id: { in: cleanupIds.uploads } } });

  console.log(
    `\n清理: 任务 ${t.count}/${cleanupIds.tasks.length}，上传 ${u.count}/${cleanupIds.uploads.length}`,
  );

  if (t.count !== cleanupIds.tasks.length || u.count !== cleanupIds.uploads.length) {
    console.warn('  ! 存在未清理的记录，请检查测试数据是否被其他进程改动');
  }
}

async function main(): Promise<void> {
  if (!SAMPLE || !fs.existsSync(SAMPLE)) {
    console.error(`短视频不存在: ${SAMPLE}`);
    console.error('用法: npx tsx scripts/worker-test.ts <短视频> <长视频> [每段秒数]');
    process.exit(1);
  }
  if (!LONG_SAMPLE || !fs.existsSync(LONG_SAMPLE)) {
    console.error(`长视频不存在: ${LONG_SAMPLE}（取消测试需要 ≥120 秒的视频）`);
    process.exit(1);
  }

  ensureStorageDirs();
  console.log(`短视频: ${SAMPLE}`);
  console.log(`长视频: ${LONG_SAMPLE}`);
  console.log(`每段秒数: ${SEGMENT_TIME}`);

  try {
    await testSuccess('fast');
    await testSuccess('precise');
    await testCancel();
    await testMissingSource();
    await testUndecodableInput();
    await testAlreadyCancelled();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('worker 测试异常:', err);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
