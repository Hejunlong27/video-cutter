// 自己加载 .env，而不是依赖 config.ts 先被导入。
// 否则单独 import db.ts 时 DATABASE_URL 会缺失，Prisma 直接初始化失败。
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
});

export type TaskRecord = Awaited<ReturnType<typeof prisma.task.findFirst>>;
