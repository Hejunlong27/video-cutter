import { useEffect, useRef, useState } from 'react';
import type { ProgressEvent } from '../types';

const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * 订阅任务 SSE 进度。
 * 组件挂载即连，任务进入终态后自动断开；断线时自动重连（最多 5 次）。
 */
export function useTaskStream(
  taskId: string | undefined,
  options?: { onTerminal?: (event: ProgressEvent) => void },
) {
  const [event, setEvent] = useState<ProgressEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const onTerminalRef = useRef(options?.onTerminal);
  onTerminalRef.current = options?.onTerminal;

  useEffect(() => {
    if (!taskId) return;

    let source: EventSource | null = null;
    let retries = 0;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      source = new EventSource(`/api/tasks/${taskId}/events`);

      source.addEventListener('open', () => {
        setConnected(true);
        setStreamError(null);
        retries = 0;
      });

      source.addEventListener('progress', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as ProgressEvent;
          setEvent(data);
        } catch {
          /* 忽略坏帧 */
        }
      });

      source.addEventListener('done', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as ProgressEvent;
          setEvent(data);
          onTerminalRef.current?.(data);
        } catch {
          /* ignore */
        }
        close();
      });

      source.addEventListener('error', () => {
        setConnected(false);
        if (stopped) return;
        close();
        if (retries < 5) {
          retries += 1;
          retryTimer = setTimeout(connect, 1000 * retries);
        } else {
          setStreamError('实时连接中断，请刷新页面');
        }
      });
    };

    const close = () => {
      source?.close();
      source = null;
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      close();
    };
  }, [taskId]);

  const isTerminal = event ? TERMINAL.includes(event.status) : false;

  return { event, connected, streamError, isTerminal };
}
