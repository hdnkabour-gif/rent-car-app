import { Router } from 'express';
import { z } from 'zod';
import { type Db } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import { branchFilter } from '../domain/scope.js';

const TZ = 'Africa/Casablanca';
type Lang = 'fr' | 'ar' | 'en' | 'es';
type Kind = 'pickup' | 'return' | 'customer_document';

const fmt = (d: Date, lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : lang === 'en' ? 'en-GB' : lang === 'es' ? 'es-ES' : 'fr-MA', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: TZ,
  }).format(d);
const fmtDay = (ymd: string, lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : lang === 'en' ? 'en-GB' : lang === 'es' ? 'es-ES' : 'fr-MA', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));

const PLACE: Record<Lang, Record<string, string>> = {
  fr: { agency: 'à l’agence', airport: 'à l’aéroport', hotel: 'à votre hôtel', other: '' },
  ar: { agency: 'في الوكالة', airport: 'في المطار', hotel: 'في فندقكم', other: '' },
  en: { agency: 'at the agency', airport: 'at the airport', hotel: 'at your hotel', other: '' },
  es: { agency: 'en la agencia', airport: 'en el aeropuerto', hotel: 'en su hotel', other: '' },
};

/** Message templates per customer language (D-016: the employee reads and sends it himself). */
const T: Record<Kind, Record<Lang, (v: Record<string, string>) => string>> = {
  pickup: {
    fr: (v) => `Bonjour ${v.name}, ${v.company} vous rappelle votre location ${v.ref} : ${v.car}, le ${v.when} ${v.place}. Merci d’apporter votre pièce d’identité et votre permis.`,
    ar: (v) => `مرحباً ${v.name}، ${v.company} تذكّركم بحجزكم ${v.ref}: ${v.car}، يوم ${v.when} ${v.place}. المرجو إحضار وثيقة الهوية ورخصة السياقة.`,
    en: (v) => `Hello ${v.name}, ${v.company} reminds you of your rental ${v.ref}: ${v.car}, on ${v.when} ${v.place}. Please bring your ID and driving licence.`,
    es: (v) => `Hola ${v.name}, ${v.company} le recuerda su alquiler ${v.ref}: ${v.car}, el ${v.when} ${v.place}. Por favor traiga su documento de identidad y su permiso de conducir.`,
  },
  return: {
    fr: (v) => `Bonjour ${v.name}, ${v.company} vous rappelle le retour du véhicule ${v.car} (${v.ref}) prévu le ${v.when} ${v.place}. Merci et bonne route !`,
    ar: (v) => `مرحباً ${v.name}، ${v.company} تذكّركم بإرجاع السيارة ${v.car} (${v.ref}) المقرر يوم ${v.when} ${v.place}. شكراً وطريق السلامة!`,
    en: (v) => `Hello ${v.name}, ${v.company} reminds you that the vehicle ${v.car} (${v.ref}) is due back on ${v.when} ${v.place}. Thank you and safe travels!`,
    es: (v) => `Hola ${v.name}, ${v.company} le recuerda la devolución del vehículo ${v.car} (${v.ref}) prevista el ${v.when} ${v.place}. ¡Gracias y buen viaje!`,
  },
  customer_document: {
    fr: (v) => `Bonjour ${v.name}, ${v.company} : votre ${v.doc} expire le ${v.when}. Merci de nous présenter un document valide pour votre location du ${v.rental}.`,
    ar: (v) => `مرحباً ${v.name}، ${v.company}: ${v.doc} الخاصة بكم تنتهي يوم ${v.when}. المرجو تقديم وثيقة سارية لكرائكم يوم ${v.rental}.`,
    en: (v) => `Hello ${v.name}, ${v.company}: your ${v.doc} expires on ${v.when}. Please bring a valid document for your rental on ${v.rental}.`,
    es: (v) => `Hola ${v.name}, ${v.company}: su ${v.doc} caduca el ${v.when}. Por favor presente un documento válido para su alquiler del ${v.rental}.`,
  },
};
const DOC: Record<Lang, { licence: string; id: string }> = {
  fr: { licence: 'permis de conduire', id: 'pièce d’identité' },
  ar: { licence: 'رخصة السياقة', id: 'وثيقة الهوية' },
  en: { licence: 'driving licence', id: 'ID document' },
  es: { licence: 'permiso de conducir', id: 'documento de identidad' },
};

/** wa.me link with the message pre-filled. The server only builds the link; it never sends anything. */
export const waLink = (digits: string, text: string) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;

