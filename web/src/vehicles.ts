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
