import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { BrandingProvider, isJmrBrand, readableOn, useBranding } from './branding';
import { useI18n } from './i18n';
import { Layout } from './components/Layout';
import { RequirePermission } from './components/RequirePermission';
import { ErrorState } from './components/States';
import { BrandSplash } from './components/BrandSplash';
import { readAgenda } from './agendaPrefetch';
import { moroccoDate } from './agenda';
import { ApiError } from './api';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { CompanySettingsPage } from './pages/CompanySettingsPage';
import { UsersPage } from './pages/UsersPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { VehiclesPage } from './pages/VehiclesPage';
import { VehicleDetailPage } from './pages/VehicleDetailPage';
import { VehicleFormPage } from './pages/VehicleFormPage';
import { BranchesPage } from './pages/BranchesPage';
import { MorePage } from './pages/MorePage';
import { AccountPage } from './pages/AccountPage';
import { CustomersPage } from './pages/CustomersPage';
import { CustomerDetailPage } from './pages/CustomerDetailPage';
import { CustomerFormPage } from './pages/CustomerFormPage';
import { ReservationsPage } from './pages/ReservationsPage';
import { CustomerIntakeGuestPage } from './pages/CustomerIntakeGuestPage';
import { CustomerIntakeStaffPage } from './pages/CustomerIntakeStaffPage';
import { CustomerMergePage } from './pages/CustomerMergePage';
import { ReservationFormPage } from './pages/ReservationFormPage';
import { ReservationDetailPage } from './pages/ReservationDetailPage';
import { ContractsPage } from './pages/ContractsPage';
import { ContractDetailPage } from './pages/ContractDetailPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { ContractPrintPage } from './pages/ContractPrintPage';
import { ContractTemplatePage } from './pages/ContractTemplatePage';
import { CashPage } from './pages/CashPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { InfractionsPage } from './pages/InfractionsPage';
import { RemindersPage } from './pages/RemindersPage';
import { ReportsPage } from './pages/ReportsPage';
import { VehicleCatalogPage } from './pages/VehicleCatalogPage';

/** Company colour for every screen, login included. */
function BrandTheme({ children }: { children: ReactNode }) {
  const brand = useBranding();
  const style = { '--brand': brand.color, '--on-brand': readableOn(brand.color) } as CSSProperties;
  return (
    <div className={`brand-root${isJmrBrand(brand.name) ? " jmr-brand" : ""}`} style={style}>
      {children}
    </div>
  );
}

export function App() {
  return (
    <BrandingProvider>
      <BrandTheme>
        <AppRoutes />
      </BrandTheme>
    </BrandingProvider>
  );
}

