# 视频切割器 · FFmpeg Segmenter

把 20–30 分钟的长视频按固定时长（默认 10 秒）自动切成多段，Web 上传、服务端 FFmpeg 切割、实时进度、打包 ZIP 下载。

- **前端**：React 18 + Vite + TypeScript + Tailwind CSS
- **后端**：Node.js 20 + Express + TypeScript
- **切割**：`child_process.spawn` 调用 FFmpeg（数组传参，无命令注入风险）
- **队列**：BullMQ + Redis
- **进度**：SSE（Server-Sent Events）
- **打包**：archiver（流式 ZIP）
- **存储**：SQLite + Prisma（元数据）+ 本地磁盘（文件，按任务 ID 隔离）

---

## 1. 项目结构

```
video-cutter/
├── package.json                # 根脚本：npm start / npm test / npm run doctor
├── start.cmd                   # ★ Windows 双击启动服务
├── test.cmd                    # ★ Windows 双击跑自验证测试
├── start.sh                    # macOS / Linux / Git Bash
├── docker-compose.yml          # 一键起 redis + server + web
├── .env.example
├── README.md
│
├── tools/
│   └── launcher.mjs            # 启动器：体检 / 起服务 / 跑测试 / 构建前端
│
├── server/                     # 后端
│   ├── Dockerfile              # 镜像内安装 ffmpeg
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   ├── prisma/
│   │   └── schema.prisma       # Upload / Task 两张表
│   ├── scripts/                # 自验证脚本（见第 8 节）
│   │   ├── smoke.ts            # FFmpeg 集成 + HTTP 路由
│   │   ├── sse-test.ts         # SSE 进度推送
│   │   ├── worker-test.ts      # 任务状态流转（成功/取消/失败）
│   │   └── e2e-test.ts         # 端到端（上传→切割→SSE→ZIP→删除）
│   └── src/
│       ├── index.ts            # 入口：API + 调度器同进程启动
│       ├── app.ts              # Express 装配
│       ├── config.ts           # 全部可调参数集中在这里
│       ├── db.ts               # PrismaClient 单例
│       ├── types.ts            # 共享类型 / 状态枚举
│       ├── dispatch/           # 任务调度层（两种驱动，见第 2.5 节）
│       │   ├── index.ts        # 工厂：按 QUEUE_DRIVER 选择，auto 会探测 Redis
│       │   ├── types.ts        # TaskDispatcher 接口
│       │   ├── bullmq.ts       # Redis 队列驱动（生产形态）
│       │   └── inline.ts       # 进程内驱动（零外部依赖）
│       ├── routes/
│       │   ├── upload.ts       # 流式上传、扩展名/MIME 校验
│       │   └── tasks.ts        # 任务 CRUD / SSE / ZIP / 单片下载
│       ├── services/
│       │   ├── ffmpeg.ts       # 命令构造 + stderr 进度解析 + 取消
│       │   ├── events.ts       # 进程内事件总线（SSE 数据源）
│       │   ├── registry.ts     # 运行中的 ffmpeg 句柄注册表
│       │   └── cleanup.ts      # 定时清理过期文件
│       ├── workers/
│       │   └── process-task.ts # 单个任务的完整业务逻辑（两种驱动共用）
│       └── utils/
│           ├── errors.ts       # HttpError + 统一错误中间件
│           └── validate.ts     # 路径穿越 / ID / 扩展名校验
│
└── web/                        # 前端
    ├── Dockerfile              # 多阶段：vite build → nginx
    ├── nginx.conf              # API 反代 + SSE 关闭缓冲 + SPA 回退
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx             # 路由 + 顶部导航
        ├── api.ts              # 接口封装（上传走 XHR 拿进度）
        ├── types.ts
        ├── hooks/
        │   └── useTaskStream.ts  # SSE 订阅 + 自动重连
        ├── components/
        │   ├── Uploader.tsx      # 拖拽 / 点击上传 + 进度 + 取消
        │   ├── ProgressBar.tsx   # 进度条 + 已处理秒数
        │   ├── SegmentList.tsx   # 片段列表 + 预览 + 单个下载
        │   └── StatusBadge.tsx
        └── pages/
            ├── Home.tsx          # 上传 + 参数 + 创建任务
            ├── TaskDetail.tsx    # 实时进度 + 片段 + 下载 + 取消
            └── TaskListPage.tsx  # 历史任务列表
```

