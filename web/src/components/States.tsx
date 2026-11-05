import { ApiError } from '../api';
import { useI18n, type MessageKey } from '../i18n';

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {t('common.loading')}
    </div>
  );
}

export function Empty({ messageKey = 'common.empty' }: { messageKey?: MessageKey }) {
  const { t } = useI18n();
  return <div className="state state-empty">{t(messageKey)}</div>;
}

export function errorKey(err: unknown): MessageKey {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'error.network';
    if (err.status === 403) return 'error.forbidden';
    if (err.status === 404) return 'error.notFound';
    if (err.status === 429) return 'error.rateLimited';
    if (err.code === 'validation_failed') return 'error.validation';
  }
  return 'error.generic';
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="state state-error" role="alert">
      <p>{t(errorKey(error))}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}
