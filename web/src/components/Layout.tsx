import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';
import { visibleNavItems } from './navigation';

export function Layout() {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const items = visibleNavItems(me.permissions);

  return (
    <div className="shell">
      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost menu-toggle"
          aria-expanded={open}
          aria-controls="main-nav"
          onClick={() => setOpen((o) => !o)}
        >
          ☰ <span className="visually-hidden">{t('nav.menu')}</span>
        </button>
        <span className="brand">{t('app.name')}</span>
        <div className="topbar-end">
          <LanguageSwitcher />
          <span className="user-chip" title={me.user.email}>
            {me.user.fullName} · {t(me.user.role === 'manager' ? 'role.manager' : 'role.employee')}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
            {t('nav.logout')}
          </button>
        </div>
      </header>
      <nav id="main-nav" className={`sidenav${open ? ' open' : ''}`} aria-label={t('nav.menu')}>
        <ul>
          {items.map((i) => (
            <li key={i.to}>
              <NavLink to={i.to} end={i.to === '/'} onClick={() => setOpen(false)}>
                {t(i.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
