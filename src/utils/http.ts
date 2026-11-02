import type { Response } from 'express';
import { getContext } from './requestContext.js';
import type { ErrorCode } from './errors.js';

export interface ApiMeta {
  requestId?: string;
  page?: number;
  pageSize?: number;
  total?: number;
  nextCursor?: string | null;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
  meta: ApiMeta;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: { code: ErrorCode; message: string; details?: unknown };
  meta: ApiMeta;
}

function baseMeta(extra?: ApiMeta): ApiMeta {
  const requestId = getContext()?.requestId;
  return { ...(requestId ? { requestId } : {}), ...extra };
}

export function sendOk<T>(res: Response, data: T, meta?: ApiMeta, status = 200): void {
  const body: ApiSuccess<T> = { success: true, data, error: null, meta: baseMeta(meta) };
  res.status(status).json(body);
}

export function sendCreated<T>(res: Response, data: T, meta?: ApiMeta): void {
  sendOk(res, data, meta, 201);
}

export function failureBody(code: ErrorCode, message: string, details?: unknown): ApiFailure {
  return {
    success: false,
    data: null,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    meta: baseMeta(),
  };
}
