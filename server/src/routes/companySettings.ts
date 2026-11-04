import express, { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/pool.js';
import { parseBody } from '../http/validate.js';
import { auditContext, diffFields, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { AppConfig } from '../config.js';
import type { FileStorage } from '../storage/storage.js';
import { sendStoredFile, storeUpload } from '../storage/files.js';
import { notFound } from '../http/errors.js';

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Empty strings become null so optional identifiers can be cleared. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const optPattern = (re: RegExp, message: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || re.test(v), { message });

/** Editable company identity. The product name (Fleetora) is intentionally not part of this. */
export const CompanySettingsBody = z
  .object({
    legalName: z.string().trim().max(200),
    tradeName: z.string().trim().max(200),
    // Morocco: ICE is a 15-digit Identifiant Commun de l'Entreprise.
    ice: optPattern(/^\d{15}$/, 'ICE must be exactly 15 digits'),
    ifNumber: optPattern(/^\d{1,15}$/, 'IF must contain digits only'),
    rcNumber: optText(50),
    rcCity: optText(100),
    patente: optText(50),
    addressLine: optText(300),
    city: optText(100),
    postalCode: optText(20),
    countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default('MA'),
    phone: optPattern(/^\+?[0-9 ().-]{6,30}$/, 'Invalid phone number'),
    phone2: optPattern(/^\+?[0-9 ().-]{6,30}$/, 'Invalid phone number'),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || z.email().safeParse(v).success, { message: 'Invalid email address' }),
    website: optPattern(/^https?:\/\/[^\s]{1,240}$/i, 'Website must start with http:// or https://'),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('MAD'),
    timezone: z.string().trim().max(64).refine(isValidTimeZone, { message: 'Unknown time zone' }).default('Africa/Casablanca'),
    defaultLanguage: z.enum(['fr', 'ar']).default('fr'),
    documentLanguages: z
      .array(z.enum(['fr', 'ar']))
      .min(1)
      .max(2)
      .transform((a) => [...new Set(a)])
      .default(['fr', 'ar']),
    brandPrimaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Colour must be #RRGGBB').default('#1F4E79'),
    showCompanyBranding: z.boolean().default(true),
    documentHeaderText: optText(1000),
    documentFooterText: optText(1000),
    signatoryName: optText(120),
    signatoryTitle: optText(120),
    // Rental rules (owner answers 2026-11-04)
    minDriverAge: z.number().int().min(16).max(99).default(18),
    newLicenceYears: z.number().int().min(0).max(10).default(2),
    maxContractDays: z.number().int().min(1).max(366).default(30),
    lateGraceMinutes: z.number().int().min(0).max(1440).default(60),
  })
  .strict();

type Settings = z.infer<typeof CompanySettingsBody>;

const SELECT = `
  SELECT legal_name, trade_name, logo_storage_key, ice, if_number, rc_number, rc_city, patente,
         address_line, city, postal_code, country_code, phone, email, website, currency, timezone,
         default_language, document_languages, brand_primary_color, show_company_branding,
         document_header_text, document_footer_text, signatory_name, signatory_title,
         phone2, min_driver_age, new_licence_years, max_contract_days, late_grace_minutes, logo_file_id,
         updated_at, updated_by
    FROM company_settings WHERE id = 1`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDto(r: any) {
  const settings: Settings = {
    legalName: r.legal_name,
    tradeName: r.trade_name,
    ice: r.ice,
    ifNumber: r.if_number,
    rcNumber: r.rc_number,
    rcCity: r.rc_city,
    patente: r.patente,
    addressLine: r.address_line,
    city: r.city,
    postalCode: r.postal_code,
    countryCode: r.country_code,
    phone: r.phone,
    phone2: r.phone2,
    email: r.email,
    website: r.website,
    currency: r.currency,
    timezone: r.timezone,
    defaultLanguage: r.default_language,
    documentLanguages: r.document_languages,
    brandPrimaryColor: r.brand_primary_color,
    showCompanyBranding: r.show_company_branding,
    documentHeaderText: r.document_header_text,
    documentFooterText: r.document_footer_text,
    signatoryName: r.signatory_name,
    signatoryTitle: r.signatory_title,
    minDriverAge: r.min_driver_age,
    newLicenceYears: r.new_licence_years,
    maxContractDays: r.max_contract_days,
    lateGraceMinutes: r.late_grace_minutes,
  };
  return {
    settings,
    logo: { configured: Boolean(r.logo_file_id), fileId: (r.logo_file_id as string | null) ?? null },
    updatedAt: r.updated_at as Date,
    updatedBy: r.updated_by as string | null,
  };
}

export function companySettingsRouter(db: Db, config: AppConfig, storage: FileStorage): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: config.maxUploadBytes });

  r.get('/', requirePermission(db, 'company_settings.read'), async (_req, res) => {
    const { rows } = await db.query(SELECT);
    res.json(toDto(rows[0]));
  });

  r.put('/', requirePermission(db, 'company_settings.update'), async (req, res) => {
    const s = parseBody(CompanySettingsBody, req);
    const result = await withTransaction(db, async (tx) => {
      const { rows: beforeRows } = await tx.query(`${SELECT} FOR UPDATE`);
      const before = toDto(beforeRows[0]).settings;
      await tx.query(
        `UPDATE company_settings SET
           legal_name = $1, trade_name = $2, ice = $3, if_number = $4, rc_number = $5, rc_city = $6,
           patente = $7, address_line = $8, city = $9, postal_code = $10, country_code = $11, phone = $12,
           email = $13, website = $14, currency = $15, timezone = $16, default_language = $17,
           document_languages = $18, brand_primary_color = $19, show_company_branding = $20,
           document_header_text = $21, document_footer_text = $22, signatory_name = $23,
           signatory_title = $24, updated_at = now(), updated_by = $25, phone2 = $26, min_driver_age = $27,
           new_licence_years = $28, max_contract_days = $29, late_grace_minutes = $30
         WHERE id = 1`,
        [
          s.legalName, s.tradeName, s.ice, s.ifNumber, s.rcNumber, s.rcCity, s.patente, s.addressLine,
          s.city, s.postalCode, s.countryCode, s.phone, s.email, s.website, s.currency, s.timezone,
          s.defaultLanguage, s.documentLanguages, s.brandPrimaryColor, s.showCompanyBranding,
          s.documentHeaderText, s.documentFooterText, s.signatoryName, s.signatoryTitle,
          res.locals.auth!.user.id, s.phone2, s.minDriverAge, s.newLicenceYears, s.maxContractDays, s.lateGraceMinutes,
        ],
      );
      const { rows } = await tx.query(SELECT);
      const after = toDto(rows[0]);
      const changes = diffFields(before as Record<string, unknown>, after.settings as Record<string, unknown>);
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'company_settings.update',
        targetType: 'company_settings',
        targetId: '1',
        metadata: { changedFields: Object.keys(changes), changes },
      });
      return after;
    });
    res.json(result);
  });

  /** Company logo for the app and the printed contract (PNG, JPEG or WebP). Replacing keeps the old file. */
  r.put('/logo', requirePermission(db, 'company_settings.update'), raw, async (req, res) => {
    const auth = res.locals.auth!;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await withTransaction(db, async (tx) => {
      const before = (await tx.query<{ logo_file_id: string | null }>('SELECT logo_file_id FROM company_settings WHERE id = 1 FOR UPDATE')).rows[0];
      const file = await storeUpload(tx, storage, bytes, {
        declaredType: req.get('content-type'),
        originalName: req.get('x-file-name'),
        userId: auth.user.id,
        allowed: ['image/png', 'image/jpeg', 'image/webp'],
      });
      await tx.query('UPDATE company_settings SET logo_file_id = $1, logo_storage_key = $2, updated_at = now(), updated_by = $3 WHERE id = 1', [
        file.id,
        `${file.sha256.slice(0, 2)}/${file.sha256}`,
        auth.user.id,
      ]);
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'company_settings.logo',
        targetType: 'company_settings',
        targetId: '1',
        metadata: { fileId: file.id, previousFileId: before?.logo_file_id ?? null },
      });
      return toDto((await tx.query(SELECT)).rows[0]);
    });
    res.json(result);
  });

  r.get('/logo', requirePermission(db, 'company_settings.read'), async (_req, res) => {
    const { rows } = await db.query<{ storage_key: string; mime_type: string; size_bytes: number; original_name: string | null }>(
      `SELECT f.storage_key, f.mime_type, f.size_bytes, f.original_name
         FROM company_settings s JOIN stored_files f ON f.id = s.logo_file_id WHERE s.id = 1`,
    );
    if (!rows[0]) throw notFound('No logo');
    await sendStoredFile(res, storage, rows[0]);
  });

  return r;
}
