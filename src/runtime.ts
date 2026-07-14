import { makeCommitRecencyFilter, type CommitRecencyFilter } from './filter.js';
import {
  BridgeError,
  classifyCareLinkError,
  classifyNightscoutError,
  isCareLinkAuthCategory,
  safeErrorDetails,
} from './errors.js';
import type { CareLinkData } from './types/carelink.js';
import type {
  NightscoutDeviceStatus,
  NightscoutSGVEntry,
  TransformResult,
} from './types/nightscout.js';

export interface RuntimeLogger {
  info(message: string, fields?: SafeLogFields): void;
  warn(message: string, fields?: SafeLogFields): void;
  error(message: string, fields?: SafeLogFields): void;
}

export type SafeLogValue = string | number | boolean | null | undefined;
export type SafeLogFields = Record<string, SafeLogValue>;

export interface BridgeRuntimeDependencies {
  fetchCareLinkData: () => Promise<CareLinkData>;
  reauthenticateCareLink?: () => Promise<void>;
  transformData: (data: CareLinkData, limit?: number) => TransformResult;
  upload: (items: unknown[], endpoint: string) => Promise<void>;
  logger?: RuntimeLogger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  withTimeout?: <T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    timeoutError: BridgeError,
  ) => Promise<T>;
  sgvFilter?: CommitRecencyFilter<NightscoutSGVEntry>;
  deviceStatusFilter?: CommitRecencyFilter<NightscoutDeviceStatus>;
}

export interface BridgeRuntimeOptions {
  intervalMs: number;
  sgvLimit: number;
  entriesUrl: string;
  deviceStatusUrl: string;
  heartbeatIntervalMs?: number;
  maxRetries?: number;
  backoffMs?: number[];
  maxBackoffMs?: number;
  jitterRatio?: number;
  careLinkLoginTimeoutMs?: number;
  careLinkFetchTimeoutMs?: number;
  nightscoutUploadTimeoutMs?: number;
}

