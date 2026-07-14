import crypto from 'node:crypto';
import axios from 'axios';

export async function assertNightscoutEndpoint(baseUrl: string, secret: string): Promise<void> {
  const statusUrl = baseUrl.replace(/\/+$/, '') + '/api/v1/status.json';
  const hashedSecret = crypto.createHash('sha1').update(secret).digest('hex');

  try {
    const response = await axios.get(statusUrl, {
      headers: { 'api-secret': hashedSecret },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (response.status === 401 || response.status === 403) {
      const authenticate = String(response.headers['www-authenticate'] ?? '');
      if (/basic/i.test(authenticate)) {
        throw new Error('Nightscout route returned Basic Auth instead of the Nightscout API');
      }
      return;
    }

    if (response.status !== 200) {
      throw new Error(`Nightscout status endpoint returned HTTP ${response.status}`);
    }

    const payload = response.data;
    if (!payload || (typeof payload === 'object' && !payload.version && !payload.settings)) {
      throw new Error('Nightscout status endpoint did not look like Nightscout');
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
      throw new Error('Nightscout HTTPS certificate is not trusted');
    }

    if (error instanceof Error) {
      throw new Error(`Nightscout preflight failed: ${error.message}`);
    }

    throw new Error('Nightscout preflight failed');
  }
}
