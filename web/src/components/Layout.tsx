import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Ellipsis, LogOut } from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { BrandMark, useBranding } from '../branding';
import { LanguageSwitcher } from './LanguageSwitcher';
import { visibleNavItems } from './navigation';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function Layout() {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  const brand = useBranding();
  const location = useLocation();
  if (!me) return null;
  const items = visibleNavItems(me.permissions);
  const role = t(me.user.role === 'manager' ? 'role.manager' : 'role.employee');

  const links = (variant: 'side' | 'bottom') =>
    (variant === 'bottom' ? items.filter((i) => i.primary) : items).map((i) => {
      const Icon = i.icon;
      return (
        <li key={i.to}>
          <NavLink to={i.to} end={i.to === '/'}>
            <Icon aria-hidden="true" size={variant === 'side' ? 20 : 22} strokeWidth={1.8} />
            <span>{t(i.labelKey)}</span>
          </NavLink>
        </li>
      );
    });

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="sidebar-brand" aria-label={brand.name ?? t('app.name')}>
          <BrandMark size={48} />
          <span className="brand-text">
            <span className="brand-name">{brand.name ?? t('app.name')}</span>
            <span className="brand-city">{brand.city ?? t('brand.space')}</span>
          </span>
        </NavLink>
        <nav aria-label={t('nav.menu')}>
          <ul>{links('side')}</ul>
        </nav>
        <div className="sidebar-foot">{t('brand.poweredBy')}</div>
      </aside>

      <header className="topbar">
        <NavLink to="/" className="topbar-brand">
          <BrandMark size={34} />
          <span>{brand.name ?? t('app.name')}</span>
        </NavLink>
        <div className="topbar-end">
          <LanguageSwitcher />
          <NavLink to="/account" className="user-chip" title={`${me.user.email} · ${t('nav.account')}`}>
            <span className="avatar" aria-hidden="true">
              {initials(me.user.fullName)}
            </span>
            <span className="user-text">
              <strong>{me.user.fullName}</strong>
              <small>{role}</small>
            </span>
          </NavLink>
          <button type="button" className="btn btn-ghost btn-logout" onClick={() => void logout()} aria-label={t('nav.logout')}>
            <LogOut aria-hidden="true" size={18} className="flip-rtl" />
            <span>{t('nav.logoutShort')}</span>
          </button>
        </div>
      </header>

      <main className={`content${location.pathname === '/' ? ' content--agenda' : ''}`}>
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label={t('nav.menu')}>
        <ul>
          {links('bottom')}
          <li>
            <NavLink to="/more">
              <Ellipsis aria-hidden="true" size={22} strokeWidth={1.8} />
              <span>{t('nav.more')}</span>
            </NavLink>
          </li>
        </ul>
      </nav>
    </div>
  );
}
