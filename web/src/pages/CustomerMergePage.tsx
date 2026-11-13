import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../useApi';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { ErrorState, Loading } from '../components/States';

type Customer={id:string;fullName:string};
type Candidate={id:string;fullName:string;reasons:string[];nameScore:number};
type Preview={source:{id:string;fullName:string;blocked:boolean};canonical:{id:string;fullName:string;blocked:boolean};
  conflicts:string[];historyCounts:Array<{customer_id:string;reservations:number;contracts:number;documents:number}>};
type LinkRow={id:string;source_customer_id:string;canonical_customer_id:string;status:string;
  source_name:string;canonical_name:string;reason:string;linked_at:string};
export function CustomerMergePage() {
  const {me}=useAuth(); const {t}=useI18n();
  const customers=useApi<{items:Customer[]}>('/customers');
  const links=useApi<{items:LinkRow[]}>('/customer-merges/links');
  const [sourceId,setSourceId]=useState('');
  const [canonicalId,setCanonicalId]=useState('');
  const candidates=useApi<{items:Candidate[]}>(sourceId?`/customer-merges/candidates/${sourceId}`:null);
  const [preview,setPreview]=useState<Preview|null>(null);
  const [reason,setReason]=useState('');
  const [typedName,setTypedName]=useState('');
  const [ack,setAck]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  if(me?.user.role!=='manager') return <section><p>{t('merge.managerOnly')}</p></section>;

  const inspect=async()=>{
    setMessage('');setPreview(null);setBusy(true);
    try{setPreview(await api('/customer-merges/preview',{method:'POST',body:{sourceId,canonicalId}}));}
    catch{setMessage(t('merge.failed'));}
    finally{setBusy(false);}
  };
  const apply=async()=>{
    if(!preview||!ack||!reason.trim()||typedName!==preview.source.fullName)return;
    setMessage('');setBusy(true);
    try{
      await api('/customer-merges/links',{method:'POST',body:{
        sourceId,canonicalId,reason,acknowledgeConflicts:true,confirmSourceName:typedName,
      }});
      setMessage(t('merge.created'));setPreview(null);setAck(false);setTypedName('');links.reload();
    }catch{setMessage(t('merge.failed'));}
    finally{setBusy(false);}
  };
  const reverse=async(id:string)=>{
    const why=window.prompt(t('merge.reverseReason'));
    if(!why||why.trim().length<10)return;
    setBusy(true);setMessage('');
    try{await api(`/customer-merges/links/${id}/reverse`,{method:'POST',body:{reason:why}});links.reload();setMessage(t('merge.reversed'));}
    catch{setMessage(t('merge.failed'));}
    finally{setBusy(false);}
  };
  const select=(value:string,onChange:(v:string)=>void)=>(
    <select required value={value} onChange={e=>{onChange(e.target.value);setPreview(null);setAck(false);}}>
      <option value="">—</option>
      {customers.data?.items.map(c=><option key={c.id} value={c.id}>{c.fullName}</option>)}
    </select>
  );
  return <section>
    <Link to="/customers">← {t('nav.customers')}</Link>
    <h1>{t('merge.title')}</h1><p className="muted">{t('merge.warning')}</p>
    {message&&<p role="status" className="alert">{message}</p>}
    <div className="card">
      <label className="field"><span>{t('merge.source')}</span>{select(sourceId,setSourceId)}</label>
      {candidates.data?.items.length ? <div>
        <p>{t('merge.candidates')}</p>
        <ul className="doc-list">{candidates.data.items.map(c=><li key={c.id}>
          <button className="btn btn-small" onClick={()=>{setCanonicalId(c.id);setPreview(null);}}>{c.fullName}</button>
          <span className="muted small"> {c.reasons.join(', ')} ({Math.round(c.nameScore*100)}%)</span>
        </li>)}</ul>
      </div>:null}
      <label className="field"><span>{t('merge.canonical')}</span>{select(canonicalId,setCanonicalId)}</label>
      <button type="button" className="btn" disabled={!sourceId||!canonicalId||sourceId===canonicalId||busy}
        onClick={()=>void inspect()}>{t('merge.preview')}</button>
      {preview && <div className="card">
        <h2>{t('merge.preview')}</h2>
        <p>{t('merge.source')}: <strong>{preview.source.fullName}</strong></p>
        <p>{t('merge.canonical')}: <strong>{preview.canonical.fullName}</strong></p>
        <p>{t('merge.conflicts')}: {preview.conflicts.join(', ')||'—'}</p>
        <ul>{preview.historyCounts.map(x=><li key={x.customer_id}>
          <bdi>{x.customer_id.slice(0,8)}</bdi>: {x.reservations} {t('nav.reservations')} · {x.contracts} {t('nav.contracts')} · {x.documents} {t('merge.documents')}
        </li>)}</ul>
        <label className="field"><span>{t('merge.reason')}</span>
          <textarea minLength={10} required rows={2} value={reason} onChange={e=>setReason(e.target.value)}/>
        </label>
        <label className="field"><span>{t('merge.confirmName', {name:preview.source.fullName})}</span>
          <input required value={typedName} onChange={e=>setTypedName(e.target.value)} />
        </label>
        <label className="check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>
          {t('merge.ack')}</label>
        <button type="button" className="btn btn-primary" disabled={busy||reason.trim().length<10||typedName!==preview.source.fullName||!ack||preview.source.blocked||preview.canonical.blocked}
          onClick={()=>void apply()}>{t('merge.link')}</button>
      </div>}
    </div>
    <div className="card"><h2>{t('merge.history')}</h2>
      {links.error ? <ErrorState error={links.error} onRetry={links.reload}/> : !links.data ? <Loading/> :
        <ul className="doc-list">{links.data.items.map(x=><li key={x.id}>
          <strong>{x.source_name} → {x.canonical_name}</strong> · {x.status}
          {x.status==='active'&&<button type="button" className="btn btn-small" disabled={busy} onClick={()=>void reverse(x.id)}>{t('merge.reverse')}</button>}
        </li>)}</ul>}
    </div>
  </section>;
}
