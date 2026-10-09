import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config';
import { getDispatcher } from './dispatch';
import uploadRouter from './routes/upload';
import tasksRouter from './routes/tasks';
import { errorHandler } from './utils/errors';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('tiny'));

  app.get('/api/health', async (_req, res) => {
    const dispatcher = getDispatcher();
    const stats = await dispatcher.stats().catch(() => ({ pending: 0, active: 0 }));

    res.json({
      ok: true,
      driver: dispatcher.driver,
      pending: stats.pending,
      active: stats.active,
      ffmpeg: config.ffmpegPath,
      maxConcurrency: config.maxConcurrency,
      maxUploadMB: Math.round(config.maxUploadBytes / 1024 / 1024),
      retentionHours: config.retentionHours,
      time: new Date().toISOString(),
    });
  });

  app.use('/api/upload', uploadRouter);
  app.use('/api/tasks', tasksRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use(errorHandler);
  return app;
}
