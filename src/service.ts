export type NotifyServiceParams = {
  intervalMs: number;
  tickFn: () => Promise<void>;
  onError?: (err: unknown) => void;
};

export type NotifyService = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// Chained setTimeout (not setInterval) so a slow tick can't pile up
// overlapping work. Each tick awaits completion before the next is scheduled.
export function createNotifyService(params: NotifyServiceParams): NotifyService {
  let handle: NodeJS.Timeout | null = null;
  let stopped = true;
  // Tracks an in-flight tick so stop() can wait for it. Without this, a
  // SIGTERM mid-delivery exits while the DB row is still reserved; the 10-min
  // reservation timeout eventually reclaims it, but graceful shutdown is
  // nicer and avoids a retry the user didn't ask for.
  let inflight: Promise<void> | null = null;

  const safeTick = (): Promise<void> => {
    const p = (async () => {
      try {
        await params.tickFn();
      } catch (err) {
        params.onError?.(err);
      }
    })();
    inflight = p;
    return p.finally(() => {
      if (inflight === p) inflight = null;
    });
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    handle = setTimeout(async () => {
      handle = null;
      if (stopped) return;
      await safeTick();
      scheduleNext();
    }, params.intervalMs);
  };

  return {
    async start() {
      stopped = false;
      await safeTick();
      scheduleNext();
    },
    async stop() {
      stopped = true;
      if (handle) {
        clearTimeout(handle);
        handle = null;
      }
      if (inflight) await inflight;
    },
  };
}
