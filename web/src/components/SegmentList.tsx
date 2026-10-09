import { useState } from 'react';
import { api } from '../api';
import type { SegmentInfo } from '../types';

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  taskId: string;
  segments: SegmentInfo[];
  segmentTime: number;
  loading?: boolean;
}

export function SegmentList({ taskId, segments, segmentTime, loading }: Props) {
  const [preview, setPreview] = useState<SegmentInfo | null>(null);

  if (loading) {
    return <p className="py-6 text-center text-sm text-slate-400">加载片段中...</p>;
  }

  if (segments.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-400">
        暂无片段，任务完成后将在此显示
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>共 {segments.length} 个片段 · 每段约 {segmentTime}s</span>
        <a
          className="font-medium text-brand-600 hover:underline"
          href={api.zipUrl(taskId)}
        >
          打包下载 ZIP
        </a>
      </div>

      <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {segments.map((seg) => (
          <li
            key={seg.name}
            className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50"
          >
            <span className="w-12 shrink-0 font-mono text-xs text-slate-400">
              #{String(seg.index + 1).padStart(3, '0')}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">
              {seg.name}
            </span>
            <span className="shrink-0 text-xs text-slate-400">
              {fmtSize(seg.size)}
            </span>
            <button
              type="button"
              className="shrink-0 text-xs text-slate-500 hover:text-brand-600"
              onClick={() => setPreview(seg)}
            >
              预览
            </button>
            <a
              className="shrink-0 text-xs font-medium text-brand-600 hover:underline"
              href={api.segmentDownloadUrl(taskId, seg.name)}
            >
              下载
            </a>
          </li>
        ))}
      </ul>

      {preview && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="w-full max-w-2xl rounded-xl bg-white p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-xs text-slate-600">
                {preview.name}
              </span>
              <button
                className="text-slate-400 hover:text-slate-700"
                onClick={() => setPreview(null)}
              >
                ✕
              </button>
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              className="w-full rounded-lg bg-black"
              src={api.segmentUrl(taskId, preview.name)}
              controls
              autoPlay
            />
          </div>
        </div>
      )}
    </div>
  );
}
