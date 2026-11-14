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
  catalogModelId: string | null;
  catalogGenerationId: string | null;
  catalogEngineId: string | null;
  catalogGenerationLabel: string | null;
  catalogEngineVersion: string | null;
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
  dailyRateCents: number | null;
  depositCents: number | null;
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
  review?: {status:'approved'|'rejected';fields:Record<string,string>;revision:number;reviewedAt:string}|null;
  file: { id: string; mimeType: string; sizeBytes: number; name: string | null } | null;
}

export interface VehiclePhoto {
  id: string;
  caption: string | null;
  createdAt: string;
  createdBy: string | null;
  fileId: string;
}


export interface VehicleCatalogBrand {
  id: string;
  name: string;
  segment: string | null;
  marketNote: string | null;
  verificationStatus: string;
}
export interface VehicleCatalogModel {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  dataStatus: string;
  notes: string | null;
  sourceNote: string | null;
  startYear: number | null;
  endYear: number | null;
  bodyType: string | null;
  engineDescriptions: string | null;
  generationLabel: string | null;
  engineCode: string | null;
  fuelType: string | null;
  transmission: string | null;
  powerKw: number | null;
  displacementCm3: number | null;
  checkedOn: string | null;
}
export interface VehicleCatalogGeneration {
  id: string;
  brandId: string;
  modelId: string;
  label: string;
  generationCode: string | null;
  productionStartYear: number | null;
  productionEndYear: number | null;
  referenceYear: number | null;
  bodyType: string | null;
  market: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  verificationStatus: string;
  notes: string | null;
}
export interface VehicleCatalogEngine {
  id: string;
  generationId: string;
  commercialVersion: string;
  engineDesignation: string | null;
  engineCode: string | null;
  displacementCm3: number | null;
  cylinders: number | null;
  fuelType: string | null;
  powerHp: number | null;
  powerKw: number | null;
  torqueNm: number | null;
  gearbox: string | null;
  gears: number | null;
  sourceId: string | null;
  verificationStatus: string;
  notes: string | null;
}
export interface VehicleCatalogTireBrand {
  id: string; name: string; origin: string | null; positioning: string | null; availability: string | null;
}
export interface VehicleCatalogTireModel {
  id: string; brandId: string; brandName: string; name: string;
  vehicleType: string | null; season: string | null; usage: string | null; verification: string | null;
}
export interface VehicleCatalogTireSize {
  size: string; widthMm: number | null; aspectRatio: number | null; rimInches: number | null;
  loadIndex: string | null; speedIndex: string | null; reinforced: string | null; runFlat: string | null;
  compatibilityStatus: string; note: string | null;
}
export interface VehicleCatalogTireFitment {
  id: string; generationId: string; engineId: string | null; generationLabel: string;
  engineVersion: string | null; trim: string | null; position: string | null; dimension: string;
  loadIndex: string | null; speedIndex: string | null; reinforced: string | null; runFlat: string | null;
  compatibilityType: string | null; sourceId: string | null; sourceUrl: string | null; checkedOn: string | null;
  verificationStatus: string; notes: string | null;
}
export interface VehicleCatalogOilBrand {
  id: string; name: string; origin: string | null; availability: string | null;
}
export interface VehicleCatalogOilProduct {
  id: string; brandId: string; brandName: string; name: string; indicativeViscosity: string | null;
  technology: string | null; usage: string | null; verification: string | null; acea: string | null;
  api: string | null; oemApproval: string | null; packaging: string | null; itemReference: string | null;
  technicalSheetSource: string | null; finalStatus: string | null;
}
export interface VehicleCatalogOilFitment {
  id: string; generationId: string; engineId: string; generationLabel: string; engineVersion: string;
  fitmentEngineVersion: string | null; saeViscosity: string | null; acea: string | null; api: string | null;
  oemApproval: string | null; capacityL: number | null; oilFilterRef: string | null; sourceId: string | null;
  verificationStatus: string; notes: string | null;
}
export interface VehicleCatalogMaintenance {
  id: string; name: string; examples: string | null; intervalGuidance: string | null; sourceStatus: string | null;
}
export interface VehicleCatalogMarketPriority {
  rank: number; brandName: string; modelName: string; registrations: number | null;
  marketSharePct: number | null; period: string; sourceId: string | null; notes: string | null;
}
export interface VehicleCatalogSource {
  id: string; publisher: string; title: string; sourceType: string | null; url: string | null;
  sourceDate: string | null; scope: string | null; reliability: string | null; notes: string | null;
}
export interface VehicleCatalogStatusReference {
  code: string; appStatus: string; label: string; triggerDescription: string | null; blocksRental: boolean | null;
  expectedAction: string | null; exitRule: string | null;
}
export interface VehicleCatalog {
  brands: VehicleCatalogBrand[];
  models: VehicleCatalogModel[];
  generations: VehicleCatalogGeneration[];
  engines: VehicleCatalogEngine[];
  tireBrands: VehicleCatalogTireBrand[];
  tireModels: VehicleCatalogTireModel[];
  tireSizes: VehicleCatalogTireSize[];
  tireFitments: VehicleCatalogTireFitment[];
  oilBrands: VehicleCatalogOilBrand[];
  oilProducts: VehicleCatalogOilProduct[];
  oilFitments: VehicleCatalogOilFitment[];
  maintenance: VehicleCatalogMaintenance[];
  marketPriority: VehicleCatalogMarketPriority[];
  sources: VehicleCatalogSource[];
  statusReference: VehicleCatalogStatusReference[];
  compatibilityIsAdvisory: boolean;
}
