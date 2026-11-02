import type { CSSProperties } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { readableOn, useBranding } from '../branding';
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
  if (!me) return null;
  const items = visibleNavItems(me.permissions);
  const style = { '--brand': brand.color, '--on-brand': readableOn(brand.color) } as CSSProperties;
  const role = t(me.user.role === 'manager' ? 'role.manager' : 'role.employee');

  const links = (variant: 'side' | 'bottom') =>
    items.map((i) => {
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
    <div className="shell" style={style}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            {initials(brand.name ?? t('app.name'))}
          </span>
          <span className="brand-name">{brand.name ?? t('app.name')}</span>
        </div>
        <nav aria-label={t('nav.menu')}>
          <ul>{links('side')}</ul>
        </nav>
        <div className="sidebar-foot">{brand.name ? t('app.name') : null}</div>
      </aside>

      <header className="topbar">
        <span className="topbar-brand">{brand.name ?? t('app.name')}</span>
        <div className="topbar-end">
          <LanguageSwitcher />
          <div className="user-chip" title={me.user.email}>
            <span className="avatar" aria-hidden="true">
              {initials(me.user.fullName)}
            </span>
            <span className="user-text">
              <strong>{me.user.fullName}</strong>
              <small>{role}</small>
            </span>
          </div>
          <button type="button" className="btn btn-ghost btn-logout" onClick={() => void logout()} aria-label={t('nav.logout')}>
            <LogOut aria-hidden="true" size={18} className="flip-rtl" />
            <span>{t('nav.logoutShort')}</span>
          </button>
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label={t('nav.menu')}>
        <ul>{links('bottom')}</ul>
      </nav>
    </div>
  );
}