---

## 2. 本地运行

### 2.1 最快方式：启动器（推荐）

**Windows：双击 `start.cmd`。** 首次运行会自动装依赖、初始化数据库，然后起服务并打开浏览器。

其他平台：

```bash
./start.sh              # macOS / Linux / Git Bash
npm start               # 等价
```

启动器会自动做完这些事，你不用手动敲命令：

| 步骤 | 说明 |
| --- | --- |
| 环境体检 | 检查 Node / npm / ffmpeg / ffprobe，缺什么直接告诉你 |
| 生成配置 | `server/.env` 不存在时自动从 `.env.example` 复制 |
| 安装依赖 | `server/` 和 `web/` 缺 `node_modules` 时自动 `npm install` |
| 初始化数据库 | `prisma generate` + `prisma db push` |
| 端口检查 | 4000 / 5173 被占用时给出明确提示，不会莫名失败 |
| 起服务 | 后端 + 前端并行启动，日志分别带 `[api]` / `[web]` 前缀 |
| 打开浏览器 | 后端健康检查通过后自动打开 http://127.0.0.1:5173 |

> **Redis 不是必需的。** 探测不到 Redis 会自动降级为进程内调度，功能完全一样，
> 只是任务不能跨进程、重启会丢排队中的任务。装了 Redis 也不用改配置，下次启动自动用上。

其他命令：

```bash
node tools/launcher.mjs doctor   # 只做环境体检，不启动服务
node tools/launcher.mjs test     # 跑全部自验证脚本（自动合成测试素材）
node tools/launcher.mjs build    # 构建前端生产包
node tools/launcher.mjs help     # 查看全部命令与环境变量
```

Windows 上双击 `test.cmd` 等价于跑测试。

启动器默认把后端绑到 `127.0.0.1`（不是 `0.0.0.0`）—— 本项目没有鉴权，
绑全网卡会让同网段的人也能上传/删除。要让局域网访问：`set HOST=0.0.0.0` 后再启动。

### 2.2 两种调度驱动（`QUEUE_DRIVER`）

| 值 | 行为 | 适用 |
| --- | --- | --- |
| `auto`（默认） | 探测到 Redis 就用 BullMQ，否则用进程内调度 | 所有场景 |
| `redis` | 强制 BullMQ + Redis，连不上直接启动失败 | 生产 |
| `inline` | 强制进程内调度，完全不碰 Redis | 本地试用、CI |

两种驱动共用同一份业务逻辑（`workers/process-task.ts`），行为一致。
`GET /api/health` 会返回当前实际使用的 `driver` 字段。

**什么时候才需要 Redis：** 想把 worker 拆成独立容器横向扩容，或者要求排队中的任务在重启后不丢。
单机自用的话 `inline` 完全够。

### 2.3 手动运行（可选）

不想用启动器的话，按下面手动来。

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | |
| FFmpeg | ≥ 5 | 需 `ffmpeg` 与 `ffprobe` 都在 PATH 中 |
| Redis | ≥ 6 | **可选**，不装则自动走进程内调度 |

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt install -y ffmpeg

# Windows（winget）
winget install Gyan.FFmpeg
```

**后端：**

```bash
cd server
cp .env.example .env
npm install
npx prisma generate
npx prisma db push          # 建 SQLite 表
npm run dev                 # http://127.0.0.1:4000
```

健康检查：

```bash
curl http://127.0.0.1:4000/api/health
# {"ok":true,"driver":"inline","ffmpeg":"ffmpeg","maxConcurrency":2,...}
```

**前端：**

```bash
cd web
npm install
npm run dev                 # http://127.0.0.1:5173
```

Vite 已把 `/api` 代理到 `http://127.0.0.1:4000`，SSE 也走同一条代理，无需额外配置。

