import type {
  ApiTask,
  CutMode,
  Limits,
  SegmentInfo,
  TaskListResponse,
  UploadResult,
} from './types';

const BASE = '/api';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const msg =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: string }).error)
        : null) || `请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return payload as T;
}

export const api = {
  limits: () => request<Limits>(`${BASE}/upload/limits`),

  /**
   * 上传视频。用 XMLHttpRequest 换取 upload.onprogress，
   * fetch 目前拿不到上传进度。
   */
  upload(
    file: File,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/upload`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload as UploadResult);
        } else {
          const msg =
            (payload && typeof payload === 'object' && 'error' in payload
              ? String((payload as { error: string }).error)
              : null) || `上传失败 (${xhr.status})`;
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误，上传失败'));
      xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));

      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  },

  createTask(input: {
    fileId: string;
    segmentTime: number;
    mode: CutMode;
    outputFormat?: string;
  }) {
    return request<{ task: ApiTask }>(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  listTasks(limit = 50) {
    return request<TaskListResponse>(`${BASE}/tasks?limit=${limit}`);
  },

  getTask(id: string) {
    return request<{
      task: ApiTask;
      segments: SegmentInfo[];
      running: boolean;
    }>(`${BASE}/tasks/${id}`);
  },

  getSegments(id: string) {
    return request<{ taskId: string; segments: SegmentInfo[] }>(
      `${BASE}/tasks/${id}/segments`,
    );
  },

  cancelTask(id: string) {
    return request<{ ok: boolean; task: ApiTask }>(
      `${BASE}/tasks/${id}/cancel`,
      { method: 'POST' },
    );
  },

  deleteTask(id: string) {
    return request<{ ok: boolean }>(`${BASE}/tasks/${id}`, {
      method: 'DELETE',
    });
  },

  zipUrl: (id: string) => `${BASE}/tasks/${id}/download`,
  segmentUrl: (id: string, name: string) =>
    `${BASE}/tasks/${id}/segments/${name}`,
  segmentDownloadUrl: (id: string, name: string) =>
    `${BASE}/tasks/${id}/segments/${name}?download=1`,
};