export function remindersRouter(db: Db): Router {
  const r = Router();

  r.get('/', requirePermission(db, 'reminders.send'), async (_req, res) => {
    const auth = res.locals.auth!;
    const s = (await db.query<{ trade_name: string; legal_name: string }>('SELECT trade_name, legal_name FROM company_settings WHERE id = 1')).rows[0];
    const company = s?.trade_name || s?.legal_name || 'Agence';
    const params: unknown[] = [];
    const scopeR = branchFilter(auth, 'r.branch_id', params);
    const reserv = await db.query(
      `SELECT r.id, r.number, r.start_at, r.end_at, r.pickup_place, r.pickup_details, c.id AS customer_id, c.full_name, c.phone, c.phone_key, c.phone2_key,
              c.whatsapp_same_phone, c.preferred_language, v.make, v.model, v.plate,
              c.licence_expiry::text AS lic, c.id_doc_expiry::text AS idd,
              (c.licence_expiry IS NOT NULL AND c.licence_expiry < (r.end_at AT TIME ZONE '${TZ}')::date) AS lic_bad,
              (c.id_doc_expiry IS NOT NULL AND c.id_doc_expiry < (r.end_at AT TIME ZONE '${TZ}')::date) AS id_bad,
              (SELECT max(l.sent_at) FROM reminder_log l WHERE l.kind = 'pickup' AND l.ref_id = r.id) AS sent_pickup,
              (SELECT max(l.sent_at) FROM reminder_log l WHERE l.kind = 'customer_document' AND l.ref_id = r.id) AS sent_doc
         FROM reservations r JOIN customers c ON c.id = r.customer_id JOIN vehicles v ON v.id = r.vehicle_id
        WHERE ${scopeR} AND r.status = 'confirmed' AND r.start_at BETWEEN now() - interval '2 hours' AND now() + interval '7 days'
        ORDER BY r.start_at`,
      params,
    );
    const params2: unknown[] = [];
    const scopeK = branchFilter(auth, 'k.branch_id', params2);
    const contracts = await db.query(
      `SELECT k.id, k.number, k.planned_end_at, r.return_place, r.return_details, c.id AS customer_id, c.full_name, c.phone, c.phone_key, c.phone2_key,
              c.whatsapp_same_phone, c.preferred_language, v.make, v.model, v.plate,
              (SELECT max(l.sent_at) FROM reminder_log l WHERE l.kind = 'return' AND l.ref_id = k.id) AS sent
         FROM contracts k JOIN reservations r ON r.id = k.reservation_id JOIN customers c ON c.id = k.customer_id JOIN vehicles v ON v.id = k.vehicle_id
        WHERE ${scopeK} AND k.status = 'open' AND k.planned_end_at <= now() + interval '36 hours'
        ORDER BY k.planned_end_at`,
      params2,
    );

    const items: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phoneOf = (x: any) => (!x.whatsapp_same_phone && x.phone2_key ? x.phone2_key : x.phone_key) as string;
    for (const x of reserv.rows) {
      const lang = x.preferred_language as Lang;
      const v = { name: x.full_name, company, ref: `R-${String(x.number).padStart(5, '0')}`, car: `${x.make} ${x.model}`, when: fmt(x.start_at, lang), place: [PLACE[lang][x.pickup_place], x.pickup_details].filter(Boolean).join(' — ') };
      const pickupSoon = new Date(x.start_at).getTime() - Date.now() <= 36 * 3600_000;
      if (pickupSoon) {
        const text = T.pickup[lang](v);
        items.push({ kind: 'pickup', refId: x.id, reference: v.ref, at: x.start_at, customer: { id: x.customer_id, fullName: x.full_name, phone: x.phone, language: lang }, text, link: waLink(phoneOf(x), text), lastSentAt: x.sent_pickup });
      }
      if (x.lic_bad || x.id_bad) {
        const text = T.customer_document[lang]({ ...v, doc: x.lic_bad ? DOC[lang].licence : DOC[lang].id, when: fmtDay(x.lic_bad ? x.lic : x.idd, lang), rental: fmt(x.start_at, lang) });
        items.push({ kind: 'customer_document', refId: x.id, reference: v.ref, at: x.start_at, customer: { id: x.customer_id, fullName: x.full_name, phone: x.phone, language: lang }, text, link: waLink(phoneOf(x), text), lastSentAt: x.sent_doc });
      }
    }
    for (const x of contracts.rows) {
      const lang = x.preferred_language as Lang;
      const v = { name: x.full_name, company, ref: `C-${String(x.number).padStart(5, '0')}`, car: `${x.make} ${x.model} ${x.plate}`, when: fmt(x.planned_end_at, lang), place: [PLACE[lang][x.return_place], x.return_details].filter(Boolean).join(' — ') };
      const text = T.return[lang](v);
      items.push({ kind: 'return', refId: x.id, reference: v.ref, at: x.planned_end_at, late: new Date(x.planned_end_at).getTime() < Date.now(), customer: { id: x.customer_id, fullName: x.full_name, phone: x.phone, language: lang }, text, link: waLink(phoneOf(x), text), lastSentAt: x.sent });
    }
    res.json({ items });
  });

  /** The employee confirms he sent the message himself. Opening WhatsApp alone proves nothing. */
  r.post('/sent', requirePermission(db, 'reminders.send'), async (req, res) => {
    const b = parseBody(z.object({ kind: z.enum(['pickup', 'return', 'customer_document']), refId: z.uuid() }).strict(), req);
    const auth = res.locals.auth!;
    const params: unknown[] = [b.refId];
    const scope = branchFilter(auth, b.kind === 'return' ? 'k.branch_id' : 'r.branch_id', params);
    const ref = (
      await db.query<{ customer_id: string }>(
        b.kind === 'return'
          ? `SELECT k.customer_id FROM contracts k WHERE k.id = $1 AND ${scope}`
          : `SELECT r.customer_id FROM reservations r WHERE r.id = $1 AND ${scope}`,
        params,
      )
    ).rows[0];
    if (!ref) throw new AppError(404, 'not_found', 'Not found');
    await db.query('INSERT INTO reminder_log (kind, ref_id, customer_id, sent_by) VALUES ($1, $2, $3, $4)', [b.kind, b.refId, ref.customer_id, auth.user.id]);
    await recordAudit(db, { ...auditContext(req, res), action: 'reminder.sent', targetType: 'customer', targetId: ref.customer_id, metadata: { kind: b.kind, refId: b.refId } });
    res.status(201).json({ ok: true });
  });

  return r;
}
