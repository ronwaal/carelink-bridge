export type ErrorCategory =
  | 'CARELINK_AUTH_EXPIRED'
  | 'CARELINK_AUTH_FAILED'
  | 'CARELINK_FETCH_TIMEOUT'
  | 'CARELINK_RATE_LIMITED'
  | 'CARELINK_INVALID_RESPONSE'
  | 'NIGHTSCOUT_UPLOAD_FAILED'
  | 'NETWORK_ERROR'
  | 'UNEXPECTED_RUNTIME_ERROR';

export interface BridgeErrorOptions {
  category: ErrorCategory;
  recoverable: boolean;
  httpStatus?: number;
  code?: string;
  cause?: unknown;
}

export class BridgeError extends Error {
  readonly category: ErrorCategory;
  readonly recoverable: boolean;
  readonly httpStatus?: number;
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(message: string, options: BridgeErrorOptions) {
    super(message);
    this.name = 'BridgeError';
    this.category = options.category;
    this.recoverable = options.recoverable;
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export interface SafeErrorDetails {
  category: ErrorCategory;
  recoverable: boolean;
  httpStatus?: number;
  code?: string;
  message: string;
}

const NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EPROTO',
  'ERR_NETWORK',
  'ERR_SOCKET_BAD_PORT',
  'ETIMEDOUT',
]);

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

function asRecord(error: unknown): Record<string, unknown> {
  return typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
}

export function getHttpStatus(error: unknown): number | undefined {
  const err = asRecord(error);
  const response = asRecord(err['response']);
  const status = response['status'];
  return typeof status === 'number' ? status : undefined;
}

export function getErrorCode(error: unknown): string | undefined {
  const err = asRecord(error);
  const cause = asRecord(err['cause']);
  const code = err['code'] ?? cause['code'];
  return typeof code === 'string' ? code : undefined;
}

export function classifyCareLinkError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;

  const httpStatus = getHttpStatus(error);
  const code = getErrorCode(error);

  if (httpStatus === 401 || (httpStatus !== undefined && httpStatus >= 300 && httpStatus < 400)) {
    return new BridgeError('CareLink session expired', {
      category: 'CARELINK_AUTH_EXPIRED',
      recoverable: true,
      httpStatus,
      code,
      cause: error,
    });
  }

  if (httpStatus === 403) {
    return new BridgeError('CareLink authentication failed', {
      category: 'CARELINK_AUTH_FAILED',
      recoverable: true,
      httpStatus,
      code,
      cause: error,
    });
  }

  if (httpStatus === 429) {
    return new BridgeError('CareLink rate limited the request', {
      category: 'CARELINK_RATE_LIMITED',
      recoverable: true,
      httpStatus,
      code,
      cause: error,
    });
  }

  if (code && TIMEOUT_CODES.has(code)) {
    return new BridgeError('CareLink fetch timed out', {
      category: 'CARELINK_FETCH_TIMEOUT',
      recoverable: true,
      httpStatus,
      code,
      cause: error,
    });
  }

  if ((code && NETWORK_CODES.has(code)) || (httpStatus !== undefined && httpStatus >= 500)) {
    return new BridgeError('CareLink network request failed', {
      category: 'NETWORK_ERROR',
      recoverable: true,
      httpStatus,
      code,
      cause: error,
    });
  }

  return new BridgeError('Unexpected CareLink runtime error', {
    category: 'UNEXPECTED_RUNTIME_ERROR',
    recoverable: false,
    httpStatus,
    code,
    cause: error,
  });
}

export function classifyNightscoutError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;

  const httpStatus = getHttpStatus(error);
  const code = getErrorCode(error);
  const recoverable =
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500) ||
    Boolean(code && (NETWORK_CODES.has(code) || TIMEOUT_CODES.has(code)));

  return new BridgeError('Nightscout upload failed', {
    category: 'NIGHTSCOUT_UPLOAD_FAILED',
    recoverable,
    httpStatus,
    code,
    cause: error,
  });
}

export function safeErrorDetails(error: unknown): SafeErrorDetails {
  const bridgeError = error instanceof BridgeError
    ? error
    : new BridgeError('Unexpected runtime error', {
      category: 'UNEXPECTED_RUNTIME_ERROR',
      recoverable: false,
      httpStatus: getHttpStatus(error),
      code: getErrorCode(error),
      cause: error,
    });

  const statusText = bridgeError.httpStatus ? `HTTP ${bridgeError.httpStatus}` : '';
  const codeText = bridgeError.code ? bridgeError.code : '';
  const suffix = [statusText, codeText].filter(Boolean).join(' ');

  return {
    category: bridgeError.category,
    recoverable: bridgeError.recoverable,
    httpStatus: bridgeError.httpStatus,
    code: bridgeError.code,
    message: suffix ? `${bridgeError.category} (${suffix})` : bridgeError.category,
  };
}

export function isCareLinkAuthCategory(category: ErrorCategory): boolean {
  return category === 'CARELINK_AUTH_EXPIRED' || category === 'CARELINK_AUTH_FAILED';
}
