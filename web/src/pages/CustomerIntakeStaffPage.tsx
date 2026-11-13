import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../useApi';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { ErrorState, Loading } from '../components/States';

type Car = { id: string; make: string; model: string; plate: string; dailyRateCents: number | null; depositCents: number | null };
type Intake = { id: string; status: string; expires_at: string; created_at: string; submitted_at: string | null; make: string; model: string; document_count: number };
type Doc = { id: string; kind: string; file_id: string; mime_type: string };
type Details = { intake: { id: string; status: string; make: string; model: string;
  vehicle_id:string; accepted_customer_id:string|null; start_local:string; end_local:string;
  daily_cents:number; deposit_cents:number; }; documents: Doc[] };
type Customer = { id: string; fullName: string };
type Analysis = {
  suggestions: Record<string,{value:string;confidence:number;basis:string}>;
  quality:{blurVariance:number;brightness:number;deskewDegrees:number;averageWordConfidence:number};
  warnings:string[];requiresHumanReview:true;
  similarity:{exactCustomers:Array<{id:string;fullName:string}>;
    similarImages:Array<{documentId:string;intakeId:string;bitDistance:number}>;scannedImagesLimit:number};
};
export function CustomerIntakeStaffPage() {
  const { t } = useI18n();
  const { me } = useAuth();
  const isManager = me?.user.role === 'manager';
  const cars = useApi<{ items: Car[] }>('/vehicles');
  const intakes = useApi<{ items: Intake[] }>('/customer-intakes');
  const clients = useApi<{ items: Customer[] }>('/customers');
  const [vehicleId, setVehicleId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [dailyMAD, setDailyMAD] = useState('');
  const [depositMAD, setDepositMAD] = useState('');
  const [expiry, setExpiry] = useState(1440);
  const [created, setCreated] = useState<{ id: string; path: string; code: string; expiresAt: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const details = useApi<Details>(selected ? `/customer-intakes/${selected}` : null);
  const [customerId, setCustomerId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string,Analysis>>({});

  const reviewWarnings = (warnings:string[]) => warnings.map(w => {
    if (w === 'blur_or_low_detail') return t('intake.ocrWarningBlur');
    if (w === 'too_dark') return t('intake.ocrWarningDark');
    if (w === 'too_bright') return t('intake.ocrWarningBright');
    if (w === 'low_resolution') return t('intake.ocrWarningResolution');
    return t('intake.ocrWarningUnknown');
  });


  const generate = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true); setCreated(null);
    try {
      const data = await api<{ id: string; path: string; code: string; expiresAt: string }>('/customer-intakes', {
        method:'POST', body: {
          vehicleId, start, end, expiryMinutes:expiry,
          ...(dailyMAD ? {dailyCents:Math.round(Number(dailyMAD)*100)} : {}),
          ...(depositMAD ? {depositCents:Math.round(Number(depositMAD)*100)} : {}),
        },
      });
      setCreated(data);
      intakes.reload();
    } catch { setError(t('intake.createError')); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (!window.confirm(t('intake.confirmRevoke'))) return;
    setBusy(true); setError('');
    try { await api(`/customer-intakes/${id}/revoke`, { method:'POST' }); intakes.reload(); details.reload(); }
    catch { setError(t('intake.createError')); }
    finally { setBusy(false); }
  };
  const attach = async () => {
    if (!selected || !reviewed || !customerId) return;
    setBusy(true); setError('');
    try {
      await api(`/customer-intakes/${selected}/attach`, { method:'POST', body:{ customerId } });
      details.reload(); intakes.reload(); setReviewed(false);
    } catch { setError(t('intake.createError')); }
    finally { setBusy(false); }
  };
  const analyze = async (docId:string) => {
    if(!selected || !isManager || analyzing)return;
    setAnalyzing(docId);setError('');
    try{
      const data = await api<Analysis>(`/customer-intakes/${selected}/documents/${docId}/analyze`,{method:'POST'});
      setResults(current=>({...current,[docId]:data}));
    }catch{setError(t('intake.ocrUnavailable'));}
    finally{setAnalyzing(null);}
  };

  const url = created ? `${window.location.origin}${created.path}` : '';
  const message = created ? `${t('intake.whatsappIntro')}\n${url}\n${t('intake.code')}: ${created.code}\n${t('intake.expires')}: ${new Date(created.expiresAt).toLocaleString()}` : '';

  return <section>
    <h1>{t('intake.staffTitle')}</h1>
    <p className="muted">{t('intake.staffHint')}</p>
    {isManager && <div className="card">
      <h2>{t('intake.create')}</h2>
      <form onSubmit={e => void generate(e)}>
        <label className="field"><span>{t('intake.vehicle')}</span>
          <select required value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
            <option value="">—</option>
            {cars.data?.items.map(v => <option key={v.id} value={v.id}>{v.make} {v.model} — {v.plate}</option>)}
          </select>
        </label>
        <div className="upload-row">
          <label className="field"><span>{t('intake.pickup')}</span>
            <input required type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}/></label>
          <label className="field"><span>{t('intake.return')}</span>
            <input required type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)}/></label>
        </div>
        <div className="upload-row">
          <label className="field"><span>{t('intake.dailyPrice')}</span>
            <input type="number" min="0" step="0.01" placeholder="MAD" value={dailyMAD} onChange={e=>setDailyMAD(e.target.value)}/></label>
          <label className="field"><span>{t('intake.deposit')}</span>
            <input type="number" min="0" step="0.01" placeholder="MAD" value={depositMAD} onChange={e=>setDepositMAD(e.target.value)}/></label>
          <label className="field"><span>{t('intake.expiry')}</span>
            <select value={expiry} onChange={e=>setExpiry(Number(e.target.value))}>
              <option value={15}>15 min</option><option value={60}>1 h</option>
              <option value={1440}>24 h</option><option value={10080}>7 j</option>
            </select></label>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>{t('intake.create')}</button>
      </form>
      {created && <div className="alert alert-ok" role="status">
        <p>{t('intake.codeOnce')}</p>
        <p><code>{url}</code></p>
        <p><strong>{t('intake.code')}: <bdi>{created.code}</bdi></strong></p>
        <a className="btn btn-primary" href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank" rel="noopener noreferrer">{t('intake.shareWhatsApp')}</a>
      </div>}
    </div>}
    {error && <p role="alert" className="alert alert-error">{error}</p>}
    <div className="card">
      <h2>{t('intake.invites')}</h2>
      {intakes.error ? <ErrorState error={intakes.error} onRetry={intakes.reload}/> : !intakes.data ? <Loading/> :
        <ul className="doc-list">{intakes.data.items.map(x =>
          <li key={x.id}>
            <button className="btn" onClick={()=>{setSelected(x.id);setReviewed(false);}}>{x.make} {x.model} — {x.status} — {x.document_count}</button>
            {isManager && ['open','submitted'].includes(x.status) && <button className="btn btn-small" disabled={busy} onClick={()=>void revoke(x.id)}>{t('intake.revoke')}</button>}
          </li>)}</ul>}
    </div>
    {selected && <div className="card">
      <h2>{t('intake.review')}</h2>
      {details.error ? <ErrorState error={details.error} onRetry={details.reload} /> : !details.data ? <Loading/> :
        <>
          <p>{details.data.intake.make} {details.data.intake.model} — {details.data.intake.status}</p>
          {details.data.intake.status==='accepted' && details.data.intake.accepted_customer_id && (
            <Link className="btn btn-primary" to={`/reservations/new?${new URLSearchParams({
              customerId:details.data.intake.accepted_customer_id,
              vehicleId:details.data.intake.vehicle_id,
              start:details.data.intake.start_local,end:details.data.intake.end_local,
              dailyCents:String(details.data.intake.daily_cents),
              depositCents:String(details.data.intake.deposit_cents),
            }).toString()}`}>{t('intake.createReservation')}</Link>
          )}
          <ul className="doc-list">{details.data.documents.map(d=><li key={d.id}>
            <a href={`/api/customer-intakes/${selected}/files/${d.file_id}`}
               target="_blank" rel="noopener noreferrer">{d.kind} — {d.mime_type}</a>
            {isManager && ['submitted','accepted'].includes(details.data?.intake.status ?? '') &&
              <button className="btn btn-small" disabled={Boolean(analyzing)} onClick={()=>void analyze(d.id)}>
                {analyzing===d.id?t('intake.ocrAnalyzing'):t('intake.ocrAnalyze')}
              </button>}
            {results[d.id] && <div className="card">
              <strong>{t('intake.ocrSuggestions')}</strong>
              <p className="muted small">{t('intake.ocrNeverAuto')}</p>
              {Object.keys(results[d.id]!.suggestions).length === 0
                ? <p className="alert alert-warning" role="status">{t('intake.ocrNoFields')}</p>
                : <dl className="detail-grid">
                  {Object.entries(results[d.id]!.suggestions).map(([field,value])=><div key={field}>
                    <dt>{field === 'documentNumber' ? t('intake.ocrDocumentNumber') : field}</dt>
                    <dd><bdi dir="ltr">{value.value}</bdi> ({Math.round(value.confidence*100)}%)</dd>
                    {value.confidence < 0.65 && <dd className="muted small">{t('intake.ocrLowConfidence')}</dd>}
                  </div>)}
                </dl>}
              {results[d.id]!.warnings.length>0 && <div className="alert alert-warning" role="status">
                <strong>{t('intake.ocrWarnings')}</strong>
                <ul>{reviewWarnings(results[d.id]!.warnings).map((w,i)=><li key={i}>{w}</li>)}</ul>
                <p className="small">{t('intake.ocrRetakeHelp')}</p>
              </div>}
              <p>{t('intake.ocrExact')}: {results[d.id]!.similarity.exactCustomers.map(c=>c.fullName).join(', ')||'—'}</p>
              <p>{t('intake.ocrSimilar')}: {results[d.id]!.similarity.similarImages.length}</p>
              <p className="muted small">{t('intake.ocrCompareLimit', {n:String(results[d.id]!.similarity.scannedImagesLimit)})}</p>
            </div>}
          </li>)}</ul>
          {details.data.intake.status === 'submitted' && isManager && <>
            <label className="field"><span>{t('intake.customer')}</span>
              <select value={customerId} onChange={e=>setCustomerId(e.target.value)}>
                <option value="">—</option>{clients.data?.items.map(c=><option key={c.id} value={c.id}>{c.fullName}</option>)}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>{t('intake.reviewConfirm')}</label>
            <button className="btn btn-primary" disabled={!customerId || !reviewed || busy} onClick={()=>void attach()}>{t('intake.attach')}</button>
          </>}
        </>}
    </div>}
    <p className="muted small">{t('intake.notBooking')}</p>
    <Link to="/reservations">{t('nav.reservations')}</Link>
  </section>;
}
