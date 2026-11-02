import type { MessageKey } from '../i18n';

export interface NavItem {
  to: string;
  labelKey: MessageKey;
  permission: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.dashboard', permission: 'dashboard.view' },
  { to: '/settings/company', labelKey: 'nav.companySettings', permission: 'company_settings.read' },
  { to: '/users', labelKey: 'nav.users', permission: 'users.read' },
  { to: '/audit', labelKey: 'nav.audit', permission: 'audit_logs.read' },
];

export function visibleNavItems(permissions: string[]): NavItem[] {
  return NAV_ITEMS.filter((i) => permissions.includes(i.permission));
}
