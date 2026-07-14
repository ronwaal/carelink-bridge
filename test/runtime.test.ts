import { describe, it, expect } from 'vitest';
import { BridgeRuntime, type RuntimeLogger } from '../src/runtime.js';
import type { CareLinkData } from '../src/types/carelink.js';
import type {
  NightscoutDeviceStatus,
  NightscoutSGVEntry,
  TransformResult,
} from '../src/types/nightscout.js';

function careLinkData(records = 1): CareLinkData {
  return {
    sgs: Array.from({ length: records }, (_, index) => ({
      sg: 100 + index,
      datetime: 'Oct 20, 2015 11:09:00',
      version: 1,
      kind: 'SG',
    })),
    lastMedicalDeviceDataUpdateServerTime: Date.parse('2026-01-01T00:00:00Z'),
  } as CareLinkData;
}

function entry(date: number, sgv = 100): NightscoutSGVEntry {
  return {
    type: 'sgv',
    sgv,
    date,
    dateString: new Date(date).toISOString(),
    device: 'connect-test',
  };
}

function deviceStatus(date: number): NightscoutDeviceStatus {
  return {
    created_at: new Date(date).toISOString(),
    device: 'connect-test',
    uploader: { battery: 90 },
    connect: {
      sensorState: 'NORMAL',
      calibStatus: 'OK',
      sensorDurationHours: 10,
      timeToNextCalibHours: 4,
      conduitInRange: true,
      conduitMedicalDeviceInRange: true,
      conduitSensorInRange: true,
    },
  };
}

function transformed(date = Date.parse('2026-01-01T00:00:00Z'), sgv = 100): TransformResult {
  return {
    entries: [entry(date, sgv)],
    devicestatus: [deviceStatus(date)],
  };
}

function httpError(status: number): unknown {
  return { response: { status } };
}

