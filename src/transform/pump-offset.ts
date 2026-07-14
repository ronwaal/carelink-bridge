import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';

let lastGuess: string | undefined;

export function guessPumpOffset(data: CareLinkData): string {
  const pumpTimeAsIfUTC = Date.parse(data.sMedicalDeviceTime ?? '');
  const serverTimeUTC = data.currentServerTime;
  if (!Number.isFinite(pumpTimeAsIfUTC) || !Number.isFinite(serverTimeUTC)) {
    return '+0000';
  }
  const hours = Math.round((pumpTimeAsIfUTC - serverTimeUTC) / (60 * 60 * 1000));
  const offset =
    (hours >= 0 ? '+' : '-') +
    (Math.abs(hours) < 10 ? '0' : '') +
    Math.abs(hours) +
    '00';

  if (offset !== lastGuess) {
    logger.log(
      'Guessed pump timezone ' + offset +
      ' (pump time: "' + data.sMedicalDeviceTime +
      '"; server time: ' + new Date(data.currentServerTime) + ')'
    );
  }
  lastGuess = offset;
  return offset;
}

export function guessPumpOffsetMilliseconds(data: CareLinkData): number {
  const pumpTimeAsIfUTC = Date.parse(data.sMedicalDeviceTime ?? '');
  const serverTimeUTC = data.currentServerTime;
  if (!Number.isFinite(pumpTimeAsIfUTC) || !Number.isFinite(serverTimeUTC)) {
    return 0;
  }
  const raw = pumpTimeAsIfUTC - serverTimeUTC;
  return Math.round(raw / (60 * 60 * 1000)) * (60 * 60 * 1000);
}
