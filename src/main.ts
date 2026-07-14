import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', 'my.env') });
dotenv.config();

import { loadConfig } from './config.js';
import { CareLinkClient } from './carelink/client.js';
import { transform } from './transform/index.js';
import { makeCommitRecencyFilter } from './filter.js';
import { upload } from './nightscout/upload.js';
import { assertNightscoutEndpoint } from './nightscout/preflight.js';
import { readNightscoutWatermarks } from './nightscout/watermark.js';
import * as logger from './logger.js';
import { login, LOGINDATA_FILE } from './login.js';
import {
  BridgeRuntime,
  createConsoleRuntimeLogger,
  defaultWithTimeout,
} from './runtime.js';
import { BridgeError, safeErrorDetails } from './errors.js';
import type {
  NightscoutDeviceStatus,
  NightscoutSGVEntry,
} from './types/nightscout.js';

const config = loadConfig();
logger.setVerbose(config.verbose);

const client = new CareLinkClient({
  username: config.username,
  password: config.password,
  maxRetryDuration: config.maxRetryDuration,
  patientId: config.patientId,
  countryCode: config.countryCode,
  lang: config.language,
});

const baseUrl = (config.nsBaseUrl || ('https://' + config.nsHost)).replace(/\/+$/, '');
const entriesUrl = baseUrl + '/api/v1/entries.json';
const devicestatusUrl = baseUrl + '/api/v1/devicestatus.json';
const runtimeLogger = createConsoleRuntimeLogger();
let runtime: BridgeRuntime | null = null;

async function ensureLogin(): Promise<void> {
  if (!fs.existsSync(LOGINDATA_FILE)) {
    console.log('[Bridge] No logindata.json found — starting login flow...');
    const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
    await defaultWithTimeout(
      () => login(isUS, config.username, config.password),
      config.careLinkLoginTimeout,
      new BridgeError('CareLink login timed out', {
        category: 'CARELINK_AUTH_FAILED',
        recoverable: false,
        code: 'ETIMEDOUT',
      }),
    );
    console.log('');
  }
}

async function createRuntime(): Promise<BridgeRuntime> {
  const watermarks = await loadNightscoutWatermarks();

  return new BridgeRuntime(
    {
      fetchCareLinkData: () => client.fetch(),
      reauthenticateCareLink: () => client.reauthenticate(),
      transformData: transform,
      upload: (items, endpoint) => upload(items, endpoint, config.nsSecret, {
        timeoutMs: config.nightscoutUploadTimeout,
      }),
      logger: runtimeLogger,
      sgvFilter: makeCommitRecencyFilter<NightscoutSGVEntry>(
        item => item.date,
        watermarks.entriesLastTime,
      ),
      deviceStatusFilter: makeCommitRecencyFilter<NightscoutDeviceStatus>(
        item => new Date(item.created_at).getTime(),
        watermarks.deviceStatusLastTime,
      ),
    },
    {
      intervalMs: config.interval,
      sgvLimit: config.sgvLimit,
      entriesUrl,
      deviceStatusUrl: devicestatusUrl,
      heartbeatIntervalMs: config.heartbeatInterval,
      maxRetries: config.maxRetries,
      careLinkLoginTimeoutMs: config.careLinkLoginTimeout,
      careLinkFetchTimeoutMs: config.careLinkFetchTimeout,
      nightscoutUploadTimeoutMs: config.nightscoutUploadTimeout,
    },
  );
}

async function loadNightscoutWatermarks(): Promise<{
  entriesLastTime: number;
  deviceStatusLastTime: number;
}> {
  try {
    const watermarks = await readNightscoutWatermarks(baseUrl, config.nsSecret, {
      timeoutMs: config.nightscoutPreflightTimeout,
    });
    runtimeLogger.info('nightscout watermark loaded', {
      entriesLastSeen: watermarks.entriesLastTime
        ? new Date(watermarks.entriesLastTime).toISOString()
        : 'none',
      deviceStatusLastSeen: watermarks.deviceStatusLastTime
        ? new Date(watermarks.deviceStatusLastTime).toISOString()
        : 'none',
    });
    return watermarks;
  } catch (error) {
    const details = safeErrorDetails(error);
    runtimeLogger.warn('nightscout watermark lookup unavailable', {
      category: details.category,
      httpStatus: details.httpStatus,
      code: details.code,
    });
    return { entriesLastTime: 0, deviceStatusLastTime: 0 };
  }
}

function stopRuntime(signal: NodeJS.Signals): void {
  console.log(`[Bridge] ${signal} received — stopping after current operation`);
  runtime?.stop(signal);
}

process.once('SIGINT', stopRuntime);
process.once('SIGTERM', stopRuntime);

process.once('unhandledRejection', error => {
  const details = safeErrorDetails(error);
  console.error('[Bridge] Fatal unhandledRejection', {
    category: details.category,
    httpStatus: details.httpStatus,
    code: details.code,
  });
  runtime?.stop('unhandledRejection');
  process.exitCode = 1;
});

process.once('uncaughtException', error => {
  const details = safeErrorDetails(error);
  console.error('[Bridge] Fatal uncaughtException', {
    category: details.category,
    httpStatus: details.httpStatus,
    code: details.code,
  });
  runtime?.stop('uncaughtException');
  process.exitCode = 1;
});

// Start
try {
  await ensureLogin();
  await assertNightscoutEndpoint(baseUrl, config.nsSecret, {
    timeoutMs: config.nightscoutPreflightTimeout,
  });
  runtime = await createRuntime();
  await runtime.start();
} catch (err) {
  const details = safeErrorDetails(err);
  console.error('[Bridge] Fatal startup error', {
    category: details.category,
    httpStatus: details.httpStatus,
    code: details.code,
  });
  process.exit(1);
}