export interface CycleResult {
  cycle: number;
  attempts: number;
  success: boolean;
  entriesReceived: number;
  sgvsValid: number;
  sgvsNew: number;
  sgvsSkippedDuplicate: number;
  deviceStatusesValid: number;
  deviceStatusesNew: number;
  deviceStatusesSkippedDuplicate: number;
  lastSuccessAt?: string;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_BACKOFF_MS = [5_000, 15_000, 30_000];
const DEFAULT_MAX_BACKOFF_MS = 120_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CARELINK_LOGIN_TIMEOUT_MS = 120_000;
const DEFAULT_CARELINK_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_NIGHTSCOUT_UPLOAD_TIMEOUT_MS = 15_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function defaultWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  timeoutError: BridgeError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createConsoleRuntimeLogger(): RuntimeLogger {
  function write(level: 'log' | 'warn' | 'error', message: string, fields?: SafeLogFields): void {
    const renderedFields = fields
      ? Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      : '';
    const line = renderedFields ? `[Bridge] ${message} ${renderedFields}` : `[Bridge] ${message}`;
    console[level](line);
  }

  return {
    info: (message, fields) => write('log', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

export class BridgeRuntime {
  private readonly logger: RuntimeLogger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly withTimeout: <T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    timeoutError: BridgeError,
  ) => Promise<T>;
  private readonly sgvFilter: CommitRecencyFilter<NightscoutSGVEntry>;
  private readonly deviceStatusFilter: CommitRecencyFilter<NightscoutDeviceStatus>;
  private stopped = false;
  private stoppingReason = 'completed';
  private inCycle = false;
  private cycle = 0;
  private backoffFailures = 0;
  private lastSuccessAt: string | undefined;

  constructor(
    private readonly dependencies: BridgeRuntimeDependencies,
    private readonly options: BridgeRuntimeOptions,
  ) {
    this.logger = dependencies.logger ?? createConsoleRuntimeLogger();
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.withTimeout = dependencies.withTimeout ?? defaultWithTimeout;
    this.sgvFilter = dependencies.sgvFilter
      ?? makeCommitRecencyFilter<NightscoutSGVEntry>(item => item.date);
    this.deviceStatusFilter = dependencies.deviceStatusFilter
      ?? makeCommitRecencyFilter<NightscoutDeviceStatus>(
        item => new Date(item.created_at).getTime(),
      );
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.logger.info('bridge started', {
      intervalSec: Math.round(this.options.intervalMs / 1000),
      heartbeatSec: Math.round(this.heartbeatIntervalMs / 1000),
    });

    while (!this.stopped) {
      this.cycle += 1;

      try {
        await this.runCycleWithRetries(this.cycle);
      } catch (error) {
        const details = safeErrorDetails(error);
        this.logger.error('bridge stopping after non-recoverable error', {
          category: details.category,
          httpStatus: details.httpStatus,
          code: details.code,
          lastSuccessAt: this.lastSuccessAt,
        });
        this.stop('non-recoverable-error');
        break;
      }

      if (!this.stopped) {
        await this.waitWithHeartbeat(this.options.intervalMs);
      }
    }

    this.logger.info('bridge stopped', {
      reason: this.stoppingReason,
      lastSuccessAt: this.lastSuccessAt,
      cycles: this.cycle,
    });
  }

  stop(reason = 'requested'): void {
    this.stopped = true;
    this.stoppingReason = reason;
  }

  async runCycleForTest(cycle = 1): Promise<CycleResult> {
    return this.runCycleWithRetries(cycle);
  }

  private get heartbeatIntervalMs(): number {
    return this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  private get maxRetries(): number {
    return this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private nextBackoffMs(): number {
    const schedule = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const base = schedule[Math.min(this.backoffFailures, schedule.length - 1)] ?? schedule[0];
    const capped = Math.min(base, max);
    const jitterRatio = this.options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const jitter = 1 - jitterRatio + this.random() * jitterRatio * 2;
    this.backoffFailures += 1;
    return Math.min(max, Math.max(0, Math.round(capped * jitter)));
  }

  private resetBackoff(): void {
    this.backoffFailures = 0;
  }

  private async runCycleWithRetries(cycle: number): Promise<CycleResult> {
    let lastResult: CycleResult | undefined;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      try {
        const result = await this.executeCycle(cycle, attempt);
        this.resetBackoff();
        return result;
      } catch (error) {
        const bridgeError = error instanceof BridgeError
          ? error
          : new BridgeError('Unexpected runtime error', {
            category: 'UNEXPECTED_RUNTIME_ERROR',
            recoverable: false,
            cause: error,
          });
        const details = safeErrorDetails(bridgeError);

        this.logger.warn('cycle failed', {
          cycle,
          attempt,
          category: details.category,
          recoverable: details.recoverable,
          httpStatus: details.httpStatus,
          code: details.code,
        });

        if (!bridgeError.recoverable) {
          throw bridgeError;
        }

        if (attempt > this.maxRetries) {
          this.logger.warn('cycle deferred until next interval', {
            cycle,
            category: details.category,
          });
          return lastResult ?? this.emptyCycleResult(cycle, attempt);
        }

        const backoffMs = this.nextBackoffMs();
        this.logger.warn('retry scheduled', {
          cycle,
          attempt,
          category: details.category,
          retryInSec: Math.round(backoffMs / 1000),
          nextRetryAt: new Date(this.now() + backoffMs).toISOString(),
        });
        await this.waitWithHeartbeat(backoffMs);
      }
    }

    return lastResult ?? this.emptyCycleResult(cycle, this.maxRetries + 1);
  }

  private async executeCycle(cycle: number, attempt: number): Promise<CycleResult> {
    if (this.inCycle) {
      throw new BridgeError('Overlapping polling cycle prevented', {
        category: 'UNEXPECTED_RUNTIME_ERROR',
        recoverable: false,
      });
    }

    this.inCycle = true;
    this.logger.info('cycle started', { cycle, attempt });

    try {
      const data = await this.fetchCareLinkDataWithRecovery(cycle);
      this.assertValidCareLinkData(data);

      const transformed = this.dependencies.transformData(data, this.options.sgvLimit);
      const entriesReceived = Array.isArray(data.sgs) ? data.sgs.length : 0;
      const sgvsValid = transformed.entries.length;
      const deviceStatusesValid = transformed.devicestatus.length;
      const newSgvs = this.sgvFilter.select(transformed.entries);
      const newDeviceStatuses = this.deviceStatusFilter.select(transformed.devicestatus);

      this.logger.info('fetch succeeded', {
        cycle,
        receivedRecords: entriesReceived,
        validSgvs: sgvsValid,
        validDeviceStatuses: deviceStatusesValid,
        newSgvs: newSgvs.length,
        skippedDuplicateSgvs: Math.max(0, sgvsValid - newSgvs.length),
        newDeviceStatuses: newDeviceStatuses.length,
        skippedDuplicateDeviceStatuses: Math.max(0, deviceStatusesValid - newDeviceStatuses.length),
      });

      await this.uploadIfNew('entries', newSgvs, this.options.entriesUrl, this.sgvFilter, cycle);
      await this.uploadIfNew(
        'devicestatus',
        newDeviceStatuses,
        this.options.deviceStatusUrl,
        this.deviceStatusFilter,
        cycle,
      );

      this.lastSuccessAt = new Date(this.now()).toISOString();
      this.logger.info('cycle completed', { cycle, lastSuccessAt: this.lastSuccessAt });

      return {
        cycle,
        attempts: attempt,
        success: true,
        entriesReceived,
        sgvsValid,
        sgvsNew: newSgvs.length,
        sgvsSkippedDuplicate: Math.max(0, sgvsValid - newSgvs.length),
        deviceStatusesValid,
        deviceStatusesNew: newDeviceStatuses.length,
        deviceStatusesSkippedDuplicate: Math.max(0, deviceStatusesValid - newDeviceStatuses.length),
        lastSuccessAt: this.lastSuccessAt,
      };
    } finally {
      this.inCycle = false;
    }
  }

  private async fetchCareLinkDataWithRecovery(cycle: number): Promise<CareLinkData> {
    try {
      return await this.withTimeout(
        this.dependencies.fetchCareLinkData,
        this.options.careLinkFetchTimeoutMs ?? DEFAULT_CARELINK_FETCH_TIMEOUT_MS,
        new BridgeError('CareLink fetch timed out', {
          category: 'CARELINK_FETCH_TIMEOUT',
          recoverable: true,
          code: 'ETIMEDOUT',
        }),
      );
    } catch (error) {
      const classified = classifyCareLinkError(error);
      if (!isCareLinkAuthCategory(classified.category) || !this.dependencies.reauthenticateCareLink) {
        throw classified;
      }

      this.logger.warn('carelink session recovery started', {
        cycle,
        category: classified.category,
        httpStatus: classified.httpStatus,
      });

      try {
        await this.withTimeout(
          this.dependencies.reauthenticateCareLink,
          this.options.careLinkLoginTimeoutMs ?? DEFAULT_CARELINK_LOGIN_TIMEOUT_MS,
          new BridgeError('CareLink reauthentication timed out', {
            category: 'CARELINK_AUTH_FAILED',
            recoverable: false,
            code: 'ETIMEDOUT',
          }),
        );
      } catch (reauthError) {
        const classifiedReauthError = classifyCareLinkError(reauthError);
        if (!isCareLinkAuthCategory(classifiedReauthError.category)) {
          throw classifiedReauthError;
        }

        const details = safeErrorDetails(classifiedReauthError);
        throw new BridgeError('CareLink reauthentication failed', {
          category: 'CARELINK_AUTH_FAILED',
          recoverable: false,
          httpStatus: details.httpStatus,
          code: details.code,
          cause: reauthError,
        });
      }

      this.logger.info('carelink session recovery completed', { cycle });

      try {
        return await this.withTimeout(
          this.dependencies.fetchCareLinkData,
          this.options.careLinkFetchTimeoutMs ?? DEFAULT_CARELINK_FETCH_TIMEOUT_MS,
          new BridgeError('CareLink fetch timed out', {
            category: 'CARELINK_FETCH_TIMEOUT',
            recoverable: true,
            code: 'ETIMEDOUT',
          }),
        );
      } catch (retryError) {
        const retryClassified = classifyCareLinkError(retryError);
        if (isCareLinkAuthCategory(retryClassified.category)) {
          throw new BridgeError('CareLink authentication failed after recovery', {
            category: 'CARELINK_AUTH_FAILED',
            recoverable: false,
            httpStatus: retryClassified.httpStatus,
            code: retryClassified.code,
            cause: retryError,
          });
        }
        throw retryClassified;
      }
    }
  }

  private assertValidCareLinkData(data: CareLinkData): void {
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray(data.sgs) ||
      data.lastMedicalDeviceDataUpdateServerTime === undefined
    ) {
      throw new BridgeError('CareLink response missed expected fields', {
        category: 'CARELINK_INVALID_RESPONSE',
        recoverable: true,
      });
    }
  }

  private async uploadIfNew<T>(
    endpointName: 'entries' | 'devicestatus',
    items: T[],
    endpoint: string,
    filter: CommitRecencyFilter<T>,
    cycle: number,
  ): Promise<void> {
    if (items.length === 0) {
      this.logger.info('upload skipped', { cycle, endpoint: endpointName, reason: 'no-new-records' });
      return;
    }

    try {
      await this.withTimeout(
        () => this.dependencies.upload(items, endpoint),
        this.options.nightscoutUploadTimeoutMs ?? DEFAULT_NIGHTSCOUT_UPLOAD_TIMEOUT_MS,
        new BridgeError('Nightscout upload timed out', {
          category: 'NIGHTSCOUT_UPLOAD_FAILED',
          recoverable: true,
          code: 'ETIMEDOUT',
        }),
      );
      filter.commit(items);
      this.logger.info('upload succeeded', { cycle, endpoint: endpointName, uploadedRecords: items.length });
    } catch (error) {
      throw classifyNightscoutError(error);
    }
  }

  private async waitWithHeartbeat(ms: number): Promise<void> {
    let remaining = ms;

    while (!this.stopped && remaining > 0) {
      const chunk = Math.min(remaining, this.heartbeatIntervalMs);
      await this.sleep(chunk);
      remaining -= chunk;

      if (!this.stopped && remaining > 0) {
        this.logger.info('heartbeat', {
          lastSuccessAt: this.lastSuccessAt,
          nextCheckInSec: Math.round(remaining / 1000),
        });
      }
    }
  }

  private emptyCycleResult(cycle: number, attempts: number): CycleResult {
    return {
      cycle,
      attempts,
      success: false,
      entriesReceived: 0,
      sgvsValid: 0,
      sgvsNew: 0,
      sgvsSkippedDuplicate: 0,
      deviceStatusesValid: 0,
      deviceStatusesNew: 0,
      deviceStatusesSkippedDuplicate: 0,
      lastSuccessAt: this.lastSuccessAt,
    };
  }
}
