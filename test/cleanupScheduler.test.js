import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/jobs/cleanup.js', () => ({ runCleanup: vi.fn() }));

const { runCleanup } = await import('../src/jobs/cleanup.js');
const { startCleanupScheduler } = await import('../src/jobs/scheduler.js');
const { loadConfig } = await import('../src/config.js');

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** @param {Record<string, string>} [env] */
const configWith = (env = {}) =>
  loadConfig({
    ISSUER: 'https://id.example.org',
    DATABASE_URL: 'postgres://x',
    KEY_ENCRYPTION_SECRET: 's',
    COOKIE_SECRETS: 'c',
    ...env,
  });

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const deps = (/** @type {Record<string, string>} */ env = {}) => ({
  config: configWith(env),
  pool: /** @type {any} */ ({}),
  mailer: /** @type {any} */ ({}),
  logger,
});

/** Resolve pending promises queued by the fake timers. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('startCleanupScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runCleanup).mockReset();
    vi.mocked(runCleanup).mockResolvedValue({
      payloads: 0,
      codes: 0,
      auditIpsCleared: 0,
      auditDeleted: 0,
      warned: 0,
      warnFailed: 0,
      deleted: 0,
      errors: [],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not start any timer when CLEANUP_DISABLED=true', async () => {
    const scheduler = startCleanupScheduler(deps({ CLEANUP_DISABLED: 'true' }));
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(runCleanup).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('runs first after the start delay plus jitter, then every interval', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 30 s of jitter
    const scheduler = startCleanupScheduler(deps({ CLEANUP_START_DELAY_SECONDS: '60' }));

    await vi.advanceTimersByTimeAsync(90 * 1000 - 1);
    expect(runCleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runCleanup).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * HOUR - 1);
    expect(runCleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCleanup).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('keeps jitter below one minute', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const scheduler = startCleanupScheduler(deps({ CLEANUP_START_DELAY_SECONDS: '0' }));
    await vi.advanceTimersByTimeAsync(MINUTE - 2);
    expect(runCleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // jitter is floor(0.999999 * 60 000) = 59 999 ms
    expect(runCleanup).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('uses CLEANUP_INTERVAL_HOURS for the interval', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const scheduler = startCleanupScheduler(
      deps({ CLEANUP_START_DELAY_SECONDS: '0', CLEANUP_INTERVAL_HOURS: '6' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(runCleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(runCleanup).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('does not start a second run while one is still in progress', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    /** @type {() => void} */ let finish = () => {};
    vi.mocked(runCleanup).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ skipped: true });
        }),
    );
    const scheduler = startCleanupScheduler(deps({ CLEANUP_START_DELAY_SECONDS: '0' }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25 * HOUR); // two ticks while the first run is open
    expect(runCleanup).toHaveBeenCalledTimes(1);

    finish();
    await flush();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(runCleanup).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('keeps running after a failed run', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(runCleanup).mockRejectedValueOnce(new Error('database down'));
    const scheduler = startCleanupScheduler(deps({ CLEANUP_START_DELAY_SECONDS: '0' }));
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(runCleanup).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('stop() cancels the timers and resolves once a run in progress has finished', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    /** @type {() => void} */ let finish = () => {};
    vi.mocked(runCleanup).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ skipped: true });
        }),
    );
    const scheduler = startCleanupScheduler(deps({ CLEANUP_START_DELAY_SECONDS: '0' }));
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const done = scheduler.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    finish();
    await done;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(72 * HOUR);
    expect(runCleanup).toHaveBeenCalledTimes(1);
  });

  it('passes the metrics instance to each run', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const metrics = { setCleanupSuccess() {} };
    const scheduler = startCleanupScheduler({
      ...deps({ CLEANUP_START_DELAY_SECONDS: '0' }),
      metrics,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(runCleanup).mock.calls[0][0].metrics).toBe(metrics);
    await scheduler.stop();
  });
});
