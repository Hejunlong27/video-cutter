import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import type { ApiTask } from '../types';

const ACTIVE = ['queued', 'processing', 'pending'];

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function TaskListPage() {
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [active, setActive] = useState(0);
  const [maxConcurrency, setMaxConcurrency] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.listTasks(100);
      setTasks(data.tasks);
      setActive(data.active);
      setMaxConcurrency(data.maxConcurrency);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 有进行中的任务时自动轮询刷新列表
  useEffect(() => {
    if (active === 0) return;
    const timer = setInterval(() => void load(true), 2000);
    return () => clearInterval(timer);
  }, [active, load]);

  const handleDelete = async (id: string) => {
    if (!window.confirm('确定删除该任务及其全部片段文件？')) return;
    try {
      await api.deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.cancelTask(id);
      await load(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">任务列表</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            进行中 {active} 个 · 服务并发上限 {maxConcurrency}
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading ? (
        <p className="py-16 text-center text-sm text-slate-400">加载中...</p>
      ) : tasks.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm text-slate-500">还没有任务</p>
          <Link to="/" className="btn-primary mt-4">
            新建切割任务
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => {
            const isActive = ACTIVE.includes(task.status);
            return (
              <li key={task.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/tasks/${task.id}`}
                      className="block truncate font-medium text-slate-900 hover:text-brand-600"
                    >
                      {task.originalName}
                    </Link>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                      <span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
                      <span>每段 {task.segmentTime}s</span>
                      <span>{task.mode === 'fast' ? '快速无损' : '精确重编码'}</span>
                      <span>{fmtSize(task.size)}</span>
                      {task.segmentCount > 0 && (
                        <span className="text-slate-500">
                          {task.segmentCount} 个片段
                        </span>
                      )}
                    </p>

                    {isActive && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full rounded-full bg-brand-600 transition-all"
                          style={{ width: `${Math.min(100, task.progress)}%` }}
                        />
                      </div>
                    )}
                    {task.error && (
                      <p className="mt-1 truncate text-xs text-red-500">
                        {task.error}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={task.status} />
                    {task.status === 'completed' && task.segmentCount > 0 && (
                      <a
                        className="text-xs font-medium text-brand-600 hover:underline"
                        href={api.zipUrl(task.id)}
                      >
                        下载
                      </a>
                    )}
                    {isActive && (
                      <button
                        className="text-xs text-amber-600 hover:underline"
                        onClick={() => void handleCancel(task.id)}
                      >
                        取消
                      </button>
                    )}
                    <button
                      className="text-xs text-red-500 hover:underline"
                      onClick={() => void handleDelete(task.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
