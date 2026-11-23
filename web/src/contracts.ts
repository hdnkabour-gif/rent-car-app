export interface ContractSnapshot {
  company: {
    name: string | null;
    legalName: string | null;
    ice: string | null;
    ifNumber: string | null;
    rcNumber: string | null;
    address: string | null;
    phone: string | null;
    phone2: string | null;
    logoFileId: string | null;
    footer: string | null;
  };
  customer: {
    fullName: string;
    customerType: 'individual' | 'company';
    companyIce: string | null;
    nationality: string | null;
    birthDate: string | null;
    profession: string | null;
    idDocType: 'cin' | 'passport' | 'residence_permit' | 'other' | null;
    idDocNumber: string | null;
    idDocCountry: string | null;
    idDocIssueDate: string | null;
    idDocExpiry: string | null;
    licenceNumber: string | null;
    licenceIssueDate: string | null;
    licenceCountry: string | null;
    licenceExpiry: string | null;
    address: string | null;
    otherAddress: string | null;
    phone: string;
  };
  vehicle: { make: string; model: string; plate: string; fuelType: string };
  reservation: { reference: string; pickupPlace: string; pickupDetails: string | null; returnPlace: string; returnDetails: string | null };
  branch: string | null;
  returnBranch: string | null;
}

export interface Contract {
  id: string;
  number: number;
  reference: string;
  paperNumber: string | null;
  status: 'open' | 'closed';
  reservation: { id: string; reference: string };
  customer: { id: string; fullName: string; phone: string };
  vehicle: { id: string; plate: string; make: string; model: string };
  branch: { id: string; name: string };
  returnBranch: { id: string; name: string };
  templateVersion: number;
  outAt: string;
  plannedEndAt: string;
  kmOut: number;
  fuelOut: number;
  washedOut: boolean | null;
  documentsOut: string[];
  notesOut: string | null;
  outBy: string | null;
  dailyCents: number;
  days: number;
  late: {
    minutes: number | null;
    status: 'none' | 'pending' | 'charged' | 'waived';
    unit: 'day' | 'half_day' | 'hour' | null;
    quantity: number | null;
    unitCents: number | null;
    feeCents: number;
    reason: string | null;
    decidedAt: string | null;
  };
  totalCents: number;
  depositCents: number;
  inAt: string | null;
  kmIn: number | null;
  fuelIn: number | null;
  notesIn: string | null;
  inBy: string | null;
  kmDriven: number | null;
  signedScanFileId: string | null;
  snapshot: ContractSnapshot;
}

export interface Balances {
  totalCents: number;
  paidCents: number;
  restCents: number;
  depositReceivedCents: number;
  depositReturnedCents: number;
  depositKeptCents: number;
  depositHeldCents: number;
}

export type PaymentKind = 'rental' | 'deposit_in' | 'deposit_out' | 'deposit_kept' | 'reversal' | 'rental_refund';
export type PaymentMethod = 'cash' | 'transfer' | 'cheque' | 'card';

export interface Payment {
  id: string;
  kind: PaymentKind;
  method: PaymentMethod;
  amountCents: number;
  reference: string | null;
  reason: string | null;
  reversesId: string | null;
  reversedBy: string | null;
  createdAt: string;
  by: string | null;
}

export interface Driver {
  id?: string;
  fullName: string;
  birthDate: string | null;
  licenceNumber: string | null;
  licenceIssueDate: string | null;
  licenceIssuePlace: string | null;
  idNumber: string | null;
  idIssueDate: string | null;
  phone: string | null;
}

export interface Article {
  title: string;
  body: string;
}

export interface ContractTemplate {
  id: string;
  version: number;
  title: string;
  handedDocuments: string[];
  responsibilityClause: string | null;
  termsTitle: string;
  terms: Article[];
  termsAr: Article[] | null;
  showVehicleDiagram: boolean;
  secondDriverSection: boolean;
  notes: string | null;
  createdAt: string;
}

export interface ContractDetail {
  contract: Contract;
  balances: Balances;
  drivers: Driver[];
  photos: Array<{ id: string; phase: 'out' | 'in'; fileId: string; createdAt: string }>;
  events: Array<{ id: number; event: string; details: Record<string, unknown>; reason: string | null; at: string; by: string | null }>;
  payments: Payment[];
  template: ContractTemplate;
}

export const contractFileUrl = (contractId: string, fileId: string) => `/api/contracts/${contractId}/files/${fileId}`;
