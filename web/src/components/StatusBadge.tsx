import type { TaskStatus } from '../types';

const MAP: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: '待处理', cls: 'bg-slate-100 text-slate-600' },
  uploading: { label: '上传中', cls: 'bg-sky-100 text-sky-700' },
  queued: { label: '排队中', cls: 'bg-amber-100 text-amber-700' },
  processing: { label: '切割中', cls: 'bg-brand-100 text-brand-700' },
  completed: { label: '已完成', cls: 'bg-emerald-100 text-emerald-700' },
  failed: { label: '失败', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: '已取消', cls: 'bg-slate-200 text-slate-600' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const item = MAP[status] ?? MAP.pending;
  return <span className={`badge ${item.cls}`}>{item.label}</span>;
}
