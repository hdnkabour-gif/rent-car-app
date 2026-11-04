import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import type { Article, ContractTemplate } from '../contracts';

interface Version {
  id: string;
  version: number;
  title: string;
  notes: string | null;
  createdAt: string;
  by: string | null;
  contracts: number;
}

/** Each company writes its own contract and general conditions (owner request 2026-11-04). */
export function ContractTemplatePage() {
  // Kept here: the editor is re-created with the new version after a save.
  const [saved, setSaved] = useState<string | null>(null);
  const current = useApi<{ template: ContractTemplate }>('/contract-templates/current');
  const versions = useApi<{ items: Version[] }>('/contract-templates');
  if (current.error) return <ErrorState error={current.error} onRetry={current.reload} />;
  if (!current.data) return <Loading />;
  return (
    <TemplateEditor
      key={current.data.template.version}
      initial={current.data.template}
      versions={versions.data?.items ?? []}
      savedMessage={saved}
      onSaved={(text) => {
        setSaved(text);
        current.reload();
        versions.reload();
      }}
    />
  );
}

function TemplateEditor({ initial, versions, savedMessage, onSaved }: { initial: ContractTemplate; versions: Version[]; savedMessage: string | null; onSaved: (text: string) => void }) {
  const { t, formatDateTime } = useI18n();
  const [title, setTitle] = useState(initial.title);
  const [docs, setDocs] = useState<string[]>(initial.handedDocuments);
  const [clause, setClause] = useState(initial.responsibilityClause ?? '');
  const [termsTitle, setTermsTitle] = useState(initial.termsTitle);
  const [terms, setTerms] = useState<Article[]>(initial.terms);
  const [showDiagram, setShowDiagram] = useState(initial.showVehicleDiagram);
  const [secondDriver, setSecondDriver] = useState(initial.secondDriverSection);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const message = failure ? { text: failure, ok: false } : savedMessage ? { text: savedMessage, ok: true } : null;

  const setArticle = (i: number, k: keyof Article, v: string) => setTerms((x) => x.map((a, j) => (j === i ? { ...a, [k]: v } : a)));
  const move = (i: number, d: -1 | 1) =>
    setTerms((x) => {
      const y = [...x];
      const j = i + d;
      if (j < 0 || j >= y.length) return x;
      [y[i], y[j]] = [y[j]!, y[i]!];
      return y;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const res = await api<{ template: ContractTemplate }>('/contract-templates', {
        method: 'POST',
        body: {
          title,
          handedDocuments: docs.map((d) => d.trim()).filter(Boolean),
          responsibilityClause: clause || null,
          termsTitle,
          terms: terms.filter((a) => a.body.trim()),
          termsAr: initial.termsAr,
          showVehicleDiagram: showDiagram,
          secondDriverSection: secondDriver,
          notes: notes || null,
        },
      });
      onSaved(t('tpl.saved', { v: String(res.template.version) }));
    } catch (err) {
      setFailure(t(errorKey(err)));
      setBusy(false);
    }
  };

  return (
    <section>
      <PageHeader title={t('tpl.title')} subtitle={t('tpl.subtitle')} />
      <p className="muted small">{t('tpl.headerFrom')}</p>
      {message && (
        <div className={`alert ${message.ok ? 'alert-ok' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </div>
      )}
      <form onSubmit={(e) => void submit(e)}>
        <div className="card form-section">
          <div className="grid">
            <label className="field">
              <span>{t('tpl.docTitle')}</span>
              <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={showDiagram} onChange={(e) => setShowDiagram(e.target.checked)} /> {t('tpl.diagram')}
            </label>
            <label className="check">
              <input type="checkbox" checked={secondDriver} onChange={(e) => setSecondDriver(e.target.checked)} /> {t('tpl.secondDriver')}
            </label>
          </div>
          <fieldset className="field">
            <legend>{t('tpl.handed')}</legend>
            <ul className="tpl-docs">
              {docs.map((d, i) => (
                <li key={i}>
                  <input aria-label={`${t('tpl.handed')} ${i + 1}`} maxLength={80} value={d} onChange={(e) => setDocs((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
                  <button type="button" className="icon-btn" aria-label={t('tpl.remove')} onClick={() => setDocs((x) => x.filter((_, j) => j !== i))}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            {docs.length < 20 && (
              <button type="button" className="btn btn-small" onClick={() => setDocs((x) => [...x, ''])}>
                <Plus size={16} aria-hidden="true" /> {t('tpl.addDoc')}
              </button>
            )}
          </fieldset>
          <label className="field">
            <span>{t('tpl.clause')}</span>
            <textarea rows={2} maxLength={1000} value={clause} onChange={(e) => setClause(e.target.value)} />
          </label>
        </div>

        <div className="card form-section">
          <label className="field">
            <span>{t('tpl.termsTitle')}</span>
            <input required maxLength={120} value={termsTitle} onChange={(e) => setTermsTitle(e.target.value)} />
          </label>
          <h3>{t('tpl.articles')}</h3>
          <ol className="tpl-articles">
            {terms.map((a, i) => (
              <li key={i}>
                <div className="tpl-article-head">
                  <input aria-label={`${t('tpl.articleTitle')} ${i + 1}`} placeholder={t('tpl.articleTitle')} maxLength={200} value={a.title} onChange={(e) => setArticle(i, 'title', e.target.value)} />
                  <button type="button" className="icon-btn" aria-label={t('tpl.up')} onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('tpl.down')} onClick={() => move(i, 1)} disabled={i === terms.length - 1}>
                    <ArrowDown size={16} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('tpl.remove')} onClick={() => setTerms((x) => x.filter((_, j) => j !== i))} disabled={terms.length === 1}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
                <textarea aria-label={`${t('tpl.articleBody')} ${i + 1}`} rows={4} maxLength={5000} value={a.body} onChange={(e) => setArticle(i, 'body', e.target.value)} />
              </li>
            ))}
          </ol>
          {terms.length < 60 && (
            <button type="button" className="btn btn-small" onClick={() => setTerms((x) => [...x, { title: `ART ${String(x.length + 1).padStart(2, '0')}`, body: '' }])}>
              <Plus size={16} aria-hidden="true" /> {t('tpl.addArticle')}
            </button>
          )}
        </div>

        <div className="card form-section">
          <label className="field">
            <span>{t('tpl.why')}</span>
            <input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !termsTitle.trim() || !terms.some((a) => a.body.trim())}>
              {busy ? t('common.saving') : t('tpl.save')}
            </button>
          </div>
        </div>
      </form>

      {versions.length > 0 && (
        <div className="card">
          <h2>{t('tpl.versions')}</h2>
          <ul className="plain-list">
            {versions.map((v) => (
              <li key={v.id}>
                {t('tpl.versionLine', { v: String(v.version), date: formatDateTime(v.createdAt), n: String(v.contracts) })}
                {v.version === initial.version && <span className="badge badge-info"> {t('tpl.current')}</span>}
                {v.by && <span className="muted small"> · {v.by}</span>}
                {v.notes && <span className="small"> « {v.notes} »</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