### 2.4 跑一遍

1. 打开 http://127.0.0.1:5173
2. 拖入一个视频 → 等上传完成
3. 选每段时长（默认 10s）、选模式
4. 点「开始切割」→ 自动跳详情页看实时进度
5. 完成后点「打包下载 ZIP」，或在片段列表里单段下载 / 预览

---

## 3. Docker 运行

```bash
cd video-cutter
cp .env.example .env
docker compose up -d --build
```

打开 http://localhost:8080

```bash
docker compose logs -f server     # 看后端日志
docker compose down               # 停止（./data 保留）
docker compose down -v            # 连 redis 数据一起清掉
```

**数据持久化**：`./data` 挂载到容器 `/data`，里面是 `uploads/`（源文件）、`tasks/`（片段与输出）、`app.db`（SQLite）。删容器不丢文件。

**镜像内容**：server 镜像基于 `node:20-bookworm-slim`，构建时 `apt install ffmpeg`，所以宿主机不需要装 FFmpeg。

---

## 4. 调参速查

所有参数集中在 `server/src/config.ts`，通过环境变量覆盖。改完重启服务生效（Docker 下 `docker compose up -d`）。

| 需求 | 环境变量 | 默认 | 备注 |
| --- | --- | --- | --- |
| **片段时长** | `DEFAULT_SEGMENT_TIME` | `10` | 只影响新建任务表单的默认值。每个任务的实际时长在创建时通过 `segmentTime` 传入，前端可改（1–3600s）。想彻底锁死默认值改这里。 |
| **并发任务数** | `MAX_CONCURRENCY` | `2` | 同时跑几个 ffmpeg。CPU 核心数的 1/2 比较稳妥；精确模式吃 CPU，建议不超过 2。两种驱动都受这个值控制。 |
| **上传大小上限** | `MAX_UPLOAD_MB` | `2048` | 后端 multer 限制。**同时要改 `web/nginx.conf` 里的 `client_max_body_size`**（已设为 2048m），否则 nginx 会先返回 413。 |
| **文件保留时长** | `RETENTION_HOURS` | `24` | 任务进入终态后多久被清理。 |
| **清理扫描间隔** | `CLEANUP_INTERVAL_MINUTES` | `30` | 定时任务频率。 |
| **FFmpeg 超时** | `FFMPEG_TIMEOUT_MINUTES` | `60` | 超时 kill 进程并标 failed。 |
| **允许的扩展名** | `ALLOWED_EXTENSIONS` | `mp4,mov,...` | 逗号分隔，同时用于前端 accept。 |
| **队列排队上限** | 代码内 `config.maxConcurrency * 5` | `10` | 见 `routes/tasks.ts` 的并发闸门，超出返回 409。 |
| **存储根目录** | `STORAGE_ROOT` | `./storage` / `/data` | |
| **FFmpeg 路径** | `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | 非 PATH 环境填绝对路径。 |
| **调度驱动** | `QUEUE_DRIVER` | `auto` | `auto` / `redis` / `inline`，见 2.2 节。 |
| **后端监听地址** | `HOST` | `0.0.0.0` | 启动器会覆盖为 `127.0.0.1`。无鉴权，别轻易开全网卡。 |
| **后端 / 前端端口** | `PORT` / `WEB_PORT` | `4000` / `5173` | 端口冲突时改这两个，启动器会自动读取。 |

前端还有个可调项：`web/src/pages/Home.tsx` 的 `PRESET_TIMES`（快捷时长按钮）。

---

## 5. 两种切割模式

### 快速无损（`mode: "fast"`）

```bash
ffmpeg -i input.mp4 -c copy -map 0 -f segment \
  -segment_time 10 -reset_timestamps 1 -segment_format mp4 part_%03d.mp4
