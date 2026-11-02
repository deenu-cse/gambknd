export const ErrorCodes = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  INVALID_REFRESH_TOKEN: 401,
  REFRESH_TOKEN_REUSED: 401,
  TOTP_REQUIRED: 401,
  TOTP_INVALID: 401,
  FORBIDDEN: 403,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_SELF_EXCLUDED: 403,
  ACCOUNT_IN_COOLDOWN: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  EMAIL_TAKEN: 409,
  REFRESH_CONFLICT: 409,
  DUPLICATE_REQUEST: 409,
  ODDS_CHANGED: 409,
  QUOTE_EXPIRED: 409,
  INSUFFICIENT_BALANCE: 422,
  MARKET_SUSPENDED: 422,
  MARKET_CLOSED: 422,
  SELECTION_INACTIVE: 422,
  STAKE_LIMIT: 422,
  LIABILITY_LIMIT: 422,
  RESPONSIBLE_PLAY_LIMIT: 422,
  BONUS_NOT_AVAILABLE: 422,
  SELF_ACTION_FORBIDDEN: 422,
  INVALID_STATE: 422,
  CASHOUT_UNAVAILABLE: 422,
  BET_REJECTED: 422,
  ACCOUNT_LOCKED: 423,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PROVIDER_UNAVAILABLE: 502,
  SERVICE_UNAVAILABLE: 503,
  MAINTENANCE_MODE: 503,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ErrorCodes[code];
    this.details = details;
  }

  static notFound(what = 'Resource'): AppError {
    return new AppError('NOT_FOUND', `${what} not found`);
  }

  static forbidden(message = 'You do not have permission to do that'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError('BAD_REQUEST', message, details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
