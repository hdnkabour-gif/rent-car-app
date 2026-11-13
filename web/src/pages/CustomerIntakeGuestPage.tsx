import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useI18n } from '../i18n';

type Offer = { vehicle: { make: string; model: string }; startAt: string; endAt: string; days: number;
  dailyCents: number; totalCents: number; depositCents: number; expiresAt: string };
type Kind = 'id_front' | 'id_back' | 'passport' | 'licence_front' | 'licence_back' | 'residence_permit' | 'other';
const KINDS: Kind[] = ['id_front','id_back','passport','licence_front','licence_back','residence_permit','other'];

export function CustomerIntakeGuestPage() {
  const { id = '' } = useParams();
  const { lang, t } = useI18n();
  const [code, setCode] = useState('');
  const [offer, setOffer] = useState<Offer | null>(null);
  const [kind, setKind] = useState<Kind>('id_front');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  const [message, setMessage] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  const stopCamera = () => {
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    setCameraOpen(false);
  };
  useEffect(() => () => { stream.current?.getTracks().forEach(track => track.stop()); }, []);

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const res = await fetch(`/api/guest-intakes/${id}/verify`, {
        method:'POST', credentials:'same-origin',
        headers:{ 'Content-Type':'application/json', 'X-Requested-With':'fleetora' },
        body:JSON.stringify({code}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t('intake.invalidCode'));
      setOffer(data.offer);
      if (data.submitted) setDone(true);
    } catch { setMessage(t('intake.invalidCode')); }
    finally { setBusy(false); }
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length || !consent || busy || done) return;
    setBusy(true); setMessage('');
    let ok = 0; let bad = 0;
    for (const file of files) {
      try {
        const res = await fetch(`/api/guest-intakes/${id}/documents/${kind}`, {
          method: 'POST', credentials: 'same-origin',
          headers: {
            'X-Requested-With':'fleetora', 'X-Intake-Code':code,
            'X-Privacy-Consent':'yes', 'Content-Type':file.type || 'application/octet-stream',
            'X-File-Name':encodeURIComponent(file.name),
          },
          body:file,
        });
        if (!res.ok) throw new Error('Upload refused');
        ok += 1;
      } catch { bad += 1; }
    }
    setUploaded(v => v + ok);
    setMessage(t('intake.uploadResult', { ok:String(ok), bad:String(bad) }));
    setBusy(false);
  };

  const startCamera = async () => {
    setMessage('');
    if (!navigator.mediaDevices?.getUserMedia) { setMessage(t('intake.cameraUnavailable')); return; }
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio:false, video: { facingMode: { ideal:'environment' }, width: { ideal:1920 }, height:{ ideal:1080 } },
      });
      stream.current = media;
      setCameraOpen(true);
      if (video.current) video.current.srcObject = media;
    } catch { setMessage(t('intake.cameraUnavailable')); }
  };
  useEffect(() => {
    if (cameraOpen && video.current && stream.current) video.current.srcObject = stream.current;
  }, [cameraOpen]);

  const capture = async () => {
    if (!video.current || !consent) return;
    const v = video.current;
    if (!v.videoWidth || !v.videoHeight) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) return;
    stopCamera();
    await uploadFiles([new File([blob], 'document-camera.jpg', { type:'image/jpeg' })]);
  };
  const submit = async () => {
    if (!uploaded || busy || done) return;
    setBusy(true); setMessage('');
    try {
      const res = await fetch(`/api/guest-intakes/${id}/submit`, {
        method:'POST', credentials:'same-origin',
        headers: { 'Content-Type':'application/json','X-Requested-With':'fleetora' },
        body: JSON.stringify({code}),
      });
      if (!res.ok) throw new Error('Not submitted');
      stopCamera(); setDone(true);
    } catch { setMessage(t('intake.submitError')); }
    finally { setBusy(false); }
  };

  return (
    <main className="guest-intake">
      <div className="card guest-intake-card">
        <h1>{t('intake.guestTitle')}</h1>
        <p className="muted">{t('intake.guestIntro')}</p>
        {!offer ? (
          <form onSubmit={e => void verify(e)}>
            <label className="field"><span>{t('intake.code')}</span>
              <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{10}"
                maxLength={10} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g,''))} />
            </label>
            <button className="btn btn-primary" disabled={busy} type="submit">{t('intake.open')}</button>
          </form>
        ) : (
          <>
            <div className="card">
              <strong>{offer.vehicle.make} {offer.vehicle.model}</strong>
              <p>{new Date(offer.startAt).toLocaleDateString(lang === 'ar' ? 'ar-MA' : 'fr-MA')} — {new Date(offer.endAt).toLocaleDateString(lang === 'ar' ? 'ar-MA' : 'fr-MA')}</p>
              <p>{t('intake.offerPrice')} : {(offer.totalCents / 100).toFixed(2)} MAD · {t('intake.deposit')} : {(offer.depositCents / 100).toFixed(2)} MAD</p>
              <p className="muted small">{t('intake.notBooking')}</p>
            </div>
            {done ? <div role="status" className="alert alert-ok">{t('intake.completed')}</div> : (
              <>
                <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                  {t('intake.consent')}
                </label>
                <label className="field"><span>{t('intake.documentType')}</span>
                  <select value={kind} onChange={e => setKind(e.target.value as Kind)}>
                    {KINDS.map(k => <option key={k} value={k}>{t(`customers.docs.kind.${k}`)}</option>)}
                  </select>
                </label>
                {!cameraOpen ? (
                  <div className="upload-row">
                    <label className="btn btn-primary" aria-disabled={!consent || busy}>
                      {t('intake.chooseFiles')}
                      <input type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf" multiple
                        disabled={!consent || busy} onChange={e => { void uploadFiles(Array.from(e.target.files ?? [])); e.target.value=''; }} />
                    </label>
                    <button type="button" className="btn" disabled={!consent || busy} onClick={() => void startCamera()}>{t('intake.camera')}</button>
                  </div>
                ) : (
                  <div className="guest-intake-camera">
                    <video ref={video} autoPlay playsInline muted />
                    <div className="guest-intake-frame" aria-hidden="true"/>
                    <div className="upload-row">
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void capture()}>{t('intake.capture')}</button>
                      <button type="button" className="btn" onClick={stopCamera}>{t('intake.cancel')}</button>
                    </div>
                    <p className="small">{t('intake.guide')}</p>
                  </div>
                )}
                <p>{t('intake.uploadedCount', { n:String(uploaded) })}</p>
                <button type="button" className="btn btn-primary" disabled={!uploaded || busy} onClick={() => void submit()}>
                  {t('intake.finish')}
                </button>
              </>
            )}
          </>
        )}
        {message && <div role="alert" className="alert alert-error">{message}</div>}
      </div>
    </main>
  );
}