```

| | |
| --- | --- |
| **优点** | 极快（20 分钟视频通常 5–20 秒完成）；画质零损失；CPU 占用低 |
| **缺点** | 片段边界只能落在**关键帧**上，实际时长会偏离设定值 |
| **实测偏差** | 常见 ±1~3 秒；源视频 GOP 越大偏差越大（如 GOP=250 时 10 秒段可能变成 8 秒或 12 秒） |
| **适用** | 只是要"大致按 10 秒切开"、后续还要再剪辑；或对速度敏感、对边界不敏感 |

⚠️ 关键帧间隔不一致时，**首段和末段偏差最明显**。UI 里对 fast 模式有黄色提示。

### 精确重编码（`mode: "precise"`）

```bash
ffmpeg -i input.mp4 -c:v libx264 -preset veryfast -crf 18 \
  -c:a aac -b:a 192k -map 0 -f segment \
  -segment_time 10 -reset_timestamps 1 \
  -force_key_frames "expr:gte(t,n_forced*10)" -segment_format mp4 part_%03d.mp4
```

| | |
| --- | --- |
| **优点** | `-force_key_frames` 强制在每个 10s 边界插关键帧，片段时长严格贴合设定值 |
| **缺点** | 需要完整解码 + 重编码，耗时约为视频时长的 **0.5~1.5 倍**；画质有轻微损失（CRF 18 基本肉眼无损）；CPU 占用高 |
| **适用** | 片段要直接投放到平台、要求严格等长；或下游系统对时长敏感 |

### 注意事项

- **精确模式音画不同步**：极少数源文件（VFR 可变帧率、时间戳异常）重编码后可能出现音画偏移。遇到时加 `-vsync cfr -r 30` 强制恒定帧率。
- **精确模式的时长估算**：UI 显示的进度百分比按 `time=` / 总时长算，重编码时 `time=` 推进速度与实时时间不成正比，进度条会显得"慢"但这是正常的。
- **快速模式的片段数会多于预期**：因为每段略短，总段数可能比 `总时长 / 10` 多几段。
- **`-reset_timestamps 1`** 让每段从 0 开始计时，否则播放器上后段会显示错误的时间轴。
- **音频**：fast 模式音频也是流拷贝；如果源音频是 AC3/DTS 而目标容器是 mp4，部分播放器可能不兼容，此时用 precise 模式（会转 AAC）。

---

## 6. API

Base: `http://localhost:4000/api`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/upload/limits` | 返回上传限制、默认时长、并发数、保留时长 |
| `POST` | `/upload` | `form-data: file=<视频>` → `{ fileId, originalName, size, duration }` |
| `DELETE` | `/upload/:fileId` | 删除未被任务引用的上传 |
| `POST` | `/tasks` | `{ fileId, segmentTime?, mode?, outputFormat? }` → `{ task }` |
| `GET` | `/tasks?limit=&status=` | 任务列表 |
| `GET` | `/tasks/:id` | 任务详情 + 片段列表 |
| `GET` | `/tasks/:id/events` | **SSE** 实时进度 |
| `GET` | `/tasks/:id/segments` | 片段列表 |
| `GET` | `/tasks/:id/segments/:name` | 单片段播放（`?download=1` 变下载） |
| `GET` | `/tasks/:id/download` | 打包 ZIP（`segments_<taskId>.zip`） |
| `POST` | `/tasks/:id/cancel` | 取消任务（kill ffmpeg 或从队列摘除） |
| `DELETE` | `/tasks/:id` | 删除任务及全部文件 |

**任务状态**：`pending` → `uploading` → `queued` → `processing` → `completed` / `failed` / `cancelled`

**SSE 事件格式**（`event: progress`）：

```json
{
  "taskId": "8f3c...",
  "status": "processing",
  "progress": 45,
  "processedSeconds": 270,
  "totalSeconds": 600,
  "segments": 27,
  "message": "正在切割...",
  "error": null
}
```

