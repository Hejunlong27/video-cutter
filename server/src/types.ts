export const TASK_STATUS = {
  PENDING: 'pending',
  UPLOADING: 'uploading',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export type CutMode = 'fast' | 'precise';

/** 推送给前端的进度事件（SSE data 字段） */
export interface ProgressEvent {
  taskId: string;
  status: TaskStatus;
  progress: number;
  processedSeconds: number;
  totalSeconds: number | null;
  segments: number;
  message: string;
  error?: string | null;
}

/** FFmpeg 进度回调载荷 */
export interface CutProgress {
  processedSeconds: number;
  totalSeconds: number | null;
  progress: number;
  segments: number;
  message: string;
}

export interface SegmentInfo {
  name: string;
  size: number;
  index: number;
  url: string;
}

export interface ApiTask {
  id: string;
  uploadId: string;
  originalName: string;
  segmentTime: number;
  mode: CutMode;
  outputFormat: string;
  status: TaskStatus;
  progress: number;
  processedSeconds: number;
  totalSeconds: number | null;
  segmentCount: number;
  message: string | null;
  error: string | null;
  size: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
