export interface DeferredStartupTask {
  readonly label: string;
  readonly run: () => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface DeferredStartupCoordinator {
  schedule(task: DeferredStartupTask): Promise<void>;
  drain(timeoutMs?: number): Promise<void>;
}

export function createDeferredStartupCoordinator(
  scheduler: (callback: () => void) => void = (callback) => setTimeout(callback, 0),
): DeferredStartupCoordinator {
  const pending = new Set<Promise<void>>();

  return {
    schedule(task: DeferredStartupTask): Promise<void> {
      let promise!: Promise<void>;
      promise = new Promise<void>((resolve) => {
        scheduler(() => {
          Promise.resolve()
            .then(() => task.run())
            .catch((error) => {
              task.onError?.(error);
            })
            .finally(() => {
              pending.delete(promise);
              resolve();
            });
        });
      });
      pending.add(promise);
      return promise;
    },

    async drain(timeoutMs?: number): Promise<void> {
      const snapshot = [...pending];
      if (snapshot.length === 0) return;
      const settle = Promise.allSettled(snapshot).then(() => undefined);
      if (timeoutMs == null) {
        await settle;
        return;
      }
      await Promise.race([
        settle,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };
}