进入终态后额外发一次 `event: done`，然后服务端主动关闭连接。

---

## 7. 安全与稳定性设计

| 措施 | 实现位置 |
| --- | --- |
| **防命令注入** | `spawn(ffmpeg, args[])` 数组传参，全程不拼字符串（`services/ffmpeg.ts`） |
| **防路径穿越** | 上传文件名随机化为 UUID；片段名白名单正则 `^part_\d{3,6}\.mp4$`；下载前二次校验解析路径仍在任务目录内（`routes/tasks.ts`） |
| **MIME + 扩展名双校验** | `utils/validate.ts` + multer `fileFilter` |
| **流式上传** | multer `diskStorage` 边收边写，2GB 文件不占内存 |
| **上传大小限制** | multer `limits.fileSize` + nginx `client_max_body_size` |
| **并发限制** | BullMQ Worker `concurrency`；创建任务前检查"排队+处理中"总数，超限返回 409 |
| **任务隔离** | 每个任务独立目录 `tasks/<taskId>/segments/`，删除任务整目录清理 |
| **取消任务** | 处理中 → `kill('SIGKILL')` 终止 ffmpeg；排队中 → 从 BullMQ 移除 job |
| **超时保护** | `FFMPEG_TIMEOUT_MINUTES` 到点强杀并标 `failed` |
| **错误提示** | 从 stderr 提炼关键行（error/invalid/failed/no such...）写入 `task.error`，前端展示 |
| **自动清理** | 定时清理终态超期任务 + 孤儿上传文件（`services/cleanup.ts`） |

**已知边界**（生产环境建议补）：

- 当前无鉴权，任何能访问端口的人都能上传/删除。启动器已默认把后端绑到 `127.0.0.1`；生产请加一层反向代理认证或接入 JWT。
- 进程内 EventEmitter 做 SSE 广播，所以 **API 与调度器必须同进程**（当前架构如此）。若要横向扩容成多容器，把 `services/events.ts` 换成 Redis pub/sub。
- `inline` 驱动下排队中的任务存在进程内存里，重启会丢。要持久化排队请用 `QUEUE_DRIVER=redis`。
- 磁盘写满时 FFmpeg 会报错退出，错误信息会回传到 UI，但没有提前的容量预警。建议加磁盘水位监控。

---

## 8. 自验证脚本

项目自带四个脚本，用真实 FFmpeg 和真实 HTTP 请求做断言（不是 mock），**全程不需要 Redis**。

**一键跑全部：**

```bash
node tools/launcher.mjs test     # 或 Windows 双击 test.cmd
```

启动器会自动合成测试素材、依次跑四个套件、最后给出汇总。

**单独跑某个：**

```bash
cd server

# 1) FFmpeg 集成 + HTTP 路由 —— 19 项断言
npx tsx scripts/smoke.ts <视频路径> [每段秒数]

# 2) SSE 进度推送 —— 9 项断言
npx tsx scripts/sse-test.ts

# 3) 任务状态流转（成功 / 取消 / 失败）—— 36 项断言
#    第二个参数需要 ≥120 秒的视频，用于取消测试
npx tsx scripts/worker-test.ts <短视频> <长视频> [每段秒数]

# 4) 端到端：上传→切割→SSE→片段→ZIP→删除 —— 29 项断言
npx tsx scripts/e2e-test.ts <视频路径> [每段秒数]
```

没有现成素材的话，用 ffmpeg 合成两个：

```bash
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=duration=30:size=320x240:rate=25" \
  -f lavfi -i "sine=frequency=440:duration=30" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k -shortest sample.mp4

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=duration=240:size=320x240:rate=15" \
  -f lavfi -i "sine=frequency=440:duration=240" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k -shortest long.mp4
```

### 覆盖范围

