import crypto from 'node:crypto';
import axios from 'axios';
import { BridgeError, classifyNightscoutError } from '../errors.js';

export interface NightscoutWatermarks {
  entriesLastTime: number;
  deviceStatusLastTime: number;
}

export interface NightscoutWatermarkOptions {
  timeoutMs?: number;
}

export async function readNightscoutWatermarks(
  baseUrl: string,
  secret: string,
  options: NightscoutWatermarkOptions = {},
): Promise<NightscoutWatermarks> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const hashedSecret = crypto.createHash('sha1').update(secret).digest('hex');
  const timeout = options.timeoutMs ?? 10_000;

  const [entriesLastTime, deviceStatusLastTime] = await Promise.all([
    readLatestTime(
      `${normalizedBaseUrl}/api/v1/entries/sgv.json?count=1`,
      hashedSecret,
      timeout,
      latestEntryTime,
    ),
    readLatestTime(
      `${normalizedBaseUrl}/api/v1/devicestatus.json?count=1`,
      hashedSecret,
      timeout,
      latestDeviceStatusTime,
    ),
  ]);

  return { entriesLastTime, deviceStatusLastTime };
}

async function readLatestTime(
  url: string,
  hashedSecret: string,
  timeout: number,
  timeFn: (item: unknown) => number,
): Promise<number> {
  const response = await axios.get<unknown[]>(url, {
    headers: { 'api-secret': hashedSecret },
    timeout,
    validateStatus: () => true,
  }).catch(error => {
    throw classifyNightscoutError(error);
  });

  if (response.status !== 200) {
    throw new BridgeError('Nightscout watermark lookup failed', {
      category: 'NIGHTSCOUT_UPLOAD_FAILED',
      recoverable: response.status === 429 || response.status >= 500,
      httpStatus: response.status,
    });
  }

  if (!Array.isArray(response.data) || response.data.length === 0) {
    return 0;
  }

  return Math.max(0, ...response.data.map(timeFn).filter(Number.isFinite));
}

function latestEntryTime(item: unknown): number {
  if (!item || typeof item !== 'object') return 0;
  const record = item as Record<string, unknown>;
  if (typeof record['date'] === 'number') return record['date'];
  if (typeof record['dateString'] === 'string') return Date.parse(record['dateString']);
  return 0;
}

function latestDeviceStatusTime(item: unknown): number {
  if (!item || typeof item !== 'object') return 0;
  const record = item as Record<string, unknown>;
  if (typeof record['created_at'] === 'string') return Date.parse(record['created_at']);
  if (typeof record['mills'] === 'number') return record['mills'];
  return 0;
}
