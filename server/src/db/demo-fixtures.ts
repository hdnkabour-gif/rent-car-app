/**
 * The fictitious demo company shared by seed:dev (local) and seed:demo (hosted demo).
 * SYNTHETIC ONLY: example.test accounts, invented agencies, plates in the 9999x range.
 * Callers are responsible for their own safety checks BEFORE calling this.
 */
import { randomBytes } from 'node:crypto';
import type { DbClient } from './pool.js';
import { hashPassword } from '../auth/password.js';
import { plateKey } from '../domain/plates.js';

const accounts = [
  { email: 'manager@example.test', fullName: 'Gérant Démo', role: 'manager', branches: [] as string[] },
  { email: 'employe.casa@example.test', fullName: 'Sara Employée', role: 'employee', branches: ['CAS'] },
  { email: 'employe.rak@example.test', fullName: 'Youssef Employé', role: 'employee', branches: ['RAK'] },
];

const branches = [
  { code: 'CAS', name: 'Agence Démo Casablanca', city: 'Casablanca', address: '1 Boulevard Exemple', phone: '0522000000' },
  { code: 'RAK', name: 'Agence Démo Marrakech', city: 'Marrakech', address: '2 Avenue Exemple', phone: '0524000000' },
];

// [branch, plate, make, model, year, fuel, gearbox, km, target status]
const vehicles: Array<[string, string, string, string, number, string, string, number, string]> = [
  ['CAS', '99991-أ-1', 'Dacia', 'Logan', 2023, 'diesel', 'manual', 84250, 'available'],
  ['CAS', '99992-ب-1', 'Renault', 'Clio', 2022, 'petrol', 'manual', 61300, 'available'],
  ['CAS', '99993-د-1', 'Peugeot', '208', 2024, 'petrol', 'automatic', 12900, 'inspection_pending'],
  ['CAS', '99994-هـ-1', 'Dacia', 'Duster', 2023, 'diesel', 'manual', 45800, 'maintenance'],
  ['RAK', '99995-أ-2', 'Hyundai', 'Accent', 2022, 'diesel', 'manual', 73400, 'available'],
  ['RAK', '99996-ب-2', 'Kia', 'Picanto', 2023, 'petrol', 'manual', 28700, 'available'],
  ['RAK', '99997-و-2', 'Toyota', 'Corolla', 2021, 'hybrid', 'automatic', 102500, 'out_of_service'],
  ['RAK', '99998-ط-2', 'Fiat', 'Tipo', 2022, 'diesel', 'manual', 55100, 'inspection_pending'],
];

/** Inserts the fictitious company inside the caller's transaction. Returns lines to print once. */
export async function insertFictitiousCompany(tx: DbClient, passwordBytes = 9): Promise<string[]> {
  const printed: string[] = [];
  const branchIds = new Map<string, string>();
  for (const b of branches) {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO branches (code, name, city, address, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [b.code, b.name, b.city, b.address, b.phone],
    );
    branchIds.set(b.code, rows[0]!.id);
  }

  let managerId: string | undefined;
  for (const a of accounts) {
    const password = randomBytes(passwordBytes).toString('base64url');
    // Insert only: an existing account is left exactly as it is (no password reset, no reactivation).
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, full_name, role_code, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [a.email, a.fullName, a.role, await hashPassword(password)],
    );
    const id =
      rows[0]?.id ?? (await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [a.email])).rows[0]!.id;
    if (a.role === 'manager') managerId = id;
    for (const code of a.branches) {
      await tx.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, branchIds.get(code)]);
    }
    printed.push(
      rows[0]
        ? `${a.role.padEnd(8)} ${a.email.padEnd(28)} password: ${password}`
        : `${a.role.padEnd(8)} ${a.email.padEnd(28)} already existed: left unchanged`,
    );
  }

  for (const [code, plate, make, model, year, fuel, gearbox, km, target] of vehicles) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO vehicles (branch_id, plate, plate_key, make, model, model_year, fuel_type, transmission, seats, mileage_km, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5, $9, $10) RETURNING id`,
      [branchIds.get(code), plate, plateKey(plate), make, model, year, fuel, gearbox, km, managerId],
    );
    const id = rows[0]!.id;
    const step = async (from: string | null, to: string, reason: string | null, extra: { km?: number; fuel?: number } = {}) => {
      if (from) await tx.query('UPDATE vehicles SET status = $2, fuel_eighths = COALESCE($3, fuel_eighths) WHERE id = $1', [id, to, extra.fuel ?? null]);
      await tx.query(
        `INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, changed_by, reason, mileage_km, fuel_eighths, cleaned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, from, to, managerId, reason, extra.km ?? null, extra.fuel ?? null, from === 'inspection_pending' && to === 'available' ? true : null],
      );
    };
    await step(null, 'inspection_pending', null, { km });
    if (target === 'inspection_pending') continue;
    await step('inspection_pending', 'available', null, { km, fuel: 6 });
    if (target === 'maintenance') await step('available', 'maintenance', 'Vidange à 45 000 km (démo)');
    if (target === 'out_of_service') await step('available', 'out_of_service', 'Assurance expirée (démo)');
  }

  await tx.query(
    `UPDATE company_settings SET legal_name = 'Société Démo de Location SARL', trade_name = 'Démo Location', city = 'Casablanca'
      WHERE id = 1 AND legal_name = ''`,
  );
  return printed;
}