| 脚本 | 覆盖内容 |
| --- | --- |
| `smoke.ts` | ffprobe 读时长、fast/precise 切割产物与时长偏差、进度回调到 100、流式上传、拒绝 `.sh` 扩展名、拒绝路径穿越 ID、404 处理、文件清理 |
| `sse-test.ts` | `text/event-stream` 响应头、`X-Accel-Buffering: no`、连接即补发当前状态、实时进度帧、终态发 `done` 后自动断连 |
| `worker-test.ts` | `queued→processing→completed` 流转、DB 与磁盘片段数一致、事件序列、`startedAt/finishedAt` 写入、**取消时真的 kill 掉 ffmpeg 进程**、源文件缺失、输入不可解码（错误取自 ffmpeg stderr）、已取消任务不重复执行 |
| `e2e-test.ts` | 走完整 HTTP 链路（进程内调度）：上传 → 建任务 → SSE 跑到终态 → 片段列表 → 单片段下载（校验字节数与列表一致）→ 打包 ZIP（校验 PK 魔数与内含条目）→ 取消 → 删除任务（校验磁盘目录已清除）→ 数据库无残留 |

### 为什么能脱离 Redis 测

`dispatch/` 只负责「把任务送到处理函数」，业务逻辑全在 `workers/process-task.ts`，
入参是 `{ data: { taskId } }` 这样的最小结构。所以：

- `worker-test.ts` 直接 `processCutJob({ data: { taskId } })` 驱动，验证状态流转
- `e2e-test.ts` 用 `InlineDispatcher` 替换调度器，走真实 HTTP 走完整用户路径

唯一没被自动化覆盖的是「BullMQ 从 Redis 取出任务并调用 `processCutJob`」这一跳 ——
它由 BullMQ 自身保证。起 Redis 后可端到端确认：

```bash
docker compose up -d
# 打开 http://localhost:8080 传个视频，观察进度条与片段列表
```

---

## 9. 常见问题

**Q: 一定要装 Redis 吗？**
不用。默认 `QUEUE_DRIVER=auto`，探测不到 Redis 会自动用进程内调度，功能完全一样。
只是排队中的任务在重启后会丢。想让队列持久化再装 Redis，装完不用改配置。

**Q: 启动器提示端口被占用？**
换端口即可，启动器会自动读取：`set PORT=4001 && set WEB_PORT=5174 && node tools/launcher.mjs dev`。
或者用 `netstat -ano | findstr :4000` 找到占用进程再处理。

**Q: 双击 `start.cmd` 一闪而过？**
说明 Node 没装或不在 PATH。窗口里会有 `[ERROR] Node.js not found` 提示并等待按键，
如果连这个都看不到，就在 cmd 里手动跑一次 `node tools/launcher.mjs doctor` 看详细输出。

**Q: 任务一直排队不动？**
如果 `QUEUE_DRIVER=redis`，是 Redis 没起来或 `REDIS_URL` 配错，看日志里的 `[worker] error`。
如果是 `inline`，看日志里的 `[inline] 任务 ... 执行异常`。

**Q: 上传大文件时 nginx 返回 413？**
改 `web/nginx.conf` 的 `client_max_body_size`，和后端 `MAX_UPLOAD_MB` 保持一致。

**Q: 进度条一直 0%，直到完成才跳 100%？**
FFmpeg 输出被缓冲了。确认 nginx 的 `/api/` location 里有 `proxy_buffering off;`，以及响应头带 `X-Accel-Buffering: no`（后端已设置）。

**Q: 报 "无法启动 FFmpeg"？**
宿主机没装 ffmpeg 或不在 PATH。本地开发用 `FFMPEG_PATH=/usr/local/bin/ffmpeg` 指定绝对路径；Docker 部署不会遇到。

**Q: 片段时长不是 10 秒？**
用了快速模式。见第 5 节，改用精确重编码。

**Q: Windows 下删任务报文件被占用？**
删除前已取消 ffmpeg 并等待 400ms 让句柄释放。若仍失败，通常是资源管理器正在预览该文件，关掉即可。
