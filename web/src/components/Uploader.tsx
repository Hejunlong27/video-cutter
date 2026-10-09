import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import type { UploadResult } from '../types';

interface Props {
  accept: string[];
  maxMB: number;
  onUploaded: (result: UploadResult) => void;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function Uploader({ accept, maxMB, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!accept.includes(ext)) {
        setError(`不支持的格式 .${ext}，仅允许：${accept.join('、')}`);
        return;
      }
      if (file.size > maxMB * 1024 * 1024) {
        setError(`文件 ${fmtSize(file.size)} 超过上限 ${maxMB}MB`);
        return;
      }

      setUploading(true);
      setPercent(0);
      setResult(null);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await api.upload(file, setPercent, controller.signal);
        setResult(res);
        onUploaded(res);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        setUploading(false);
        abortRef.current = null;
      }
    },
    [accept, maxMB, onUploaded],
  );

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (uploading) return;
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        onClick={() => !uploading && inputRef.current?.click()}
        className={[
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
          dragging
            ? 'border-brand-500 bg-brand-50'
            : 'border-slate-300 bg-slate-50 hover:border-brand-400 hover:bg-brand-50/40',
          uploading ? 'cursor-progress opacity-80' : '',
        ].join(' ')}
      >
        <div className="text-3xl">{uploading ? '⏳' : '🎬'}</div>
        {uploading ? (
          <>
            <p className="text-sm font-medium text-slate-700">
              正在上传 {percent}%
            </p>
            <div className="h-2 w-64 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-brand-600 transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            <button
              type="button"
              className="text-xs text-red-500 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                abortRef.current?.abort();
              }}
            >
              取消上传
            </button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-700">
              拖拽视频到此处，或点击选择文件
            </p>
            <p className="text-xs text-slate-400">
              支持 {accept.join(' / ')}，单文件最大 {maxMB}MB
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={accept.map((e) => `.${e}`).join(',')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {result && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium text-emerald-800">
              ✓ {result.originalName}
            </p>
            <p className="text-xs text-emerald-600">
              {fmtSize(result.size)}
              {result.duration ? ` · 时长 ${result.duration.toFixed(1)}s` : ''}
            </p>
          </div>
          <span className="shrink-0 font-mono text-xs text-emerald-600">
            {result.fileId.slice(0, 8)}
          </span>
        </div>
      )}
    </div>
  );
}
