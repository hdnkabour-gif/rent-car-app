import { BarChart3, MessageCircle, Wallet, Wrench, Building2, CalendarDays, CarFront, CircleUserRound, Contact, FileSignature, FileText, History, House, MapPin, UsersRound, BookOpen, type LucideIcon } from 'lucide-react';
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
  { to: '/reservations', labelKey: 'nav.reservations', permission: 'reservations.read', icon: CalendarDays, primary: true },
  { to: '/customer-intakes', labelKey: 'nav.intakes', permission: 'reservations.read', icon: FileSignature },
  { to: '/vehicles', labelKey: 'nav.vehicles', permission: 'vehicles.read', icon: CarFront, primary: true },
  { to: '/contracts', labelKey: 'nav.contracts', permission: 'contracts.read', icon: FileText, primary: true },
  { to: '/customers', labelKey: 'nav.customers', permission: 'customers.read', icon: Contact },
  { to: '/customer-merges', labelKey: 'merge.title', permission: 'customers.manage', icon: UsersRound },
  { to: '/cash', labelKey: 'nav.cash', permission: 'cash.read', icon: Wallet },
  { to: '/reminders', labelKey: 'nav.reminders', permission: 'reminders.send', icon: MessageCircle },
  { to: '/maintenance', labelKey: 'nav.maintenance', permission: 'vehicles.read', icon: Wrench },
  { to: '/catalog', labelKey: 'nav.catalog', permission: 'vehicles.read', icon: BookOpen },
  { to: '/reports', labelKey: 'nav.reports', permission: 'reports.read', icon: BarChart3 },
  { to: '/branches', labelKey: 'nav.branches', permission: 'branches.manage', icon: MapPin },
  { to: '/settings/company', labelKey: 'nav.companySettings', permission: 'company_settings.read', icon: Building2 },
  { to: '/users', labelKey: 'nav.users', permission: 'users.read', icon: UsersRound },
  { to: '/settings/contract', labelKey: 'nav.contractTemplate', permission: 'contracts.templates', icon: FileSignature },
  { to: '/audit', labelKey: 'nav.audit', permission: 'audit_logs.read', icon: History },
  { to: '/account', labelKey: 'nav.account', icon: CircleUserRound },
];

export function visibleNavItems(permissions: string[]): NavItem[] {
  return NAV_ITEMS.filter((i) => !i.permission || permissions.includes(i.permission));
}