function codeError(code: string, message = code): unknown {
  return { code, message };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createLogger() {
  const lines: string[] = [];
  const logger: RuntimeLogger = {
    info: (message, fields) => lines.push(`info ${message} ${JSON.stringify(fields ?? {})}`),
    warn: (message, fields) => lines.push(`warn ${message} ${JSON.stringify(fields ?? {})}`),
    error: (message, fields) => lines.push(`error ${message} ${JSON.stringify(fields ?? {})}`),
  };
  return { logger, lines };
}

function createRuntime(overrides: {
  fetchCareLinkData?: () => Promise<CareLinkData>;
  reauthenticateCareLink?: () => Promise<void>;
  transformData?: (data: CareLinkData, limit?: number) => TransformResult;
  upload?: (items: unknown[], endpoint: string) => Promise<void>;
  maxRetries?: number;
  intervalMs?: number;
  heartbeatIntervalMs?: number;
  afterSleep?: (ms: number) => void | Promise<void>;
} = {}) {
  const { logger, lines } = createLogger();
  const sleeps: number[] = [];
  const uploads: Array<{ endpoint: string; items: unknown[] }> = [];
  let now = Date.parse('2026-01-01T00:00:00Z');

  const runtime = new BridgeRuntime(
    {
      fetchCareLinkData: overrides.fetchCareLinkData ?? (async () => careLinkData()),
      reauthenticateCareLink: overrides.reauthenticateCareLink,
      transformData: overrides.transformData ?? (() => transformed(now)),
      upload: overrides.upload ?? (async (items, endpoint) => {
        uploads.push({ endpoint, items });
      }),
      logger,
      sleep: async ms => {
        sleeps.push(ms);
        now += ms;
        await overrides.afterSleep?.(ms);
      },
      now: () => now,
      random: () => 0.5,
    },
    {
      intervalMs: overrides.intervalMs ?? 60_000,
      sgvLimit: 24,
      entriesUrl: 'https://nightscout.example/api/v1/entries.json',
      deviceStatusUrl: 'https://nightscout.example/api/v1/devicestatus.json',
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 30_000,
      maxRetries: overrides.maxRetries ?? 3,
    },
  );

  return { runtime, lines, sleeps, uploads, get now() { return now; } };
}

describe('BridgeRuntime', () => {
  it('runs multiple successful polling cycles without overlapping', async () => {
    let fetches = 0;
    let harness!: ReturnType<typeof createRuntime>;
    harness = createRuntime({
      fetchCareLinkData: async () => {
        fetches += 1;
        return careLinkData();
      },
      transformData: () => transformed(Date.parse('2026-01-01T00:00:00Z') + fetches * 300_000),
      upload: async () => {},
      intervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      afterSleep: () => {
        if (fetches >= 3) harness.runtime.stop('test-complete');
      },
    });

    await harness.runtime.start();

    expect(fetches).toBe(3);
    expect(harness.lines.some(line => line.includes('bridge stopped'))).toBe(true);
  });

  it('recovers from a temporary CareLink network error with backoff', async () => {
    let fetches = 0;
    const harness = createRuntime({
      maxRetries: 1,
      fetchCareLinkData: async () => {
        fetches += 1;
        if (fetches === 1) throw codeError('ECONNRESET');
        return careLinkData();
      },
    });

    const result = await harness.runtime.runCycleForTest();

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(harness.sleeps).toEqual([5_000]);
    expect(harness.lines.join('\n')).toContain('NETWORK_ERROR');
  });

  it('performs one CareLink reauthentication after a 401 and retries the fetch', async () => {
    let fetches = 0;
    let reauths = 0;
    const harness = createRuntime({
      maxRetries: 0,
      fetchCareLinkData: async () => {
        fetches += 1;
        if (fetches === 1) throw httpError(401);
        return careLinkData();
      },
      reauthenticateCareLink: async () => {
        reauths += 1;
      },
    });

    const result = await harness.runtime.runCycleForTest();

    expect(result.success).toBe(true);
    expect(fetches).toBe(2);
    expect(reauths).toBe(1);
    expect(harness.lines.join('\n')).toContain('carelink session recovery completed');
  });

  it('does not enter an infinite loop when CareLink reauthentication fails', async () => {
    let reauths = 0;
    const harness = createRuntime({
      fetchCareLinkData: async () => {
        throw httpError(401);
      },
      reauthenticateCareLink: async () => {
        reauths += 1;
        throw httpError(401);
      },
    });

    await expect(harness.runtime.runCycleForTest()).rejects.toMatchObject({
      category: 'CARELINK_AUTH_FAILED',
      recoverable: false,
    });
    expect(reauths).toBe(1);
  });

  it('backs off after a Nightscout 500 and retries without dropping uncommitted records', async () => {
    let uploadAttempts = 0;
    const uploadedEntryDates: number[] = [];
    const harness = createRuntime({
      maxRetries: 1,
      transformData: () => transformed(Date.parse('2026-01-01T00:05:00Z')),
      upload: async (items, endpoint) => {
        if (endpoint.includes('entries')) {
          uploadAttempts += 1;
          uploadedEntryDates.push((items[0] as NightscoutSGVEntry).date);
          if (uploadAttempts === 1) throw httpError(500);
        }
      },
    });

    const result = await harness.runtime.runCycleForTest();

    expect(result.success).toBe(true);
    expect(harness.sleeps).toEqual([5_000]);
    expect(uploadedEntryDates).toEqual([
      Date.parse('2026-01-01T00:05:00Z'),
      Date.parse('2026-01-01T00:05:00Z'),
    ]);
  });

  it('treats Nightscout 401 and 403 as non-retryable auth/config failures', async () => {
    for (const status of [401, 403]) {
      const harness = createRuntime({
        upload: async () => {
          throw httpError(status);
        },
      });

      await expect(harness.runtime.runCycleForTest()).rejects.toMatchObject({
        category: 'NIGHTSCOUT_UPLOAD_FAILED',
        recoverable: false,
        httpStatus: status,
      });
      expect(harness.sleeps).toEqual([]);
    }
  });

  it('treats request timeouts as retryable and does not permanently stall', async () => {
    let fetches = 0;
    const harness = createRuntime({
      maxRetries: 1,
      fetchCareLinkData: async () => {
        fetches += 1;
        if (fetches === 1) throw codeError('ETIMEDOUT');
        return careLinkData();
      },
    });

    const result = await harness.runtime.runCycleForTest();

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(harness.sleeps).toEqual([5_000]);
    expect(harness.lines.join('\n')).toContain('CARELINK_FETCH_TIMEOUT');
  });

  it('prevents overlapping polling cycles', async () => {
    const pendingFetch = deferred<CareLinkData>();
    const harness = createRuntime({
      fetchCareLinkData: () => pendingFetch.promise,
    });

    const first = harness.runtime.runCycleForTest(1);
    await Promise.resolve();

    await expect(harness.runtime.runCycleForTest(2)).rejects.toMatchObject({
      category: 'UNEXPECTED_RUNTIME_ERROR',
    });

    pendingFetch.resolve(careLinkData());
    await expect(first).resolves.toMatchObject({ success: true });
  });

  it('keeps polling after a failed cycle', async () => {
    let fetches = 0;
    let harness!: ReturnType<typeof createRuntime>;
    harness = createRuntime({
      maxRetries: 0,
      intervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      fetchCareLinkData: async () => {
        fetches += 1;
        if (fetches === 1) throw codeError('ECONNRESET');
        return careLinkData();
      },
      transformData: () => transformed(Date.parse('2026-01-01T00:00:00Z') + fetches * 300_000),
      afterSleep: () => {
        if (fetches >= 2) harness.runtime.stop('test-complete');
      },
    });

    await harness.runtime.start();

    expect(fetches).toBe(2);
    expect(harness.lines.join('\n')).toContain('cycle deferred until next interval');
  });

  it('does not re-upload duplicate records after committed success', async () => {
    const harness = createRuntime({
      transformData: () => transformed(Date.parse('2026-01-01T00:10:00Z')),
    });

    const first = await harness.runtime.runCycleForTest(1);
    const second = await harness.runtime.runCycleForTest(2);

    expect(first.sgvsNew).toBe(1);
    expect(second.sgvsNew).toBe(0);
    expect(harness.uploads.filter(call => call.endpoint.includes('entries'))).toHaveLength(1);
    expect(harness.uploads.filter(call => call.endpoint.includes('devicestatus'))).toHaveLength(1);
  });

  it('finishes an active cycle before graceful shutdown completes', async () => {
    const pendingFetch = deferred<CareLinkData>();
    const harness = createRuntime({
      fetchCareLinkData: () => pendingFetch.promise,
      intervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
    });

    const running = harness.runtime.start();
    await Promise.resolve();
    harness.runtime.stop('SIGTERM');
    pendingFetch.resolve(careLinkData());
    await running;

    expect(harness.uploads).toHaveLength(2);
    expect(harness.lines.join('\n')).toContain('reason":"SIGTERM"');
  });

  it('does not log secrets, auth data, or glucose values', async () => {
    const harness = createRuntime({
      maxRetries: 0,
      fetchCareLinkData: async () => {
        throw {
          code: 'ECONNRESET',
          message: 'Bearer SENSITIVE_MARKER auth-header-marker glucose=123',
        };
      },
      transformData: () => transformed(Date.parse('2026-01-01T00:00:00Z'), 123),
    });

    await harness.runtime.runCycleForTest();

    const logs = harness.lines.join('\n');
    expect(logs).not.toContain('SENSITIVE_MARKER');
    expect(logs).not.toContain('auth-header-marker');
    expect(logs).not.toContain('glucose=123');
  });

  it('classifies unexpected CareLink response shapes without an uncontrolled crash', async () => {
    const harness = createRuntime({
      maxRetries: 0,
      fetchCareLinkData: async () => ({ sgs: null } as unknown as CareLinkData),
    });

    const result = await harness.runtime.runCycleForTest();

    expect(result.success).toBe(false);
    expect(harness.lines.join('\n')).toContain('CARELINK_INVALID_RESPONSE');
  });

  it('resets backoff after a successful full cycle', async () => {
    const outcomes = ['fail', 'ok', 'ok', 'fail', 'ok'];
    let date = Date.parse('2026-01-01T00:00:00Z');
    const harness = createRuntime({
      maxRetries: 1,
      fetchCareLinkData: async () => {
        const outcome = outcomes.shift();
        if (outcome === 'fail') throw codeError('ECONNRESET');
        return careLinkData();
      },
      transformData: () => {
        date += 300_000;
        return transformed(date);
      },
    });

    await harness.runtime.runCycleForTest(1);
    await harness.runtime.runCycleForTest(2);
    await harness.runtime.runCycleForTest(3);

    expect(harness.sleeps).toEqual([5_000, 5_000]);
  });
});
