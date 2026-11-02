import { Building2, History, House, UsersRound, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n';

export interface NavItem {
  to: string;
  labelKey: MessageKey;
  permission: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.dashboard', permission: 'dashboard.view', icon: House },
  { to: '/settings/company', labelKey: 'nav.companySettings', permission: 'company_settings.read', icon: Building2 },
  { to: '/users', labelKey: 'nav.users', permission: 'users.read', icon: UsersRound },
  { to: '/audit', labelKey: 'nav.audit', permission: 'audit_logs.read', icon: History },
];

export function visibleNavItems(permissions: string[]): NavItem[] {
  return NAV_ITEMS.filter((i) => permissions.includes(i.permission));
}
