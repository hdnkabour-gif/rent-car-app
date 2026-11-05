-- 0004_customers: customer records (residents with CIN, Moroccans living abroad, tourists with a
-- passport — BR-11), identity and driving licence details, customer document scans with human
-- review, and a "do not rent" flag. Customers are company-wide (D-026). Additive only.

INSERT INTO permissions (code, description, grantable) VALUES
  ('customers.read',   'See customers, their details and document scans', false),
  ('customers.manage', 'Add customers, edit their details and attach document scans', false),
  ('customers.verify', 'Review customer document scans (verify or reject)', true),
  ('customers.block',  'Mark a customer "do not rent" and lift it', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager',  'customers.read'),
  ('manager',  'customers.manage'),
  ('manager',  'customers.verify'),
  ('manager',  'customers.block'),
  ('employee', 'customers.read'),
  ('employee', 'customers.manage');

CREATE TABLE customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_type       text NOT NULL DEFAULT 'individual' CHECK (customer_type IN ('individual', 'company')),
  full_name           text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 160),
  company_ice         text CHECK (company_ice ~ '^[0-9]{15}$'),          -- Moroccan ICE, companies only
  contact_person      text CHECK (length(contact_person) <= 160),       -- companies: who rents
  birth_date          date CHECK (birth_date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'),
  nationality         text CHECK (length(nationality) <= 80),
  residence           text NOT NULL DEFAULT 'morocco' CHECK (residence IN ('morocco', 'abroad_mre', 'abroad_foreign')),
  phone               text NOT NULL CHECK (length(phone) BETWEEN 6 AND 40),   -- as typed
  phone_key           text NOT NULL CHECK (phone_key ~ '^[0-9]{6,20}$'),     -- digits with country code
  phone2              text CHECK (length(phone2) <= 40),
  phone2_key          text CHECK (phone2_key ~ '^[0-9]{6,20}$'),
  whatsapp_same_phone boolean NOT NULL DEFAULT true,
  email               text CHECK (length(email) <= 200),
  address             text CHECK (length(address) <= 300),
  city                text CHECK (length(city) <= 100),
  country             text CHECK (length(country) <= 80),               -- country of residence
  preferred_language  text NOT NULL DEFAULT 'fr' CHECK (preferred_language IN ('fr', 'ar', 'en', 'es')),
  id_doc_type         text CHECK (id_doc_type IN ('cin', 'passport', 'residence_permit', 'other')),
  id_doc_number       text CHECK (length(id_doc_number) <= 40),
  id_doc_number_key   text CHECK (id_doc_number_key ~ '^[0-9A-Z]{2,40}$'),
  id_doc_country      text CHECK (length(id_doc_country) <= 80),
  id_doc_expiry       date,
  licence_number      text CHECK (length(licence_number) <= 40),
  licence_category    text CHECK (length(licence_category) <= 20),
  licence_country     text CHECK (length(licence_country) <= 80),
  licence_issue_date  date,
  licence_expiry      date,
  notes               text CHECK (length(notes) <= 2000),
  blocked_at          timestamptz,
  blocked_reason      text CHECK (length(blocked_reason) <= 500),
  blocked_by          uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_by          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_type = 'company' OR company_ice IS NULL),
  CHECK ((id_doc_number IS NULL) = (id_doc_number_key IS NULL)),
  CHECK (id_doc_number IS NULL OR id_doc_type IS NOT NULL),
  CHECK ((blocked_at IS NULL) = (blocked_reason IS NULL)),
  CHECK (licence_expiry IS NULL OR licence_issue_date IS NULL OR licence_expiry >= licence_issue_date)
);
-- Search and duplicate signals (never unique: same phone or number is a warning, not proof — spec §5).
CREATE INDEX customers_phone_key_idx ON customers (phone_key);
CREATE INDEX customers_phone2_key_idx ON customers (phone2_key) WHERE phone2_key IS NOT NULL;
CREATE INDEX customers_id_doc_key_idx ON customers (id_doc_number_key) WHERE id_doc_number_key IS NOT NULL;
CREATE INDEX customers_name_idx ON customers (lower(full_name));
CREATE INDEX customers_updated_idx ON customers (updated_at DESC);

-- Customer document scans (ID card, passport, licence...). OCR is not used: a person reviews.
CREATE TABLE customer_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  doc_kind      text NOT NULL CHECK (doc_kind IN ('id_front', 'id_back', 'passport', 'licence_front', 'licence_back',
                                                 'residence_permit', 'other')),
  file_id       uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  source        text NOT NULL DEFAULT 'direct_upload' CHECK (source IN ('direct_upload', 'whatsapp_batch')),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'verified', 'rejected')),
  review_note   text CHECK (length(review_note) <= 500),
  reviewed_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at   timestamptz,
  archived_at   timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((review_status = 'pending') = (reviewed_at IS NULL)),
  CHECK (review_status <> 'rejected' OR review_note IS NOT NULL)
);
CREATE INDEX customer_documents_customer_idx ON customer_documents (customer_id) WHERE archived_at IS NULL;
CREATE INDEX customer_documents_file_idx ON customer_documents (file_id);
CREATE INDEX customer_documents_pending_idx ON customer_documents (created_at) WHERE review_status = 'pending' AND archived_at IS NULL;
-- The same scan is attached once per customer (network retries never duplicate it).
CREATE UNIQUE INDEX customer_documents_customer_file_key ON customer_documents (customer_id, file_id) WHERE archived_at IS NULL;
