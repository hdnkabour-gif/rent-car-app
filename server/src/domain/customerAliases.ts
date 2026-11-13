import type { Queryable } from '../db/pool.js';
import { AppError } from '../http/errors.js';

/**
 * Logical customer links preserve historical IDs. For NEW bookings, the non-canonical
 * record must never be used, and a block on ANY linked record must remain effective.
 * The manager must investigate the records and correct a mistaken link explicitly.
 */
export async function assertCustomerIdentityNotAliasedOrBlocked(db: Queryable, customerId: string): Promise<void> {
  const { rows } = await db.query<{ canonical_customer_id: string }>(
    `SELECT canonical_customer_id FROM customer_merge_links
       WHERE source_customer_id=$1 AND status='active' LIMIT 1`,
    [customerId],
  );
  if (rows[0]) {
    throw new AppError(409,'customer_record_linked',
      'Use the canonical customer record before preparing or checking out a rental',
      { canonicalCustomerId: rows[0].canonical_customer_id });
  }
  const blocked = await db.query(
    `SELECT 1 FROM customer_merge_links l JOIN customers c ON c.id=l.source_customer_id
       WHERE l.canonical_customer_id=$1 AND l.status='active'
         AND c.blocked_at IS NOT NULL LIMIT 1`,[customerId],
  );
  if (blocked.rowCount) {
    throw new AppError(409,'customer_blocked',
      'A linked customer record is blocked; review this identity before renting');
  }
}
