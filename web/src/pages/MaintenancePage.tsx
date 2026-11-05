import { useI18n } from '../i18n';
import { PageHeader } from '../components/PageHeader';
import { MaintenanceDueList } from '../components/Maintenance';

export function MaintenancePage() {
  const { t } = useI18n();
  return (
    <section>
      <PageHeader title={t('mt.title')} subtitle={t('mt.subtitle')} />
      <div className="card">
        <h2>{t('mt.dueList')}</h2>
        <MaintenanceDueList />
      </div>
    </section>
  );
}
