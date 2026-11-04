import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { BrandingProvider } from './branding';
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

export function App() {
  const { status, refresh, can } = useAuth();
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
    <BrandingProvider enabled={can('company_settings.read')}>
    <Routes>
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
        <Route path="more" element={<MorePage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<div className="state">{t('error.notFound')}</div>} />
      </Route>
    </Routes>
    </BrandingProvider>
  );
}
