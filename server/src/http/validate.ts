import type { Request } from 'express';
import type { z } from 'zod';

/** Parses and returns a typed copy of the body. Throws ZodError (→ 400) on failure. */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.body ?? {});
}

export function parseQuery<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.query ?? {});
}

export function parseParams<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.params ?? {});
}
