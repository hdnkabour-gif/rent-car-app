import { z } from 'zod';

/**
 * Explicit manager decision only. These fields are review annotations, not automatic
 * updates to a customer, car, reservation, payment, or signed contract.
 */
export const DocumentReviewPayload = z.object({
  status: z.enum(['approved', 'rejected']),
  fields: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/),
    z.string().trim().max(160),
  ).refine(v => Object.keys(v).length <= 24, 'Too many extracted fields'),
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().max(500).optional(),
}).strict().refine(
  v => v.status !== 'approved' || Object.values(v.fields).some(value => value.length > 0),
  { path: ['fields'], message: 'Approving requires at least one checked field' },
);
