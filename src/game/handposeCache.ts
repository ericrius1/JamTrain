let workerReadyPromise: Promise<void> | undefined;

const SERVICE_WORKER_URL = '/jam-train-sw.js';

export function registerHandposeCacheWorker(): Promise<void> {
  if (workerReadyPromise) return workerReadyPromise;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    workerReadyPromise = Promise.resolve();
    return workerReadyPromise;
  }

  workerReadyPromise = navigator.serviceWorker
    .register(SERVICE_WORKER_URL, { scope: '/' })
    .then(async () => {
      await navigator.serviceWorker.ready;
    })
    .catch(err => {
      console.warn('[jam-train] handpose cache worker unavailable', err);
    });

  return workerReadyPromise;
}

export async function waitForHandposeCacheWorker(timeoutMs = 1200): Promise<void> {
  const ready = registerHandposeCacheWorker();
  await Promise.race([
    ready,
    new Promise<void>(resolve => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
}
