export type TaskStatus =
  | 'pending'
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CutMode = 'fast' | 'precise';

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

export interface SegmentInfo {
  name: string;
  size: number;
  index: number;
  url: string;
}

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

export interface UploadResult {
  fileId: string;
  originalName: string;
  size: number;
  duration: number | null;
}

export interface Limits {
  maxUploadBytes: number;
  maxUploadMB: number;
  allowedExtensions: string[];
  defaultSegmentTime: number;
  maxConcurrency: number;
  retentionHours: number;
}

export interface TaskListResponse {
  tasks: ApiTask[];
  active: number;
  maxConcurrency: number;
}
