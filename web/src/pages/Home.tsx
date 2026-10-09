import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Uploader } from '../components/Uploader';
import type { CutMode, Limits, UploadResult } from '../types';

const PRESET_TIMES = [5, 10, 15, 30, 60];

export default function Home() {
  const navigate = useNavigate();
  const [limits, setLimits] = useState<Limits | null>(null);
  const [uploaded, setUploaded] = useState<UploadResult | null>(null);
  const [segmentTime, setSegmentTime] = useState(10);
  const [mode, setMode] = useState<CutMode>('fast');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .limits()
      .then((l) => {
        setLimits(l);
        setSegmentTime(l.defaultSegmentTime);
      })
      .catch(() => undefined);
  }, []);

  const estimatedCount =
    uploaded?.duration && segmentTime > 0
      ? Math.ceil(uploaded.duration / segmentTime)
      : null;

  const handleSubmit = async () => {
    if (!uploaded) {
      setError('请先上传视频');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { task } = await api.createTask({
        fileId: uploaded.fileId,
        segmentTime,
        mode,
        outputFormat: 'mp4',
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="card p-5">
        <h1 className="mb-1 text-lg font-semibold text-slate-900">
          上传视频并切割
        </h1>
        <p className="mb-4 text-sm text-slate-500">
          上传后按指定时长自动切成多段，完成后可打包 ZIP 下载。
        </p>

        {limits ? (
          <Uploader
            accept={limits.allowedExtensions}
            maxMB={limits.maxUploadMB}
            onUploaded={setUploaded}
          />
        ) : (
          <p className="py-8 text-center text-sm text-slate-400">
            正在读取服务配置...
          </p>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-4 text-base font-semibold text-slate-900">切割参数</h2>

        <div className="space-y-5">
          {/* 片段时长 */}
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              每段时长（秒）
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_TIMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSegmentTime(t)}
                  className={[
                    'rounded-lg border px-3 py-1.5 text-sm transition',
                    segmentTime === t
                      ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
                  ].join(' ')}
                >
                  {t}s
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={3600}
                value={segmentTime}
                onChange={(e) => setSegmentTime(Number(e.target.value) || 1)}
                className="input w-24"
              />
              <span className="text-xs text-slate-400">
                1 ~ 3600 秒
                {estimatedCount !== null && (
                  <span className="ml-2 text-brand-600">
                    预计生成 {estimatedCount} 个片段
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* 模式选择 */}
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              切割模式
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setMode('fast')}
                className={[
                  'rounded-xl border p-4 text-left transition',
                  mode === 'fast'
                    ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
                    : 'border-slate-300 bg-white hover:bg-slate-50',
                ].join(' ')}
              >
                <p className="mb-1 font-medium text-slate-900">
                  快速无损 <span className="text-xs text-slate-400">-c copy</span>
                </p>
                <p className="text-xs leading-relaxed text-slate-500">
                  直接流拷贝，速度极快、画质零损失。但片段边界会吸附到最近的关键帧，
                  实际时长可能偏离设定值（常见 ±1~3 秒）。
                </p>
              </button>

              <button
                type="button"
                onClick={() => setMode('precise')}
                className={[
                  'rounded-xl border p-4 text-left transition',
                  mode === 'precise'
                    ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
                    : 'border-slate-300 bg-white hover:bg-slate-50',
                ].join(' ')}
              >
                <p className="mb-1 font-medium text-slate-900">
                  精确重编码{' '}
                  <span className="text-xs text-slate-400">libx264</span>
                </p>
                <p className="text-xs leading-relaxed text-slate-500">
                  强制在每段边界插入关键帧，片段时长严格贴合设定值。
                  代价是需要重新编码，耗时约为视频时长的 0.5~1.5 倍。
                </p>
              </button>
            </div>
          </div>

          {mode === 'fast' && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ⚠️ 快速模式受源视频关键帧分布影响，片段时长可能不等于 {segmentTime} 秒。
              若必须严格等长，请改用「精确重编码」。
            </p>
          )}

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <button
            type="button"
            className="btn-primary w-full py-2.5"
            disabled={!uploaded || submitting}
            onClick={handleSubmit}
          >
            {submitting ? '创建中...' : '开始切割'}
          </button>
        </div>
      </section>
    </div>
  );
}
