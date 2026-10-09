#!/usr/bin/env node
/**
 * 一键启动器 —— 环境体检 / 起服务 / 跑测试 / 构建前端
 *
 *   node tools/launcher.mjs dev      启动后端 + 前端（默认）
 *   node tools/launcher.mjs test     跑全部自验证脚本（自动合成测试素材）
 *   node tools/launcher.mjs doctor   环境体检
 *   node tools/launcher.mjs build    构建前端生产包
 *
 * 设计要点：
 * - 全程用 node 直接跑本地 CLI（node_modules/xxx），不经过 shell，跨平台稳定
 * - 没有 Redis 也能起：后端会自动降级为进程内调度
 * - Ctrl+C 统一收尾，不会留下孤儿进程
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 路径与常量

// 控制台窗口标题（Windows 上 process.title 会写进标题栏）
try {
  process.title = '视频切割器';
} catch {
  /* 某些环境不允许改标题，忽略 */
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const WEB = path.join(ROOT, 'web');
const TMP = path.join(ROOT, '.tmp-test');

const API_PORT = Number(process.env.PORT || 4000);
const WEB_PORT = Number(process.env.WEB_PORT || 5173);
const HEALTH_URL = `http://127.0.0.1:${API_PORT}/api/health`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

const CLI = {
  tsx: path.join(SERVER, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  vite: path.join(WEB, 'node_modules', 'vite', 'bin', 'vite.js'),
  prisma: path.join(SERVER, 'node_modules', 'prisma', 'build', 'index.js'),
};

// ---------------------------------------------------------------- 输出样式
// Windows 原生 cmd 不认 ANSI 转义，会显示成乱码，所以只在能识别颜色的终端里上色
const COLOR =
  !process.env.NO_COLOR &&
  (process.platform !== 'win32' ||
    !!process.env.WT_SESSION ||
    !!process.env.TERM_PROGRAM ||
    process.env.ConEmuANSI === 'ON' ||
    !!process.env.ANSICON);

const esc = (code) => (COLOR ? `\x1b[${code}m` : '');
const C = {
  reset: COLOR ? '\x1b[0m' : '',
  bold: esc('1'),
  dim: esc('2'),
  red: esc('31'),
  green: esc('32'),
  yellow: esc('33'),
  blue: esc('34'),
  magenta: esc('35'),
  cyan: esc('36'),
};

/** 给一段文本上色 —— 用于子进程日志前缀 */
const paint = (code) => (s) => `${esc(code)}${s}${C.reset}`;

const banner = (text) => console.log(`\n${C.bold}${C.cyan}${text}${C.reset}`);
const step = (text) => console.log(`\n${C.blue}▸${C.reset} ${C.bold}${text}${C.reset}`);
const ok = (text) => console.log(`  ${C.green}✓${C.reset} ${text}`);
const warn = (text) => console.log(`  ${C.yellow}!${C.reset} ${text}`);
const bad = (text) => console.log(`  ${C.red}✗${C.reset} ${text}`);
const info = (text) => console.log(`  ${C.dim}${text}${C.reset}`);

// ---------------------------------------------------------------- 基础工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exists(p) {
  return fs.existsSync(p);
}

/**
 * 命令是否可用。
 * 直接跑一次「版本查询」比 where/which 更可靠（Windows 上 where 的解析结果不稳定）。
 */
function hasCommand(cmd, versionFlag = '--version') {
  const run = (useShell) => {
    try {
      const r = spawnSync(cmd, [versionFlag], {
        stdio: 'ignore',
        timeout: 8000,
        shell: useShell,
      });
      return r.status === 0;
    } catch {
      return false;
    }
  };

  if (run(false)) return true;
  // Windows 上 npm / npx 是 .cmd 包装脚本，必须经 shell 才能启动
  return process.platform === 'win32' ? run(true) : false;
}

/** 端口是否空闲 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 轮询健康检查，返回响应体或 null */
async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(400);
  }
  return null;
}

/** 用 node 跑本地 CLI；缺文件时回退到 npx */
function resolveRunner(kind) {
  const local = CLI[kind];
  if (exists(local)) return { command: process.execPath, prefix: [local] };
  return { command: 'npx', prefix: [kind], shell: true };
}

// ---------------------------------------------------------------- 子进程管理

const children = [];
let shuttingDown = false;

