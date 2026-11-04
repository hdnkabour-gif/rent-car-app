import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import type { CSSProperties, ReactNode } from 'react';
import { BrandingProvider, readableOn, useBranding } from './branding';
import { useI18n } from './i18n';
import { Layout } from './components/Layout';
import { RequirePermission } from './components/RequirePermission';
import { ErrorState, Loading } from './components/States';
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
import { ReservationFormPage } from './pages/ReservationFormPage';
import { ReservationDetailPage } from './pages/ReservationDetailPage';
import { ContractsPage } from './pages/ContractsPage';
import { ContractDetailPage } from './pages/ContractDetailPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { ContractPrintPage } from './pages/ContractPrintPage';
import { ContractTemplatePage } from './pages/ContractTemplatePage';

/** Company colour for every screen, login included. */
function BrandTheme({ children }: { children: ReactNode }) {
  const brand = useBranding();
  const style = { '--brand': brand.color, '--on-brand': readableOn(brand.color) } as CSSProperties;
  return (
    <div className="brand-root" style={style}>
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
  const { status, refresh } = useAuth();
  const { t } = useI18n();

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <ErrorState error={new ApiError(0, 'network_error', '')} onRetry={() => void refresh()} />;
  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
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
        <Route path="more" element={<MorePage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<div className="state">{t('error.notFound')}</div>} />
      </Route>
    </Routes>
  );
}