function AppRoutes() {
  const { status, refresh, me, can } = useAuth();
  const brand = useBranding();
  const { t } = useI18n();
  const location = useLocation();
  const [phase, setPhase] = useState<'icon' | 'logo' | 'finish' | 'loading'>('icon');
  const [introProgress, setIntroProgress] = useState(0);
  const [introComplete, setIntroComplete] = useState(false);
  const [logoAsset, setLogoAsset] = useState<string | null | undefined>(undefined);
  const [resolvedAgendaKey, setResolvedAgendaKey] = useState<string | null>(null);
  const [brandFallback, setBrandFallback] = useState(false);
  const onLogoReady = useCallback((src: string | null) => setLogoAsset(src), []);
  const brandReady = brand.ready || brandFallback;
  const logoSrc = brand.logo ?? ((isJmrBrand(brand.name) || !brand.name) ? '/branding/jmr-logo.png' : null);
  const imageReady = logoSrc === logoAsset || (logoSrc === null && logoAsset === null);
  const dayKey = status === 'authenticated' && me && location.pathname === '/' && can('dashboard.view')
    ? `${me.user.id}:${moroccoDate()}` : 'skip';
  const agendaReady = dayKey === 'skip' || resolvedAgendaKey === dayKey;
  const assetsComplete = introComplete && imageReady && brandReady;
  const bootComplete = status === 'authenticated' && assetsComplete && agendaReady;

  useEffect(() => {
    const fallback = window.setTimeout(() => setBrandFallback(true), 4500);
    return () => window.clearTimeout(fallback);
  }, []);
  useEffect(() => {
    if (!brandReady) return;
    // The cinematic sequence is a minimum of six seconds, independent of fast responses.
    // Its progress represents the intro/readiness gate, NOT a fabricated network percentage.
    const started = Date.now();
    const stages = [
      window.setTimeout(() => setPhase('logo'), 1800),
      window.setTimeout(() => setPhase('finish'), 3900),
      window.setTimeout(() => { setPhase('loading'); setIntroComplete(true); }, 6000),
    ];
    const interval = window.setInterval(() => {
      setIntroProgress(Math.min(95, Math.floor((Date.now() - started) / 6000 * 95)));
    }, 90);
    return () => { stages.forEach(window.clearTimeout); window.clearInterval(interval); };
  }, [brandReady]);
  useEffect(() => {
    if (dayKey === 'skip') return;
    const [userId, date] = dayKey.split(':');
    let active = true;
    void readAgenda(userId!, date!).then(
      () => { if (active) setResolvedAgendaKey(dayKey); },
      () => { if (active) setResolvedAgendaKey(dayKey); }, // the dashboard shows a retry, never traps users
    );
    return () => { active = false; };
  }, [dayKey]);
  // A stalled asset request must never trap someone on a loading screen.
  useEffect(() => {
    if (!logoSrc) return;
    const timer = window.setTimeout(() => setLogoAsset(logoSrc), 6500);
    return () => window.clearTimeout(timer);
  }, [logoSrc]);

  // Guest collection must not require a staff session or expose the staff application shell.
  if (/^\/collect\/[0-9a-f-]{36}$/i.test(location.pathname)) {
    return <Routes><Route path="collect/:id" element={<CustomerIntakeGuestPage/>}/></Routes>;
  }

  if (status === 'loading') return <BrandSplash phase={phase} progress={assetsComplete && agendaReady ? 100 : introProgress} onAssetReady={onLogoReady} />;
  if (status === 'error') return <ErrorState error={new ApiError(0, 'network_error', '')} onRetry={() => void refresh()} />;
  if (status === 'anonymous') {
    return (
      <>
        {!(introComplete && imageReady && brandReady) && <BrandSplash phase={phase} progress={assetsComplete && agendaReady ? 100 : introProgress} onAssetReady={onLogoReady} />}
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </>
    );
  }

  return (
    <>
      {!bootComplete && <BrandSplash phase={phase} progress={assetsComplete && agendaReady ? 100 : introProgress} onAssetReady={onLogoReady} />}
      <Routes>
      {/* Printable contract: no app shell around it. */}
      <Route
        path="contracts/:id/print"
        element={
          <RequirePermission permission="contracts.read">
            <ContractPrintPage />
          </RequirePermission>
        }
      />
      <Route element={<Layout />}>
        <Route
          index
          element={
            <RequirePermission permission="dashboard.view">
              <DashboardPage />
            </RequirePermission>
          }
        />
        <Route
          path="settings/company"
          element={
            <RequirePermission permission="company_settings.read">
              <CompanySettingsPage />
            </RequirePermission>
          }
        />
        <Route
          path="users"
          element={
            <RequirePermission permission="users.read">
              <UsersPage />
            </RequirePermission>
          }
        />
        <Route
          path="audit"
          element={
            <RequirePermission permission="audit_logs.read">
              <AuditLogPage />
            </RequirePermission>
          }
        />
        <Route
          path="vehicles"
          element={
            <RequirePermission permission="vehicles.read">
              <VehiclesPage />
            </RequirePermission>
          }
        />
        <Route
          path="vehicles/new"
          element={
            <RequirePermission permission="vehicles.manage">
              <VehicleFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="vehicles/:id"
          element={
            <RequirePermission permission="vehicles.read">
              <VehicleDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="vehicles/:id/edit"
          element={
            <RequirePermission permission="vehicles.manage">
              <VehicleFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="branches"
          element={
            <RequirePermission permission="branches.manage">
              <BranchesPage />
            </RequirePermission>
          }
        />
        <Route
          path="customers"
          element={
            <RequirePermission permission="customers.read">
              <CustomersPage />
            </RequirePermission>
          }
        />
        <Route
          path="customers/new"
          element={
            <RequirePermission permission="customers.manage">
              <CustomerFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="customers/:id"
          element={
            <RequirePermission permission="customers.read">
              <CustomerDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="customers/:id/edit"
          element={
            <RequirePermission permission="customers.manage">
              <CustomerFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="reservations"
          element={
            <RequirePermission permission="reservations.read">
              <ReservationsPage />
            </RequirePermission>
          }
        />
        <Route
          path="reservations/new"
          element={
            <RequirePermission permission="reservations.manage">
              <ReservationFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="reservations/:id"
          element={
            <RequirePermission permission="reservations.read">
              <ReservationDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="reservations/:id/edit"
          element={
            <RequirePermission permission="reservations.manage">
              <ReservationFormPage />
            </RequirePermission>
          }
        />
        <Route path="customer-merges" element={
          <RequirePermission permission="customers.manage"><CustomerMergePage/></RequirePermission>
        } />
        <Route path="customer-intakes" element={
          <RequirePermission permission="reservations.read"><CustomerIntakeStaffPage/></RequirePermission>
        } />
        <Route
          path="contracts"
          element={
            <RequirePermission permission="contracts.read">
              <ContractsPage />
            </RequirePermission>
          }
        />
        <Route
          path="contracts/new"
          element={
            <RequirePermission permission="contracts.manage">
              <CheckoutPage />
            </RequirePermission>
          }
        />
        <Route
          path="contracts/:id"
          element={
            <RequirePermission permission="contracts.read">
              <ContractDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="settings/contract"
          element={
            <RequirePermission permission="contracts.templates">
              <ContractTemplatePage />
            </RequirePermission>
          }
        />
        <Route
          path="cash"
          element={
            <RequirePermission permission="cash.read">
              <CashPage />
            </RequirePermission>
          }
        />
        <Route
          path="infractions"
          element={<RequirePermission permission="infractions.read"><InfractionsPage /></RequirePermission>}
        />
        <Route
          path="maintenance"
          element={
            <RequirePermission permission="vehicles.read">
              <MaintenancePage />
            </RequirePermission>
          }
        />
        <Route
          path="reminders"
          element={
            <RequirePermission permission="reminders.send">
              <RemindersPage />
            </RequirePermission>
          }
        />
        <Route
          path="reports"
          element={
            <RequirePermission permission="reports.read">
              <ReportsPage />
            </RequirePermission>
          }
        />
        <Route
          path="catalog"
          element={
            <RequirePermission permission="vehicles.read">
              <VehicleCatalogPage />
            </RequirePermission>
          }
        />
        <Route path="more" element={<MorePage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<div className="state">{t('error.notFound')}</div>} />
      </Route>
      </Routes>
    </>
  );
}
