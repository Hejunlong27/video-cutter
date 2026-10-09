interface Props {
  progress: number;
  status: string;
  message?: string | null;
  processedSeconds?: number;
  totalSeconds?: number | null;
}

function fmtTime(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function ProgressBar({
  progress,
  status,
  message,
  processedSeconds,
  totalSeconds,
}: Props) {
  const pct = Math.max(0, Math.min(100, progress));
  const failed = status === 'failed';
  const done = status === 'completed';
  const cancelled = status === 'cancelled';

  const barColor = failed
    ? 'bg-red-500'
    : cancelled
      ? 'bg-slate-400'
      : done
        ? 'bg-emerald-500'
        : 'bg-brand-600';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-600">{message || '等待中...'}</span>
        <span className="font-mono tabular-nums text-slate-900">
          {pct.toFixed(1)}%
        </span>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor} ${
            !done && !failed && !cancelled ? 'animate-pulse' : ''
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="font-mono tabular-nums">
          已处理 {fmtTime(processedSeconds)} / {fmtTime(totalSeconds)}
        </span>
        <span>{totalSeconds ? `总时长 ${fmtTime(totalSeconds)}` : ''}</span>
      </div>
    </div>
  );
}
