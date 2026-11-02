import type { ResolvedSession } from '../auth/sessions.js';
import { forbidden } from '../http/errors.js';

/**
 * Branch scope: the ONE place that decides which branches a user may see or act in.
 * Every query on branch-owned records (vehicles now; reservations, contracts, cash later) must
 * go through it. null = all branches.
 */
export function branchScope(auth: ResolvedSession): string[] | null {
  return auth.permissions.includes('branches.all') ? null : auth.branchIds;
}

/** SQL fragment + params for "branch_id is in the user's scope". */
export function branchFilter(auth: ResolvedSession, column: string, params: unknown[]): string {
  const scope = branchScope(auth);
  if (scope === null) return 'TRUE';
  params.push(scope);
  return `${column} = ANY($${params.length}::uuid[])`;
}

export function assertBranchInScope(auth: ResolvedSession, branchId: string): void {
  const scope = branchScope(auth);
  if (scope !== null && !scope.includes(branchId)) throw forbidden('This branch is outside your assigned branches');
}
