import { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { api, uploadFile } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from './States';
import { fileUrl, uploadErrorKey } from './VehicleDocuments';
import type { VehiclePhoto } from '../vehicles';

const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';
type VehicleOcr =
  | {kind:'vehicle_plate';fields:Record<string,{value:string;confidence:number;basis:string}>;requiresHumanReview:true}
  | {kind:'vehicle_odometer';candidates:Array<{value:number;confidence:number;basis:string}>;requiresHumanReview:true};

function VehicleOcrReadout({result}:{result:VehicleOcr | undefined}) {
  const {t}=useI18n();
  if(!result) return null;
  return <div className="small" role="status">
    <strong>{t('photos.ocrSuggestion')}</strong>
    <p className="muted">{t('photos.ocrReview')}</p>
    {result.kind==='vehicle_plate'
      ? Object.entries(result.fields).map(([key,item])=>
          <p key={key}><bdi>{key}: {item.value}</bdi> ({Math.round(item.confidence*100)}%)</p>)
      : result.candidates.map((item,i)=>
          <p key={i}><bdi>{item.value.toLocaleString()} km</bdi> ({Math.round(item.confidence*100)}%)</p>)}
  </div>;
}


/**
 * Vehicle photos from the phone (camera or gallery) or a computer. Several files are sent one by
 * one; the failed ones stay in a list with a retry button (re-sending the same photo is harmless:
 * the server recognises identical bytes).
 */
export function VehiclePhotos({ vehicleId, readOnly }: { vehicleId: string; readOnly: boolean }) {
  const { can, me } = useAuth();
  const { t, formatDateTime } = useI18n();
  const { data, error, reload } = useApi<{ items: VehiclePhoto[] }>(`/vehicles/${vehicleId}/photos`);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<File[]>([]);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<Record<string,VehicleOcr>>({});

  const canEdit = can('vehicles.documents') && !readOnly;

  const send = async (files: File[]) => {
    if (files.length === 0) return;
    const bad: File[] = [];
    let lastError: unknown = null;
    setFailed([]);
    setFailMsg(null);
    setProgress({ done: 0, total: files.length });
    for (const [i, file] of files.entries()) {
      try {
        await uploadFile(`/vehicles/${vehicleId}/photos`, file);
      } catch (err) {
        bad.push(file);
        lastError = err;
      }
      setProgress({ done: i + 1, total: files.length });
    }
    setProgress(null);
    setFailed(bad);
    if (bad.length) setFailMsg(`${t('photos.failed', { n: String(bad.length) })} ${t(uploadErrorKey(lastError))}`);
    if (input.current) input.current.value = '';
    reload();
  };

  const analyzePhoto = async (photoId:string, kind:'vehicle_plate'|'vehicle_odometer') => {
    setOcrBusy(photoId);setFailMsg(null);
    try {
      const value = await api<VehicleOcr>(`/vehicles/${vehicleId}/photos/${photoId}/analyze`,{
        method:'POST',body:{kind},
      });
      setOcrResult(prev=>({...prev,[photoId]:value}));
    } catch(err) {
      setFailMsg(t(errorKey(err)));
    } finally {
      setOcrBusy(null);
    }
  };

  const archive = async (photoId: string) => {
    setConfirmId(null);
    try {
      await api(`/vehicles/${vehicleId}/photos/${photoId}/archive`, { method: 'POST' });
      reload();
    } catch (err) {
      setFailMsg(t(errorKey(err)));
    }
  };

  return (
    <div className="card" id="photos">
      <div className="card-head">
        <div>
          <h2>{t('photos.title')}</h2>
          {canEdit && <p className="muted small">{t('photos.hint')}</p>}
        </div>
        {canEdit && (
          <>
            <button type="button" className="btn btn-small" disabled={progress !== null} onClick={() => input.current?.click()}>
              <ImagePlus size={16} aria-hidden="true" />{' '}
              {progress ? t('photos.uploading', { done: String(progress.done), total: String(progress.total) }) : t('photos.add')}
            </button>
            <input
              ref={input}
              type="file"
              accept={PHOTO_ACCEPT}
              multiple
              hidden
              aria-label={t('photos.add')}
              onChange={(e) => void send(Array.from(e.target.files ?? []))}
            />
          </>
        )}
      </div>
      {failMsg && (
        <div className="alert alert-error" role="alert">
          {failMsg}
          {failed.length > 0 && (
            <div className="actions">
              <button type="button" className="btn btn-small" onClick={() => void send(failed)}>
                {t('photos.retry')}
              </button>
            </div>
          )}
        </div>
      )}
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <p className="muted">{t('photos.none')}</p>
      ) : (
        <ul className="photo-grid">
          {data.items.map((p) => (
            <li key={p.id}>
              <a href={fileUrl(vehicleId, p.fileId)} target="_blank" rel="noopener noreferrer">
                <img src={fileUrl(vehicleId, p.fileId)} alt={p.caption ?? t('photos.title')} loading="lazy" />
              </a>
              {me?.user.role==='manager' && (
                <div className="actions">
                  <button type="button" className="btn btn-small" disabled={ocrBusy!==null}
                    onClick={()=>void analyzePhoto(p.id,'vehicle_plate')}>{t('photos.ocrPlate')}</button>
                  <button type="button" className="btn btn-small" disabled={ocrBusy!==null}
                    onClick={()=>void analyzePhoto(p.id,'vehicle_odometer')}>{t('photos.ocrMileage')}</button>
                </div>
              )}
              <VehicleOcrReadout result={ocrResult[p.id]}/>
              <div className="photo-meta small muted">
                <span>{formatDateTime(p.createdAt)}</span>
                {canEdit &&
                  (confirmId === p.id ? (
                    <span className="photo-confirm">
                      <button type="button" className="btn btn-small" onClick={() => setConfirmId(null)}>
                        {t('common.cancel')}
                      </button>
                      <button type="button" className="btn btn-small btn-danger" onClick={() => void archive(p.id)}>
                        {t('photos.archive')}
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="icon-btn" aria-label={t('photos.archive')} title={t('photos.archive')} onClick={() => setConfirmId(p.id)}>
                      <Trash2 size={18} aria-hidden="true" />
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
