import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { ProgressBar } from '../components/ProgressBar';
import { SegmentList } from '../components/SegmentList';
import { StatusBadge } from '../components/StatusBadge';
import { useTaskStream } from '../hooks/useTaskStream';
import type { ApiTask, ProgressEvent, SegmentInfo } from '../types';

const TERMINAL = ['completed', 'failed', 'cancelled'];

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [task, setTask] = useState<ApiTask | null>(null);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 拉取任务 + 片段（片段仅在完成后加载）
  const refresh = useCallback(
    async (silent = false) => {
      if (!id) return;
      if (!silent) setLoading(true);
      try {
        const data = await api.getTask(id);
        setTask(data.task);
        setSegments(data.segments);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE 实时进度
  const onTerminal = useCallback(
    (event: ProgressEvent) => {
      // 终态后补一次完整数据（拿片段列表）
      if (event.status === 'completed') {
        setTimeout(() => void refresh(true), 300);
      }
    },
    [refresh],
  );

  const { event, connected, streamError } = useTaskStream(id, { onTerminal });

  // 把 SSE 事件合并进本地 task，让 UI 秒级响应
  const live: ApiTask | null = task
    ? event
      ? {
          ...task,
          status: event.status,
          progress: event.progress,
          processedSeconds: event.processedSeconds,
          totalSeconds: event.totalSeconds ?? task.totalSeconds,
          segmentCount: event.segments,
          message: event.message,
          error: event.error ?? task.error,
        }
      : task
    : null;

  // 处理中时，片段数变化就静默刷新片段列表（完成后才有内容）
  useEffect(() => {
    if (!live || !id) return;
    if (live.status === 'completed' && segments.length === 0) {
      void refresh(true);
    }
  }, [live?.status, live?.segmentCount, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await api.cancelTask(id);
      await refresh(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm('确定删除该任务及其全部片段文件？此操作不可恢复。')) return;
    setBusy(true);
    try {
      await api.deleteTask(id);
      navigate('/tasks');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (loading) {
    return <p className="py-16 text-center text-sm text-slate-400">加载中...</p>;
  }

  if (!live) {
    return (
      <div className="card p-8 text-center">
        <p className="text-sm text-red-600">{error || '任务不存在'}</p>
        <Link to="/tasks" className="btn-ghost mt-4">
          返回任务列表
        </Link>
      </div>
    );
  }

  const isActive = !TERMINAL.includes(live.status);
  const canDownload = live.status === 'completed' && live.segmentCount > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Link to="/tasks" className="text-sm text-slate-500 hover:text-slate-800">
          ← 返回任务列表
        </Link>
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
          />
          {connected ? '实时连接中' : '未连接'}
        </span>
      </div>

      <section className="card p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-slate-900">
              {live.originalName}
            </h1>
            <p className="mt-0.5 font-mono text-xs text-slate-400">
              {live.id}
            </p>
          </div>
          <StatusBadge status={live.status} />
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Meta label="片段时长" value={`${live.segmentTime}s`} />
          <Meta
            label="模式"
            value={live.mode === 'fast' ? '快速无损' : '精确重编码'}
          />
          <Meta label="已生成片段" value={String(live.segmentCount)} />
          <Meta
            label="创建时间"
            value={new Date(live.createdAt).toLocaleString('zh-CN')}
          />
        </div>

        <ProgressBar
          progress={live.progress}
          status={live.status}
          message={live.message}
          processedSeconds={live.processedSeconds}
          totalSeconds={live.totalSeconds}
        />

        {live.error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <p className="font-medium">切割失败</p>
            <p className="mt-0.5 break-all text-xs">{live.error}</p>
          </div>
        )}

        {streamError && (
          <p className="mt-3 text-xs text-amber-600">{streamError}</p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {canDownload && (
            <a className="btn-primary" href={api.zipUrl(live.id)}>
              ⬇ 打包下载 ZIP（{live.segmentCount} 段）
            </a>
          )}
          {isActive && (
            <button
              className="btn-danger"
              disabled={busy}
              onClick={handleCancel}
            >
              取消任务
            </button>
          )}
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => void refresh()}
          >
            刷新
          </button>
          <button
            className="btn-ghost ml-auto"
            disabled={busy}
            onClick={handleDelete}
          >
            删除任务
          </button>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">片段列表</h2>
        <SegmentList
          taskId={live.id}
          segments={segments}
          segmentTime={live.segmentTime}
          loading={isActive && segments.length === 0}
        />
      </section>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-0.5 truncate font-medium text-slate-800">{value}</p>
    </div>
  );
}
