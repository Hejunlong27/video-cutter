import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../db';
import { config } from '../config';
import { probeDuration } from '../services/ffmpeg';
import { asyncHandler, badRequest, tooLarge } from '../utils/errors';
import { isAllowedExtension, isAllowedMime } from '../utils/validate';

const router = Router();

/**
 * 磁盘流式落盘：multer 边收边写，不会把 2GB 视频读进内存。
 * 文件名完全随机化（UUID），只保留白名单内的扩展名。
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    fields: 4,
  },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedExtension(file.originalname)) {
      cb(badRequest(`不支持的扩展名，仅允许：${config.allowedExtensions.join(', ')}`));
      return;
    }
    if (!isAllowedMime(file.mimetype)) {
      cb(badRequest(`不支持的 MIME 类型：${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

/**
 * POST /api/upload
 * form-data: file=<视频文件>
 * 返回: { fileId, originalName, size, duration }
 */
router.post(
  '/',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          next(
            tooLarge(
              `文件超过上限 ${(config.maxUploadBytes / 1024 / 1024).toFixed(0)}MB`,
            ),
          );
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('缺少文件字段 file');

    const id = crypto.randomUUID();
    const ext = path.extname(file.filename).replace('.', '');

    // ffprobe 失败不阻塞上传，duration 允许为 null
    const duration = await probeDuration(file.path);

    await prisma.upload.create({
      data: {
        id,
        originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        storedName: file.filename,
        ext,
        mimeType: file.mimetype,
        size: file.size,
        duration,
      },
    });

    res.status(201).json({
      fileId: id,
      originalName: file.originalname,
      size: file.size,
      duration,
    });
  }),
);

/** 上传配置（供前端展示限制） */
router.get('/limits', (_req, res) => {
  res.json({
    maxUploadBytes: config.maxUploadBytes,
    maxUploadMB: Math.round(config.maxUploadBytes / 1024 / 1024),
    allowedExtensions: config.allowedExtensions,
    defaultSegmentTime: config.defaultSegmentTime,
    maxConcurrency: config.maxConcurrency,
    retentionHours: config.retentionHours,
  });
});

/** 清理未被任何任务引用的上传（用户点了上传但没建任务） */
router.delete(
  '/:fileId',
  asyncHandler(async (req, res) => {
    const { fileId } = req.params;
    const record = await prisma.upload.findUnique({
      where: { id: fileId },
      include: { _count: { select: { tasks: true } } },
    });
    if (!record) {
      res.status(404).json({ error: '上传记录不存在' });
      return;
    }
    if (record._count.tasks > 0) {
      res.status(409).json({ error: '该文件已被任务引用，请删除任务' });
      return;
    }
    fs.rmSync(path.join(config.uploadDir, record.storedName), { force: true });
    await prisma.upload.delete({ where: { id: fileId } });
    res.json({ ok: true });
  }),
);

export default router;
