import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, ArrowRight, CalendarCheck2, CalendarDays, CalendarPlus, CarFront, CheckCircle2,
  ChevronLeft, ChevronRight, Clock3, FileWarning, KeyRound, MapPin, RefreshCw, Undo2, Wallet, Wrench,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useBranding, isJmrBrand } from '../branding';
import { useI18n, type MessageKey } from '../i18n';
import { formatMoney } from '../reservations';
import { changeDay, moroccoDate, CASABLANCA_TZ, type AgendaDay, type AgendaEvent, type AgendaKind } from '../agenda';
import './AgendaBoard.css';

const labels: Record<AgendaKind, MessageKey> = {
  reservation: 'agenda.reservation', pickup: 'agenda.pickup', return: 'agenda.return',
  payment: 'agenda.payment', maintenance: 'agenda.maintenance', document: 'agenda.document',
};
const sublabels: Record<AgendaKind, MessageKey> = {
  reservation: 'agenda.reservationHint', pickup: 'agenda.pickupHint', return: 'agenda.returnHint',
  payment: 'agenda.paymentHint', maintenance: 'agenda.maintenanceHint', document: 'agenda.documentHint',
};
const icons = {
  reservation: CalendarPlus, pickup: KeyRound, return: Undo2, payment: Wallet, maintenance: Wrench, document: FileWarning,
};
const kindText: Record<string, MessageKey> = {
  agency: 'agenda.agency', airport: 'agenda.airport', hotel: 'agenda.hotel', other: 'agenda.other',
  oil_change: 'agenda.oil', tyres: 'agenda.tyres', brakes: 'agenda.brakes', insurance: 'agenda.insurance',
  technical_inspection: 'agenda.inspection', registration: 'agenda.registration',
};

function TimeLabel({ event }: { event: AgendaEvent }) {
  const { lang, t } = useI18n();
  if (!event.time || event.kind === 'maintenance' || event.kind === 'document')
    return <span className="agenda-time agenda-time--flex">{t('agenda.anytime')}</span>;
  const date = new Date(event.time);
  const hour = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', {
    timeZone: CASABLANCA_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  return <time className="agenda-time" dateTime={event.time} dir="ltr">{hour}</time>;
}

function EventCard({ event }: { event: AgendaEvent }) {
  const { t, lang } = useI18n();
  const Icon = icons[event.kind];
  const info = kindText[event.detail ?? ''] ? t(kindText[event.detail!]!) : event.detail;
  // Real authorised vehicle photos only. Never insert a stock car photo or an invented model.
  const imageUrl = event.vehicle.photoFileId
    ? `/api/vehicles/${event.vehicle.id}/files/${event.vehicle.photoFileId}` : null;
  return (
    <li className={`agenda-event agenda-event--${event.kind}${event.overdue ? ' agenda-event--late' : ''}`}>
      <div className="agenda-event__time">
        <TimeLabel event={event} />
        <span className="agenda-event__node" aria-hidden="true" />
      </div>
      <Link to={event.link} className="agenda-event__card">
        <div className="agenda-event__head">
          <span className="agenda-event__icon"><Icon size={22} strokeWidth={1.9} aria-hidden="true" /></span>
          <div className="agenda-event__heading">
            <strong>{t(labels[event.kind])}</strong>
            <span>{t(sublabels[event.kind])}</span>
          </div>
          <ArrowRight className="agenda-event__arrow" size={20} aria-hidden="true" />
        </div>
        <div className="agenda-event__body">
          <div className="agenda-event__details">
            <div className="agenda-event__vehicle">{event.vehicle.make} {event.vehicle.model}</div>
            <div className="agenda-event__plate" dir="ltr">{event.vehicle.plate}</div>
            {event.customer && <div className="agenda-event__secondary">{event.customer}</div>}
            {info && !['late','expected','remaining'].includes(event.detail ?? '') && (
              <div className="agenda-event__secondary">{info}</div>
            )}
            <div className="agenda-event__secondary"><MapPin size={15} aria-hidden="true" /> {event.branch}</div>
            {event.amountCents !== null && <strong className="agenda-event__money" dir="ltr">{formatMoney(event.amountCents, lang)}</strong>}
            {event.reference && <span className="agenda-event__ref">{event.kind === 'reservation' ? 'R-' : 'C-'}{String(event.reference).padStart(5,'0')}</span>}
          </div>
          <div className="agenda-event__visual">
            {imageUrl
              ? <img src={imageUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.hidden = true; }} />
              : <CarFront size={42} strokeWidth={1.3} aria-hidden="true" />}
          </div>
        </div>
        {event.overdue && <span className="agenda-event__flag"><AlertCircle size={15} /> {t('agenda.overdue')}</span>}
        {!event.overdue && event.provisional && <span className="agenda-event__flag agenda-event__flag--quiet">{t('agenda.provisional')}</span>}
      </Link>
    </li>
  );
}

