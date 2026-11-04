export const VEHICLE_STATUSES = ['available', 'rented', 'inspection_pending', 'maintenance', 'out_of_service', 'retired'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export interface Branch {
  id: string;
  code: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  vehicleCount: number;
}

export interface Vehicle {
  id: string;
  branch: { id: string; name: string; code: string };
  internalCode: string | null;
  plate: string;
  make: string;
  model: string;
  version: string | null;
  modelYear: number | null;
  color: string | null;
  fuelType: 'diesel' | 'petrol' | 'hybrid' | 'electric' | 'lpg';
  transmission: 'manual' | 'automatic';
  seats: number | null;
  category: string | null;
  vin: string | null;
  status: VehicleStatus;
  statusChangedAt: string;
  mileageKm: number;
  fuelEighths: number | null;
  notes: string | null;
  firstRegistrationDate: string | null;
  documentAlert: 'expired' | 'expiring' | null;
}

export interface AllowedTransition {
  to: VehicleStatus;
  reasonRequired: boolean;
  inspection: boolean;
}

export interface HistoryEntry {
  id: number;
  from: VehicleStatus | null;
  to: VehicleStatus;
  at: string;
  by: string | null;
  reason: string | null;
  mileageKm: number | null;
  fuelEighths: number | null;
  cleaned: boolean | null;
  notes: string | null;
}

export const formatKm = (n: number) => new Intl.NumberFormat('fr-MA').format(n);

export const DOC_TYPES = ['registration', 'insurance', 'technical_inspection', 'vignette', 'transport_authorization', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface VehicleDocument {
  id: string;
  docType: DocType;
  label: string | null;
  number: string | null;
  issuer: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  notes: string | null;
  status: 'valid' | 'expiring' | 'expired' | 'no_expiry' | 'archived';
  daysLeft: number | null;
  file: { id: string; mimeType: string; sizeBytes: number; name: string | null } | null;
}

export interface VehiclePhoto {
  id: string;
  caption: string | null;
  createdAt: string;
  createdBy: string | null;
  fileId: string;
}
