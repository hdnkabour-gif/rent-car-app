import { Building2, CarFront, CircleUserRound, History, House, MapPin, UsersRound, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n';

export interface NavItem {
  to: string;
  labelKey: MessageKey;
  /** Omitted: every signed-in account (e.g. own account page). */
  permission?: string;
  icon: LucideIcon;
  /** Shown in the phone's bottom bar; the others are under "Plus". */
  primary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.dashboard', permission: 'dashboard.view', icon: House, primary: true },
  { to: '/vehicles', labelKey: 'nav.vehicles', permission: 'vehicles.read', icon: CarFront, primary: true },
  { to: '/branches', labelKey: 'nav.branches', permission: 'branches.manage', icon: MapPin },
  { to: '/settings/company', labelKey: 'nav.companySettings', permission: 'company_settings.read', icon: Building2 },
  { to: '/users', labelKey: 'nav.users', permission: 'users.read', icon: UsersRound },
  { to: '/audit', labelKey: 'nav.audit', permission: 'audit_logs.read', icon: History },
  { to: '/account', labelKey: 'nav.account', icon: CircleUserRound },
];

export function visibleNavItems(permissions: string[]): NavItem[] {
  return NAV_ITEMS.filter((i) => !i.permission || permissions.includes(i.permission));
}
