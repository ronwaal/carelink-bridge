import crypto from 'node:crypto';
import axios from 'axios';
import * as logger from '../logger.js';
import { BridgeError } from '../errors.js';

export interface UploadOptions {
  timeoutMs?: number;
}

export async function upload(
  entries: unknown[],
  endpoint: string,
  secret: string,
  options: UploadOptions = {},
): Promise<void> {
  logger.log('POST ' + endpoint + ' itemCount=' + entries.length);

  const hashedSecret = crypto.createHash('sha1').update(secret).digest('hex');

  const response = await axios.post(endpoint, entries, {
    headers: { 'api-secret': hashedSecret },
    timeout: options.timeoutMs ?? 15_000,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new BridgeError('Nightscout upload returned an unsuccessful status', {
      category: 'NIGHTSCOUT_UPLOAD_FAILED',
      recoverable: response.status === 429 || response.status >= 500,
      httpStatus: response.status,
    });
  }
}
