import { runCleanup } from './cleanup.js';

const HOUR_MS = 3_600_000;
const MAX_JITTER_MS = 60_000;

/**
 * In-process cleanup schedule: a first run after CLEANUP_START_DELAY_SECONDS plus up to 60 s of
 * random jitter (so replicas started together do not run at once), then every
 * CLEANUP_INTERVAL_HOURS. Timers are unref'd. A tick that finds a run still in progress in this
 * process is skipped. Other processes are kept out by the advisory lock in `runCleanup`.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   mailer: import('../mail.js').Mailer,
 *   logger: import('./cleanup.js').Logger,
 *   metrics?: { setCleanupSuccess(date: Date): void },
 *   getProvider?: () => any | any,
 * }} deps
 * @returns {{ stop(): Promise<void> }} stop() clears the timers; the promise settles when a run in progress has finished
 */
export function startCleanupScheduler({ config, pool, mailer, logger, metrics, getProvider }) {
  if (config.cleanup.disabled) {
    logger.info({}, 'cleanup scheduler disabled (CLEANUP_DISABLED=true)');
    return { stop: () => Promise.resolve() };
  }

  const intervalMs = config.cleanup.intervalHours * HOUR_MS;
  const firstDelayMs =
    config.cleanup.startDelaySeconds * 1000 + Math.floor(Math.random() * MAX_JITTER_MS);

  /** @type {Promise<void> | null} */
  let inFlight = null;

  const tick = () => {
    if (inFlight) {
      logger.warn({}, 'cleanup still running, skipping this tick');
      return;
    }
    inFlight = runCleanup({ pool, config, mailer, logger, metrics, getProvider })
      .then(
        () => undefined,
        (err) => {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            'cleanup run failed',
          );
        },
      )
      .finally(() => {
        inFlight = null;
      });
  };

  /** @type {NodeJS.Timeout | undefined} */
  let interval;
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
    interval.unref();
  }, firstDelayMs);
  first.unref();
  logger.info({ firstDelayMs, intervalMs }, 'cleanup scheduled');

  return {
    stop() {
      clearTimeout(first);
      if (interval) clearInterval(interval);
      return inFlight ?? Promise.resolve();
    },
  };
}
