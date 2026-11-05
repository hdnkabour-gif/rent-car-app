export type ExpiryStatus = 'valid' | 'expiring' | 'expired' | null;

export interface Customer {
  id: string;
  customerType: 'individual' | 'company';
  fullName: string;
  companyIce: string | null;
  contactPerson: string | null;
  birthDate: string | null;
  nationality: string | null;
  residence: 'morocco' | 'abroad_mre' | 'abroad_foreign';
  phone: string;
  phoneKey: string;
  phone2: string | null;
  whatsappSamePhone: boolean;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  preferredLanguage: 'fr' | 'ar' | 'en' | 'es';
  idDocType: 'cin' | 'passport' | 'residence_permit' | 'other' | null;
  idDocNumber: string | null;
  idDocCountry: string | null;
  idDocExpiry: string | null;
  idDocStatus: ExpiryStatus;
  licenceNumber: string | null;
  licenceCategory: string | null;
  licenceCountry: string | null;
  licenceIssueDate: string | null;
  licenceExpiry: string | null;
  licenceStatus: ExpiryStatus;
  notes: string | null;
  profession: string | null;
  otherAddress: string | null;
  idDocIssueDate: string | null;
  blocked: { at: string; reason: string; by: string | null } | null;
  documentCount: number;
  pendingDocuments: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CUSTOMER_DOC_KINDS = ['id_front', 'id_back', 'passport', 'licence_front', 'licence_back', 'residence_permit', 'other'] as const;
export type CustomerDocKind = (typeof CUSTOMER_DOC_KINDS)[number];

export interface CustomerDocument {
  id: string;
  kind: CustomerDocKind;
  source: 'direct_upload' | 'whatsapp_batch';
  reviewStatus: 'pending' | 'verified' | 'rejected';
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  file: { id: string; mimeType: string; sizeBytes: number; name: string | null };
}

export interface DuplicateMatch {
  id: string;
  fullName: string;
  phone: string;
  reasons: Array<'phone' | 'id_document' | 'licence'>;
}

/** Countries most often seen at a Moroccan agency; any other country can still be typed. */
export const COMMON_COUNTRIES = [
  'Maroc',
  'France',
  'Espagne',
  'Belgique',
  'Pays-Bas',
  'Italie',
  'Allemagne',
  'Royaume-Uni',
  'Canada',
  'États-Unis',
  'Suisse',
  'Portugal',
  'Algérie',
  'Tunisie',
  'Arabie saoudite',
  'Émirats arabes unis',
  'Qatar',
] as const;