/** 带前缀转发子进程输出 */
function pipeWithPrefix(child, label, colorize) {
  const handle = (stream, isErr) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim() === '') continue;
        const tag = colorize(`[${label}]`);
        if (isErr) process.stderr.write(`${tag} ${line}\n`);
        else process.stdout.write(`${tag} ${line}\n`);
      }
    });
  };
  if (child.stdout) handle(child.stdout, false);
  if (child.stderr) handle(child.stderr, true);
}

function startChild(label, kind, args, cwd, colorize, envExtra = {}) {
  const runner = resolveRunner(kind);
  const child = spawn(runner.command, [...runner.prefix, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: runner.shell === true,
    env: { ...process.env, FORCE_COLOR: COLOR ? '1' : '0', ...envExtra },
  });

  child.on('error', (err) => bad(`${label} 启动失败: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0 && code !== null) {
      bad(`${label} 已退出（退出码 ${code}${signal ? `, 信号 ${signal}` : ''}）`);
    }
  });

  pipeWithPrefix(child, label, colorize);
  children.push({ label, child });
  return child;
}

/** 结束子进程（Windows 需要 taskkill 才能连子进程一起收拾） */
function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* 已经退出了 */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${C.dim}正在停止...${C.reset}`);
  for (const { child } of children) killChild(child);
  setTimeout(() => process.exit(code), 300);
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? { c: 'explorer.exe', a: [url] }
      : process.platform === 'darwin'
        ? { c: 'open', a: [url] }
        : { c: 'xdg-open', a: [url] };
  try {
    spawn(cmd.c, cmd.a, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了，地址已经打印出来了 */
  }
}

// ---------------------------------------------------------------- 前置准备

function ensureEnvFile() {
  const env = path.join(SERVER, '.env');
  const example = path.join(SERVER, '.env.example');
  if (!exists(env) && exists(example)) {
    fs.copyFileSync(example, env);
    ok('已生成 server/.env（复制自 .env.example）');
  }
}

function ensureDeps(dir, label) {
  if (exists(path.join(dir, 'node_modules'))) return true;
  warn(`${label} 依赖未安装，正在执行 npm install（首次会比较慢）...`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    bad(`${label} 依赖安装失败`);
    return false;
  }
  ok(`${label} 依赖安装完成`);
  return true;
}

function ensurePrisma() {
  if (!exists(CLI.prisma)) {
    bad('未找到 prisma CLI，请先在 server/ 执行 npm install');
    return false;
  }

  const generate = spawnSync(process.execPath, [CLI.prisma, 'generate'], {
    cwd: SERVER,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (generate.status !== 0) {
    bad('prisma generate 失败');
    console.log(generate.stderr?.slice(-500) ?? '');
    return false;
  }
  ok('Prisma Client 已生成');

  const push = spawnSync(
    process.execPath,
    [CLI.prisma, 'db', 'push', '--skip-generate'],
    { cwd: SERVER, stdio: 'pipe', encoding: 'utf8' },
  );
  if (push.status !== 0) {
    bad('数据库初始化失败（prisma db push）');
    console.log(push.stderr?.slice(-500) ?? '');
    return false;
  }
  ok('SQLite 数据库已就绪');
  return true;
}

function ensureTestAssets() {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

  const sample = path.join(TMP, 'sample.mp4');
  const long = path.join(TMP, 'long.mp4');

  const make = (file, seconds, rate, label) => {
    if (exists(file)) {
      info(`${label} 已存在，跳过合成`);
      return true;
    }
    process.stdout.write(`  合成 ${label}（${seconds}s 测试视频）...`);
    const r = spawnSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=${rate}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '64k', '-shortest',
        file,
      ],
      { stdio: 'ignore' },
    );
    process.stdout.write(r.status === 0 ? ' 完成\n' : ' 失败\n');
    return r.status === 0;
  };

  const a = make(sample, 30, 25, 'sample.mp4');
  const b = make(long, 240, 15, 'long.mp4');
  return a && b ? { sample, long } : null;
}

// ---------------------------------------------------------------- 命令实现

function cmdDoctor() {
  banner('环境体检');

  let fatal = 0;
  let warnings = 0;

  step('运行时');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`Node.js ${process.version}`);
  else {
    bad(`Node.js ${process.version} 版本过低（需要 ≥ 18）`);
    fatal += 1;
  }
  if (hasCommand('npm')) ok('npm 可用');
  else {
    bad('未找到 npm');
    fatal += 1;
  }

  step('FFmpeg');
  if (hasCommand('ffmpeg', '-version')) ok('ffmpeg 可用');
  else {
    bad('未找到 ffmpeg（切割功能必需）—— Windows: winget install Gyan.FFmpeg');
    fatal += 1;
  }
  if (hasCommand('ffprobe', '-version')) ok('ffprobe 可用');
  else {
    bad('未找到 ffprobe（读取视频时长必需，通常与 ffmpeg 一起安装）');
    fatal += 1;
  }

  step('依赖与配置');
  if (exists(path.join(SERVER, 'node_modules'))) ok('server 依赖已安装');
  else {
    warn('server 依赖未安装（启动时会自动 npm install）');
    warnings += 1;
  }
  if (exists(path.join(WEB, 'node_modules'))) ok('web 依赖已安装');
  else {
    warn('web 依赖未安装（启动时会自动 npm install）');
    warnings += 1;
  }
  if (exists(path.join(SERVER, '.env'))) ok('server/.env 存在');
  else {
    warn('server/.env 不存在（启动时会自动从 .env.example 生成）');
    warnings += 1;
  }
  if (exists(path.join(SERVER, 'prisma', 'dev.db'))) ok('SQLite 数据库已初始化');
  else {
    warn('SQLite 未初始化（启动时会自动 prisma db push）');
    warnings += 1;
  }

  step('端口');
  return (async () => {
    for (const [port, name] of [
      [API_PORT, '后端'],
      [WEB_PORT, '前端'],
    ]) {
      if (await isPortFree(port)) ok(`${port}（${name}）空闲`);
      else {
        warn(`${port}（${name}）已被占用 —— 换端口：set PORT=4001 && node tools/launcher.mjs dev`);
        warnings += 1;
      }
    }

    step('Redis（可选）');
    const redisOk = await isPortFree(6379).then((free) => !free);
    if (redisOk) ok('6379 有服务在监听，将使用 BullMQ 队列模式');
    else {
      info('未检测到 Redis —— 后端会自动降级为进程内调度，功能完全可用');
      info('要启用队列：装 Redis 后重跑本命令即可，无需改配置');
    }

    banner(fatal === 0 ? '体检通过，可以启动' : '存在阻塞问题');
    if (fatal > 0) console.log(`  ${C.red}${fatal} 个致命问题需要先解决${C.reset}`);
    else if (warnings > 0) console.log(`  ${C.yellow}${warnings} 项提示（不影响启动）${C.reset}`);
    else console.log(`  ${C.green}一切就绪${C.reset}`);

    return fatal === 0 ? 0 : 1;
  })();
}

async function cmdDev() {
  banner('启动视频切割器');

  // 1) 前置准备
  step('准备环境');
  ensureEnvFile();
  if (!ensureDeps(SERVER, 'server')) return 1;
  if (!ensureDeps(WEB, 'web')) return 1;
  if (!ensurePrisma()) return 1;

  // 2) 端口检查
  step('检查端口');
  for (const [port, name] of [
    [API_PORT, '后端'],
    [WEB_PORT, '前端'],
  ]) {
    if (!(await isPortFree(port))) {
      bad(`${port}（${name}）已被占用。请先关掉占用进程，或换个端口：`);
      info(`set PORT=4001 && set WEB_PORT=5174 && node tools/launcher.mjs dev`);
      return 1;
    }
    ok(`${port}（${name}）可用`);
  }

  // 3) 起后端
  step('启动后端');
  // 默认只监听回环：本项目没有鉴权，绑 0.0.0.0 会让同网段的人也能上传/删除
  const apiHost = process.env.HOST || '127.0.0.1';
  startChild('api', 'tsx', ['watch', 'src/index.ts'], SERVER, paint('35'), {
    HOST: apiHost,
  });
  info(`等待 ${HEALTH_URL} 就绪...`);

  const health = await waitForHealth(60000);
  if (!health) {
    bad('后端启动超时。请查看上方 [api] 日志定位问题。');
    shutdown(1);
    return 1;
  }
  ok(`后端就绪（调度驱动: ${C.bold}${health.driver}${C.reset}）`);
  if (health.driver === 'inline') {
    info('进程内调度：排队中的任务在重启后会丢失；生产建议配置 Redis');
  }

  // 4) 起前端
  step('启动前端');
  // 显式绑 127.0.0.1：vite 默认只绑 localhost，某些系统上会解析到 IPv6，
  // 导致打印出来的 127.0.0.1 地址反而连不上
  startChild(
    'web',
    'vite',
    ['--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
    WEB,
    paint('34'),
  );
  await sleep(2500);
  ok(`前端已启动`);

  // 5) 打开浏览器
  banner('可以用了');
  console.log(`  ${C.bold}打开：${C.cyan}${WEB_URL}${C.reset}`);
  console.log(`  ${C.dim}后端接口：http://127.0.0.1:${API_PORT}/api/health${C.reset}`);
  console.log(`  ${C.dim}按 Ctrl+C 停止全部服务${C.reset}\n`);

  if (process.env.NO_OPEN !== '1') openBrowser(WEB_URL);

  // 6) 等待退出
  return new Promise((resolve) => {
    const onSignal = () => {
      shutdown(0);
      resolve(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

function cmdTest() {
  banner('运行自验证脚本');

  step('准备环境');
  if (!ensureDeps(SERVER, 'server')) return 1;
  if (!ensurePrisma()) return 1;
  if (!hasCommand('ffmpeg', '-version')) {
    bad('未找到 ffmpeg，无法运行测试');
    return 1;
  }

  step('准备测试素材');
  const assets = ensureTestAssets();
  if (!assets) {
    bad('测试素材合成失败');
    return 1;
  }

  const suites = [
    {
      name: 'FFmpeg 集成 + HTTP 路由',
      args: ['scripts/smoke.ts', assets.sample, '10'],
    },
    { name: 'SSE 进度推送', args: ['scripts/sse-test.ts'] },
    {
      name: '任务状态流转（成功/取消/失败）',
      args: ['scripts/worker-test.ts', assets.sample, assets.long, '10'],
    },
    {
      name: '端到端（上传→切割→SSE→ZIP→删除）',
      args: ['scripts/e2e-test.ts', assets.sample, '10'],
    },
  ];

  const results = [];
  for (const suite of suites) {
    step(suite.name);
    const r = spawnSync(process.execPath, [CLI.tsx, ...suite.args], {
      cwd: SERVER,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: COLOR ? '1' : '0' },
    });
    results.push({ name: suite.name, ok: r.status === 0 });
  }

  banner('测试汇总');
  for (const r of results) {
    if (r.ok) ok(r.name);
    else bad(r.name);
  }
  const failedCount = results.filter((r) => !r.ok).length;
  if (failedCount === 0) {
    console.log(`\n  ${C.green}${C.bold}全部通过${C.reset}\n`);
    return 0;
  }
  console.log(`\n  ${C.red}${C.bold}${failedCount} 个套件失败${C.reset}\n`);
  return 1;
}

function cmdBuild() {
  banner('构建前端');
  if (!ensureDeps(WEB, 'web')) return 1;

  step('类型检查 + 打包');
  const r = spawnSync(process.execPath, [CLI.vite, 'build'], {
    cwd: WEB,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: COLOR ? '1' : '0' },
  });
  if (r.status !== 0) {
    bad('构建失败');
    return 1;
  }
  ok(`产物目录：${path.join(WEB, 'dist')}`);
  return 0;
}

function cmdHelp() {
  banner('视频切割器 · 启动器');
  console.log(`
  ${C.bold}用法${C.reset}
    node tools/launcher.mjs <命令>

  ${C.bold}命令${C.reset}
    ${C.cyan}dev${C.reset}      启动后端 + 前端，并自动打开浏览器（默认）
    ${C.cyan}test${C.reset}     跑全部自验证脚本（自动合成测试素材）
    ${C.cyan}doctor${C.reset}   环境体检：Node / FFmpeg / 依赖 / 端口 / Redis
    ${C.cyan}build${C.reset}    构建前端生产包
    ${C.cyan}help${C.reset}     显示本帮助

  ${C.bold}常用环境变量${C.reset}
    PORT=4000           后端端口
    WEB_PORT=5173       前端端口
    QUEUE_DRIVER=auto   auto | redis | inline（auto 会自动探测 Redis）
    NO_OPEN=1           启动后不自动打开浏览器
    NO_COLOR=1          关闭彩色输出
`);
  return 0;
}

// ---------------------------------------------------------------- 入口

const COMMANDS = {
  dev: cmdDev,
  test: cmdTest,
  doctor: cmdDoctor,
  build: cmdBuild,
  help: cmdHelp,
};

async function main() {
  const argv = process.argv.slice(2);
  const name = (argv[0] || 'dev').toLowerCase();

  if (name === '--help' || name === '-h') return cmdHelp();

  const handler = COMMANDS[name];
  if (!handler) {
    bad(`未知命令: ${name}`);
    cmdHelp();
    return 1;
  }

  return await handler();
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\n${C.red}启动器异常:${C.reset}`, err);
    process.exitCode = 1;
  });
