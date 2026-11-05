import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { fr } from '../i18n/fr';
import { ar } from '../i18n/ar';
import { useI18n } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading } from '../components/States';
import { formatKm } from '../vehicles';
import { Plate } from '../components/Plate';
import { contractFileUrl, type ContractDetail } from '../contracts';

type PrintKey = keyof typeof fr & `print.${string}`;

/** Bilingual label as on the paper contract: French, then Arabic. */
function L({ k }: { k: PrintKey }) {
  return (
    <span className="pl">
      <span>{fr[k]}</span>
      <span dir="rtl" lang="ar">
        {ar[k]}
      </span>
    </span>
  );
}

const money = (c: number) => new Intl.NumberFormat('fr-MA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c / 100);
const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat('fr-MA', { dateStyle: 'short', timeZone: 'Africa/Casablanca' }).format(new Date(iso)) : '');
const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat('fr-MA', { timeStyle: 'short', timeZone: 'Africa/Casablanca' }).format(new Date(iso)) : '');
const day = (ymd: string | null) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : '');

function VehicleDiagram() {
  // Neutral outline (top view + both sides) for marking damage by hand on the printed sheet.
  return (
    <svg viewBox="0 0 220 120" className="car-diagram" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="70" y="30" width="80" height="60" rx="18" />
        <rect x="88" y="40" width="44" height="40" rx="6" />
        <line x1="70" y1="48" x2="88" y2="50" />
        <line x1="70" y1="72" x2="88" y2="70" />
        <line x1="150" y1="48" x2="132" y2="50" />
        <line x1="150" y1="72" x2="132" y2="70" />
        <path d="M10 22 h50 l6 8 v8 h-62 v-8 z" />
        <circle cx="20" cy="40" r="5" />
        <circle cx="52" cy="40" r="5" />
        <path d="M160 22 h50 l6 8 v8 h-62 v-8 z" />
        <circle cx="170" cy="40" r="5" />
        <circle cx="202" cy="40" r="5" />
        <path d="M10 82 h50 l6 8 v8 h-62 v-8 z" />
        <circle cx="20" cy="100" r="5" />
        <circle cx="52" cy="100" r="5" />
        <path d="M160 82 h50 l6 8 v8 h-62 v-8 z" />
        <circle cx="170" cy="100" r="5" />
        <circle cx="202" cy="100" r="5" />
      </g>
    </svg>
  );
}

function FuelDial({ eighths }: { eighths: number }) {
  const angle = -90 + (eighths / 8) * 180;
  return (
    <svg viewBox="0 0 120 70" className="fuel-dial" aria-label={`${eighths}/8`}>
      <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke="currentColor" strokeWidth="6" strokeDasharray="6 4" />
      <line x1="60" y1="60" x2={60 + 42 * Math.sin((angle * Math.PI) / 180)} y2={60 - 42 * Math.cos((angle * Math.PI) / 180)} stroke="currentColor" strokeWidth="3" />
      <text x="6" y="70" fontSize="10">E</text>
      <text x="106" y="70" fontSize="10">F</text>
    </svg>
  );
}

/**
 * Printable contract, modelled on the company's paper contract (front: parties, vehicle,
 * amounts, fuel, diagram, signatures; back: general conditions of the template version used).
 * Print → "Save as PDF" gives the PDF; the SIGNED paper remains the official contract (D-015).
 */
