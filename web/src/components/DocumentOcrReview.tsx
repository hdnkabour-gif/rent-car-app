import { useState } from 'react';
import { api, ApiError } from '../api';

type Suggestion = { value: string; confidence: number; basis: string };
export type SavedReview = {
  fields: Record<string,string>;
  status: 'approved'|'rejected';
  revision: number;
  reviewed_at?: string;
  reviewedAt?: string;
};
type Analysis = {
  suggestions: Record<string,Suggestion>;
  warnings: string[];
  enhanced: boolean;
  requiresHumanReview: true;
  comparisons?: Record<string, boolean|null>;
};
type Props = {
  scanUrl: string;
  mimeType: string;
  analyzeUrl: string;
  reviewUrl: string;
  review?: SavedReview|null;
  onSaved?: () => void;
  title?: string;
};

/** One reviewer for each independently scoped document type; all writes need explicit manager approval. */
export function DocumentOcrReview({ scanUrl,mimeType,analyzeUrl,reviewUrl,
  review: initialReview=null,onSaved,title='Vérification du document' }:Props) {
  const [analysis,setAnalysis]=useState<Analysis|null>(null);
  const [saved,setSaved]=useState<SavedReview|null>(initialReview);
  const [draft,setDraft]=useState<Record<string,string>>(initialReview?.fields ?? {});
  const [newKey,setNewKey]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [confirmed,setConfirmed]=useState(false);

  const analyze=async()=>{
    setBusy(true);setError('');setNotice('');
    try {
      const a=await api<Analysis>(analyzeUrl,{method:'POST'});
      setAnalysis(a);
      // Keep the human-reviewed version. Do not overwrite it with uncertain OCR.
      setDraft(current=>Object.keys(current).length?current:
        Object.fromEntries(Object.entries(a.suggestions).map(([key,s])=>[key,s.value])));
      setConfirmed(false);
    } catch {
      setError('Analyse indisponible. Vérifiez que le module OCR est activé ou saisissez les champs manuellement.');
    } finally {setBusy(false);}
  };
  const update=(field:string,value:string)=>{
    setDraft(v=>({...v,[field]:value}));setConfirmed(false);setNotice('');
  };
  const addField=()=>{
    const key=newKey.trim();
    if(!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(key) || Object.keys(draft).length>=24){
      setError('Nom du champ invalide (lettres, chiffres, _). Maximum 24 champs.');
      return;
    }
    setDraft(v=>({...v,[key]:v[key] ?? ''}));setNewKey('');setConfirmed(false);setError('');
  };
  const save=async(status:'approved'|'rejected')=>{
    if(busy || (status==='approved' && (!confirmed || !Object.values(draft).some(v=>v.trim()))))return;
    setBusy(true);setError('');setNotice('');
    try {
      const result=await api<{status:'approved'|'rejected';revision:number}>(reviewUrl,{
        method:'PUT',body:{status,fields:draft,expectedRevision:saved?.revision ?? 0},
      });
      setSaved({fields:{...draft},status:result.status,revision:result.revision});
      setConfirmed(false);
      setNotice(status==='approved'?'Champs vérifiés et approuvés.':'Document rejeté. Les informations métier sont inchangées.');
      onSaved?.();
    }catch(err){
      setError(err instanceof ApiError && err.status===409
        ? 'Une autre modification a été enregistrée. Rouvrez le document avant de réessayer.'
        : 'Impossible d’enregistrer cette révision. Aucun changement appliqué.');
    }finally{setBusy(false);}
  };
  const keys=Object.keys(draft);
  return <div className="card" data-testid="document-ocr-review">
    <div className="card-head">
      <div><h3>{title}</h3><p className="muted small">Document original et champs séparés des données officielles</p></div>
      {saved && <span className={`badge ${saved.status==='approved'?'badge-success':'badge-warning'}`}>
        {saved.status==='approved'?'Approuvé':'Rejeté'} · Rév. {saved.revision}
      </span>}
    </div>
    <div className="grid" style={{gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,310px),1fr))',gap:16}}>
      <div>
        <strong>Image / PDF original</strong>
        {mimeType.startsWith('image/') ?
          <a href={scanUrl} target="_blank" rel="noopener noreferrer">
            <img src={scanUrl} alt="Document original à contrôler" style={{width:'100%',maxHeight:400,objectFit:'contain'}}/>
          </a> : mimeType==='application/pdf' ?
          <object data={scanUrl} type="application/pdf" aria-label="PDF original" style={{width:'100%',height:400}}>
            <a href={scanUrl} target="_blank" rel="noopener noreferrer">Ouvrir le PDF original</a>
          </object> :
          <a href={scanUrl} target="_blank" rel="noopener noreferrer">Ouvrir le document</a>}
        <p className="small muted"><a href={scanUrl} target="_blank" rel="noopener noreferrer">Ouvrir / agrandir le document</a></p>
      </div>
      <div>
        <strong>Champs extraits ou corrigés</strong>
        <div className="doc-actions">
          <button className="btn btn-small" type="button" disabled={busy} onClick={()=>void analyze()}>
            {busy?'Traitement...':'Analyser / réanalyser'}
          </button>
        </div>
        {analysis && <p className="muted small">{analysis.enhanced
          ? 'Lecture complémentaire exécutée pour les champs incertains.'
          : 'Lecture initiale suffisante pour produire les suggestions.'}</p>}
        {analysis?.warnings.length ? <div className="alert alert-warning" role="status">
          Attention : {analysis.warnings.join(', ')}. Recontrôlez l’image.</div> : null}
        {analysis?.comparisons && Object.entries(analysis.comparisons).map(([field,match])=>(
          <p key={field} className={match===false?'text-danger':'muted small'}>
            {field} : {match===true?'Correspondance':match===false?'Différence à contrôler':'Non déterminé'}
          </p>
        ))}
        {!keys.length && <p className="muted small">Aucun champ confirmé. Vous pouvez saisir un champ manuellement.</p>}
        {keys.map(field=><label key={field} className="field">
          <span>{field}{analysis?.suggestions[field] &&
            <small className="muted"> · OCR {Math.round(analysis.suggestions[field]!.confidence*100)}%</small>}</span>
          <input aria-label={field} value={draft[field] ?? ''} maxLength={160}
            onChange={e=>update(field,e.target.value)}/>
        </label>)}
        <div className="upload-row">
          <label className="field"><span>Ajouter un champ</span>
            <input aria-label="Nom du nouveau champ" value={newKey} maxLength={60}
              placeholder="documentNumber" onChange={e=>setNewKey(e.target.value)}/></label>
          <button className="btn btn-small" type="button" onClick={addField} disabled={busy}>Ajouter</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
          J'ai comparé chaque valeur avec le document original.
        </label>
        <div className="doc-actions">
          <button className="btn btn-primary btn-small" type="button"
            disabled={busy || !confirmed || !Object.values(draft).some(v=>v.trim())}
            onClick={()=>void save('approved')}>Approuver les champs</button>
          <button className="btn btn-small" type="button" disabled={busy}
            onClick={()=>void save('rejected')}>Rejeter</button>
        </div>
        <p className="muted small">La validation n’actualise jamais automatiquement la fiche véhicule, client ou contrat signé.</p>
      </div>
    </div>
    {notice && <p className="alert alert-ok" role="status">{notice}</p>}
    {error && <p className="alert alert-error" role="alert">{error}</p>}
  </div>;
}
