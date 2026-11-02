import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Route not found'));

/** Converts every error into a consistent JSON body. Internal details never reach the client. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = res.locals.requestId as string | undefined;
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'validation_failed',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
          requestId,
        },
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
      return;
    }
    // body-parser errors (malformed JSON, payload too large)
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      res.status(status).json({
        error: { code: err.type === 'entity.too.large' ? 'payload_too_large' : 'bad_request', message: 'Malformed request', requestId },
      });
      return;
    }
    logger.error({ err: { name: err?.name, message: err?.message, stack: err?.stack }, requestId, path: req.path }, 'Unhandled error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error', requestId } });
  };
}
