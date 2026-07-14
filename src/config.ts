import type { Config } from './types/config.js';

function readEnv(key: string, defaultVal?: string): string | boolean | null | undefined {
  let val: string | undefined =
    process.env[key] ||
    process.env[key.toLowerCase()] ||
    process.env['CUSTOMCONNSTR_' + key] ||
    process.env['CUSTOMCONNSTR_' + key.toLowerCase()];

  if (val === 'true') return true as unknown as string;
  if (val === 'false') return false as unknown as string;
  if (val === 'null') return null;

  return val !== undefined ? val : defaultVal;
}

function readEnvString(key: string, defaultVal?: string): string | undefined {
  const val = readEnv(key, defaultVal);
  if (val === null || val === undefined) return defaultVal;
  return String(val);
}

function readEnvBool(key: string, defaultVal: boolean): boolean {
  const val = readEnv(key);
  if (val === true || val === false) return val as unknown as boolean;
  if (val === undefined || val === null) return defaultVal;
  return Boolean(val);
}

function readEnvInt(key: string, defaultVal: number): number {
  const parsed = parseInt(readEnvString(key, String(defaultVal))!, 10);
  return Number.isFinite(parsed) ? parsed : defaultVal;
}

function readEnvSeconds(key: string, defaultSeconds: number): number {
  const raw = readEnvString(key, String(defaultSeconds));
  const parsed = parseInt(raw!, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultSeconds * 1000;
  return parsed * 1000;
}

export function loadConfig(): Config {
  const username = readEnvString('CARELINK_USERNAME');
  const password = readEnvString('CARELINK_PASSWORD');
  const nsSecret = readEnvString('API_SECRET');

  if (!username) throw new Error('Missing CARELINK_USERNAME');
  if (!password) throw new Error('Missing CARELINK_PASSWORD');
  if (!nsSecret) throw new Error('Missing API_SECRET');

  const defaultIntervalSeconds = 300;

  return {
    username,
    password,
    nsHost: readEnvString('WEBSITE_HOSTNAME'),
    nsBaseUrl: readEnvString('NS'),
    nsSecret,
    interval: readEnvSeconds('CARELINK_INTERVAL', defaultIntervalSeconds),
    sgvLimit: readEnvInt('CARELINK_SGV_LIMIT', 24),
    maxRetryDuration: readEnvInt('CARELINK_MAX_RETRY_DURATION', 512),
    maxRetries: readEnvInt('CARELINK_MAX_RETRIES', 3),
    heartbeatInterval: readEnvSeconds('CARELINK_HEARTBEAT_INTERVAL', 60),
    careLinkLoginTimeout: readEnvSeconds('CARELINK_LOGIN_TIMEOUT', 120),
    careLinkFetchTimeout: readEnvSeconds('CARELINK_FETCH_TIMEOUT', 30),
    nightscoutPreflightTimeout: readEnvSeconds('NIGHTSCOUT_PREFLIGHT_TIMEOUT', 10),
    nightscoutUploadTimeout: readEnvSeconds('NIGHTSCOUT_UPLOAD_TIMEOUT', 15),
    verbose: !readEnvBool('CARELINK_QUIET', true),
    patientId: readEnvString('CARELINK_PATIENT'),
    countryCode: readEnvString('MMCONNECT_COUNTRYCODE', 'gb')!,
    language: readEnvString('MMCONNECT_LANGCODE', 'en')!,
  };
}
