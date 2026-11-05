import { NavLink } from 'react-router-dom';
import { ChevronRight, LogOut } from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { visibleNavItems } from '../components/navigation';
import { PageHeader } from '../components/PageHeader';

/** Phone: everything that is not in the bottom bar, as one big list. */
export function MorePage() {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  if (!me) return null;
  const items = visibleNavItems(me.permissions).filter((i) => !i.primary);
  return (
    <section>
      <PageHeader title={t('more.title')} />
      <ul className="more-list card">
        {items.map((i) => {
          const Icon = i.icon;
          return (
            <li key={i.to}>
              <NavLink to={i.to}>
                <Icon size={22} aria-hidden="true" />
                <span>{t(i.labelKey)}</span>
                <ChevronRight size={18} aria-hidden="true" className="flip-rtl chevron" />
              </NavLink>
            </li>
          );
        })}
        <li>
          <button type="button" onClick={() => void logout()}>
            <LogOut size={22} aria-hidden="true" className="flip-rtl" />
            <span>{t('nav.logout')}</span>
          </button>
        </li>
      </ul>
    </section>
  );
}
