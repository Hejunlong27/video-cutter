import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = '资源不存在') => new HttpError(404, msg);
export const tooLarge = (msg: string) => new HttpError(413, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/** 异步路由包装，避免到处 try/catch */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  const e = err as Error & { status?: number; code?: string };

  if (e.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: '文件超出大小限制' });
    return;
  }

  const status = e.status ?? 500;
  if (status >= 500) {
    console.error('[api] 未处理异常:', e);
  }
  res.status(status).json({ error: e.message || '服务器内部错误' });
}