export function AgendaBoard() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const brand = useBranding();
  const [date, setDate] = useState(() => moroccoDate());
  const [today, setToday] = useState(() => moroccoDate());
  const [time, setTime] = useState(() => new Date());
  const [data, setData] = useState<AgendaDay | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const jmr = isJmrBrand(brand.name);
  const isToday = date === today;

  useEffect(() => {
    const id = window.setInterval(() => { setTime(new Date()); setToday(moroccoDate()); }, 60000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setFailed(false);
    setData(null);
    api<AgendaDay>(`/dashboard/agenda?date=${date}`, { signal: ctrl.signal }).then(
      (result) => { if(active) setData(result); },
      (err: unknown) => { if(active && (err as Error)?.name !== 'AbortError') setFailed(true); },
    );
    return () => { active = false; ctrl.abort(); };
  }, [date, refresh]);

  const dayTitle = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', {
    dateStyle: 'full', timeZone: 'UTC',
  }).format(new Date(date + 'T12:00:00Z'));
  const clock = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', {
    timeZone: CASABLANCA_TZ, hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  }).format(time);
  const days = useMemo(() => Array.from({length: 7}, (_unused,index)=>changeDay(date,index-3)), [date]);
  const events = data?.items ?? [];

  return (
    <div className={`agenda-home${jmr ? ' agenda-home--jmr' : ''}`}>
      <header className="agenda-hero">
        <div className="agenda-hero__top">
          {jmr && <div className="agenda-hero__mark" aria-hidden="true">
            <img src={brand.logo ?? '/branding/jmr-emblem.svg'} alt="" />
          </div>}
          <div className="agenda-hero__brand">
            <strong>{brand.name ?? t('app.name')}</strong>
            <span>{t('agenda.heroTagline')}</span>
          </div>
          <div className="agenda-hero__clock"><Clock3 size={17} aria-hidden="true" /> <time dir="ltr">{clock}</time></div>
        </div>
        <h1>{t('agenda.welcome')}</h1>
        <p>{t('agenda.intro')}</p>
        <nav className="agenda-hero__actions" aria-label={t('dashboard.quick')}>
          {can('reservations.manage') && <Link to="/reservations/new" className="agenda-action"><CalendarPlus size={22} />{t('agenda.newReservation')}<ChevronRight size={17} /></Link>}
          {can('vehicles.read') && <Link to="/vehicles" className="agenda-action"><CarFront size={22} />{t('agenda.seeFleet')}<ChevronRight size={17} /></Link>}
        </nav>
      </header>

      <div className="agenda-section__head">
        <div>
          <h2><CalendarDays size={23} aria-hidden="true" /> {t('agenda.title')}</h2>
          <p className="agenda-date">{dayTitle}</p>
        </div>
        <button type="button" className="agenda-icon-action" onClick={() => setRefresh(n=>n+1)} aria-label={t('agenda.refresh')} title={t('agenda.refresh')}>
          <RefreshCw size={19} aria-hidden="true"/>
        </button>
      </div>

      <div className="agenda-picker">
        <button type="button" className="agenda-picker__step" onClick={()=>setDate(d=>changeDay(d,-7))} aria-label={t('agenda.prevWeek')}><ChevronLeft/></button>
        <div className="agenda-picker__week" role="group" aria-label={t('agenda.selectDate')}>
          {days.map(d => {
            const dayObj = new Date(d+'T12:00:00Z');
            const weekday = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { weekday:'short',timeZone:'UTC' }).format(dayObj);
            return <button key={d} type="button" className={`agenda-picker__day${d===date?' is-active':''}${d===today?' is-today':''}`}
              onClick={()=>setDate(d)} aria-pressed={d===date} aria-label={new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA',{dateStyle:'full',timeZone:'UTC'}).format(dayObj)}>
              <span>{weekday}</span><strong>{d.slice(-2)}</strong>
            </button>;
          })}
        </div>
        <button type="button" className="agenda-picker__step" onClick={()=>setDate(d=>changeDay(d,7))} aria-label={t('agenda.nextWeek')}><ChevronRight/></button>
      </div>
      <div className="agenda-picker__tools">
        <label className="agenda-date-input">{t('agenda.chooseDate')} <input type="date" value={date} onChange={e=>setDate(e.target.value)} min="2020-01-01" max="2100-12-31" /></label>
        {!isToday && <button className="agenda-today-btn" type="button" onClick={()=>setDate(today)}>{t('agenda.today')}</button>}
      </div>

      {data && (
        <div className="agenda-stats" aria-label={t('agenda.summary')}>
          <div><CalendarCheck2 size={20}/><small>{t('agenda.reservations')}</small><b>{data.totals.reservations}</b></div>
          <div><KeyRound size={20}/><small>{t('agenda.pickups')}</small><b>{data.totals.pickups}</b></div>
          <div><Undo2 size={20}/><small>{t('agenda.returns')}</small><b>{data.totals.returns}</b></div>
          <div className={data.totals.attention ? 'needs-action' : ''}><AlertCircle size={20}/><small>{t('agenda.attention')}</small><b>{data.totals.attention}</b></div>
        </div>
      )}

      {failed && <div className="agenda-error" role="alert">
        <AlertCircle size={22} aria-hidden="true"/><span>{t('agenda.loadError')}</span>
        <button type="button" onClick={()=>setRefresh(n=>n+1)}>{t('common.retry')}</button>
      </div>}
      {!data && !failed && <div className="agenda-loading" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true"/>{t('agenda.loading')}</div>}
      {data && (
        <section className="agenda-events" aria-label={t('agenda.events')}>
          <div className="agenda-events__title"><h3>{t('agenda.events')}</h3><span>{events.length} {t('agenda.eventsCount')}</span></div>
          {events.length===0
            ? <div className="agenda-empty"><CheckCircle2 size={34}/><strong>{t('agenda.emptyTitle')}</strong><p>{t('agenda.emptyHint')}</p></div>
            : <ol className="agenda-timeline">{events.map(e=><EventCard key={e.id} event={e}/>)}</ol>}
          {data.truncated && <p className="agenda-note">{t('agenda.truncated')}</p>}
          {data.totals.outstandingCents > 0 && can('cash.read') && (
            <div className="agenda-outstanding">
              <Wallet size={20} /><div><strong>{t('agenda.balance')}</strong><p>{t('agenda.balanceHint')}</p></div>
              <b dir="ltr">{formatMoney(data.totals.outstandingCents,lang)}</b>
            </div>
          )}
        </section>
      )}
      <p className="agenda-privacy">{t('agenda.privacy')}</p>
    </div>
  );
}