export function ContractPrintPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { data, error, reload } = useApi<ContractDetail>(`/contracts/${id}`);
  const [printedAt] = useState(() => new Date().toISOString());
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const { contract: k, template: tpl, balances: b } = data;
  const s = k.snapshot;
  const c = s.customer;
  const methods = [...new Set(data.payments.filter((p) => p.kind === 'rental' && !p.reversedBy).map((p) => fr[`k.method.${p.method}` as keyof typeof fr]))].join(' + ');
  const extended = data.events.filter((e) => e.event === 'extended');
  const driver = data.drivers[0];
  const row = (k2: PrintKey, value: ReactNode, ltr = false) => (
    <div className="prow">
      <L k={k2} />
      <span className="pval" dir={ltr ? 'ltr' : undefined}>
        {value ?? ''}
      </span>
    </div>
  );

  return (
    <div className="print-root">
      <div className="print-toolbar no-print">
        <Link to={`/contracts/${k.id}`} className="btn">
          <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('print.back')}
        </Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          <Printer size={18} aria-hidden="true" /> {t('print.printNow')}
        </button>
        <span className="muted small">{t('k.printHint')}</span>
      </div>

      <article className="print-page" dir="ltr" lang="fr">
        <header className="p-head">
          <div className="p-brand">
            {s.company.logoFileId && <img src={contractFileUrl(k.id, s.company.logoFileId)} alt="" className="p-logo" />}
            <div>
              <div className="p-company">{s.company.name}</div>
              {s.company.legalName && s.company.legalName !== s.company.name && <div className="p-small">{s.company.legalName}</div>}
            </div>
          </div>
          <div className="p-title">
            <div className="p-title-badge">{tpl.title}</div>
            <div className="p-number">
              N° : <strong>{k.paperNumber ?? k.reference}</strong>
            </div>
            {k.paperNumber && <div className="p-small">{k.reference}</div>}
          </div>
        </header>

        <div className="p-cols">
          <div className="p-left">
            <section className="p-box">
              <h2 className="p-box-title">
                <L k="print.locataire" />
              </h2>
              {row('print.nom', c.fullName)}
              {row('print.nationalite', c.nationality)}
              {row('print.naissance', day(c.birthDate), true)}
              {row('print.profession', c.profession)}
              {row('print.passeport', c.idDocType === 'passport' ? c.idDocNumber : '', true)}
              {row('print.delivreA', c.idDocType === 'passport' ? c.idDocCountry : '')}
              {row('print.cin', c.idDocType === 'cin' || c.idDocType === 'residence_permit' ? c.idDocNumber : '', true)}
              {row('print.permis', c.licenceNumber, true)}
              {row('print.delivreLe', day(c.licenceIssueDate), true)}
              {row('print.adresseMaroc', c.address)}
              {row('print.autreAdresse', c.otherAddress)}
              {row('print.telephone', c.phone, true)}
            </section>
            {tpl.secondDriverSection && (
              <section className="p-box">
                <h2 className="p-box-title">
                  <L k="print.autreConducteur" />
                </h2>
                {row('print.nom', driver?.fullName)}
                {row('print.permis', driver?.licenceNumber, true)}
                {row('print.delivreLe', `${day(driver?.licenceIssueDate ?? null)}${driver?.licenceIssuePlace ? ` à ${driver.licenceIssuePlace}` : ''}`)}
                {row('print.cin', `${driver?.idNumber ?? ''}${driver?.idIssueDate ? ` du ${day(driver.idIssueDate)}` : ''}`, true)}
                {data.drivers.slice(1).map((d) => (
                  <div key={d.id} className="prow">
                    <span className="pval">
                      {d.fullName} — {d.licenceNumber}
                    </span>
                  </div>
                ))}
              </section>
            )}
          </div>

          <div className="p-right">
            <section className="p-pills">
              {row('print.marque', `${s.vehicle.make} ${s.vehicle.model}`)}
              {row('print.immatriculation', <Plate value={s.vehicle.plate} />)}
              {row('print.dateDepart', date(k.outAt), true)}
              {row('print.dateRetour', date(k.inAt ?? k.plannedEndAt), true)}
              {row('print.prolongation', extended.length ? date(String(extended.at(-1)!.details.to)) : '', true)}
              {row('print.kmDepart', formatKm(k.kmOut), true)}
              {row('print.kmRetour', k.kmIn !== null ? formatKm(k.kmIn) : '', true)}
              {row('print.jours', k.days, true)}
              {k.late.feeCents > 0 && row('print.retard', `${k.late.quantity} × ${money(k.late.unitCents ?? 0)} MAD`, true)}
              {row('print.heureSortie', time(k.outAt), true)}
              {row('print.montant', `${money(k.totalCents)} MAD`, true)}
              {row('print.reglement', methods)}
              {row('print.reste', `${money(b.restCents)} MAD`, true)}
              {row('print.caution', k.depositCents ? `${money(k.depositCents)} MAD` : '', true)}
            </section>
            <div className="p-fuel">
              <L k="print.carburant" />
              <FuelDial eighths={k.fuelOut} />
            </div>
            {tpl.showVehicleDiagram && <VehicleDiagram />}
          </div>
        </div>

        <div className="p-obs-row">
          <section className="p-box p-obs">
            <L k="print.observations" />
            <p>{k.notesOut}</p>
            {tpl.responsibilityClause && <p className="p-clause">{tpl.responsibilityClause}</p>}
          </section>
          <div className="p-lavage">
            <L k="print.lavage" />
            <span>
              <span className="p-check">{k.washedOut === true ? '☒' : '☐'}</span> OUI <span className="p-check">{k.washedOut === false ? '☒' : '☐'}</span> NON
            </span>
          </div>
        </div>

        <div className="p-date">
          <L k="print.date" /> <span dir="ltr">{date(k.outAt)}</span>
        </div>

        <div className="p-signs">
          {(['print.cachet', 'print.client1', 'print.client2'] as const).map((x) => (
            <div key={x} className="p-sign">
              <L k={x} />
            </div>
          ))}
        </div>

        <div className="p-docs">
          {tpl.handedDocuments.map((d) => (
            <span key={d}>
              <span className="p-check">{k.documentsOut.includes(d) ? '☒' : '☐'}</span> {d}
            </span>
          ))}
        </div>

        <footer className="p-foot">
          {s.company.phone && (
            <div>
              TEL : {s.company.phone}
              {s.company.phone2 ? ` / ${s.company.phone2}` : ''}
            </div>
          )}
          <div>
            {s.company.ice && <>ICE : {s.company.ice}</>} {s.company.ifNumber && <>&nbsp;&nbsp; IF : {s.company.ifNumber}</>}
            {s.company.rcNumber && <>&nbsp;&nbsp; RC : {s.company.rcNumber}</>}
          </div>
          {s.company.address && <div>ADRESSE : {s.company.address}</div>}
          {s.company.footer && <div className="p-small">{s.company.footer}</div>}
        </footer>
      </article>

      <article className="print-page print-terms" dir="ltr" lang="fr">
        <h2 className="p-terms-title">{tpl.termsTitle}</h2>
        <div className="p-terms">
          {tpl.terms.map((a, i) => (
            <p key={i}>
              {a.title && <strong>{a.title} : </strong>}
              {a.body}
            </p>
          ))}
        </div>
        {tpl.termsAr && tpl.termsAr.length > 0 && (
          <div className="p-terms" dir="rtl" lang="ar">
            {tpl.termsAr.map((a, i) => (
              <p key={i}>
                {a.title && <strong>{a.title} : </strong>}
                {a.body}
              </p>
            ))}
          </div>
        )}
        <div className="p-small p-version">
          {k.reference} · modèle v{tpl.version} · imprimé le {date(printedAt)} {time(printedAt)}
        </div>
      </article>
    </div>
  );
}
