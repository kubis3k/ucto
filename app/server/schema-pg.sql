-- =====================================================================
-- GLOBAAL ELEVATE PRODUCTION s.r.o. — Nezávislý účetní systém (web)
-- PostgreSQL schéma — 1:1 překlad app/server/schema.sql (SQLite/sql.js,
-- desktop verze) pro webové nasazení (Vercel + Postgres přes db-pg.js).
--
-- Překladové zásady:
--   INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
--   REAL                              -> DOUBLE PRECISION
--   INTEGER (boolean 0/1)             -> ponecháno INTEGER (kompatibilita
--                                         s parametry 0/1 posílanými z routes)
--   datetime('now')                   -> now()::text (sloupce zůstávají TEXT)
--   SQLite RAISE(ABORT,...) triggery  -> PL/pgSQL trigger funkce + RAISE EXCEPTION
--   last_insert_rowid()               -> řeší se v db-pg.js překladem na lastval()
--
-- Právní podklad: stejný jako schema.sql (zákon č. 563/1991 Sb., vyhláška
-- č. 500/2002 Sb., zákon č. 235/2004 Sb. o DPH).
-- =====================================================================

CREATE TABLE IF NOT EXISTS accounting_unit (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    ico                 TEXT NOT NULL UNIQUE,
    dic                 TEXT,
    accounting_mode     TEXT NOT NULL DEFAULT 'podvojne_ucetnictvi'
                            CHECK (accounting_mode IN ('podvojne_ucetnictvi','danova_evidence')),
    unit_category       TEXT NOT NULL DEFAULT 'mikro'
                            CHECK (unit_category IN ('mikro','mala','stredni','velka')),
    is_vat_payer        INTEGER NOT NULL DEFAULT 0,
    vat_payer_since     TEXT,
    fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    iban                TEXT,
    bank_account        TEXT,
    address             TEXT,
    email               TEXT,
    phone               TEXT,
    logo_data_url       TEXT,
    stamp_data_url      TEXT,
    signature_data_url  TEXT,
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS iban TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS bank_account TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS logo_data_url TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS stamp_data_url TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS signature_data_url TEXT;

CREATE TABLE IF NOT EXISTS app_user (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    full_name           TEXT NOT NULL,
    email               TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL DEFAULT 'zadavatel'
                            CHECK (role IN ('admin','zadavatel','schvalovatel','ucetni','ctenar')),
    active              INTEGER NOT NULL DEFAULT 1,
    password_hash       TEXT,
    bankid_verified     INTEGER NOT NULL DEFAULT 0,
    bankid_sub          TEXT,
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS company_director (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    full_name           TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS company_invite (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    email               TEXT NOT NULL,
    token               TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL DEFAULT 'zadavatel'
                            CHECK (role IN ('admin','zadavatel','schvalovatel','ucetni','ctenar')),
    invited_by          INTEGER REFERENCES app_user(id),
    created_at          TEXT NOT NULL DEFAULT (now()::text),
    used_at             TEXT
);

CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    account_number      TEXT NOT NULL,
    parent_account_id   INTEGER REFERENCES chart_of_accounts(id),
    name                TEXT NOT NULL,
    account_class       INTEGER NOT NULL CHECK (account_class BETWEEN 0 AND 9),
    account_type        TEXT NOT NULL CHECK (account_type IN
                            ('rozvahovy_aktivni','rozvahovy_pasivni','vysledkovy_naklad',
                             'vysledkovy_vynos','zaverkovy','podrozvahovy')),
    active              INTEGER NOT NULL DEFAULT 1,
    UNIQUE (accounting_unit_id, account_number)
);

CREATE TABLE IF NOT EXISTS accounting_period (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    fiscal_year         INTEGER NOT NULL,
    start_date          TEXT NOT NULL,
    end_date            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'otevrene' CHECK (status IN ('otevrene','uzavrene')),
    closed_at           TEXT,
    closed_by           INTEGER REFERENCES app_user(id),
    UNIQUE (accounting_unit_id, fiscal_year)
);

-- Měsíční uzávěrka — viz schema.sql pro vysvětlení, 1:1 překlad.
CREATE TABLE IF NOT EXISTS period_month_lock (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    fiscal_year         INTEGER NOT NULL,
    month               INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    locked_at           TEXT NOT NULL DEFAULT (now()::text),
    locked_by           INTEGER NOT NULL REFERENCES app_user(id),
    unlocked_at         TEXT,
    unlocked_by         INTEGER REFERENCES app_user(id),
    UNIQUE (accounting_unit_id, fiscal_year, month)
);

CREATE TABLE IF NOT EXISTS contact (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    contact_type        TEXT NOT NULL CHECK (contact_type IN ('odberatel','dodavatel','umelec','zamestnanec','jiny')),
    ico                 TEXT,
    dic                 TEXT,
    is_vat_payer        INTEGER NOT NULL DEFAULT 0,
    address             TEXT,
    bank_account        TEXT,
    iban                TEXT,
    email               TEXT,
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);
ALTER TABLE contact ADD COLUMN IF NOT EXISTS email TEXT;

CREATE TABLE IF NOT EXISTS project (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    code                TEXT NOT NULL,
    name                TEXT NOT NULL,
    budget              DOUBLE PRECISION,
    start_date          TEXT,
    end_date            TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    UNIQUE (accounting_unit_id, code)
);

CREATE TABLE IF NOT EXISTS document (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    doc_type            TEXT NOT NULL CHECK (doc_type IN
                            ('faktura_vydana','faktura_prijata','pokladni_prijem',
                             'pokladni_vydej','bankovni_pohyb','interni_doklad')),
    doc_number          TEXT NOT NULL,
    variable_symbol     TEXT,
    contact_id          INTEGER REFERENCES contact(id),
    project_id          INTEGER REFERENCES project(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),

    issue_date          TEXT NOT NULL,
    taxable_supply_date TEXT,
    due_date            TEXT,

    description         TEXT NOT NULL,
    total_amount        DOUBLE PRECISION NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'CZK',
    -- Kurz vystavení "zamrznutý" k datu vzniku dokladu — viz schema.sql pro vysvětlení, 1:1 překlad.
    fx_rate             DOUBLE PRECISION,
    fx_rate_unit        INTEGER DEFAULT 1,

    is_vat_document     INTEGER NOT NULL DEFAULT 0,
    vat_base_amount     DOUBLE PRECISION,
    vat_rate            DOUBLE PRECISION,
    vat_amount          DOUBLE PRECISION,
    counterparty_dic    TEXT,

    status              TEXT NOT NULL DEFAULT 'koncept' CHECK (status IN ('koncept','schvaleny','zauctovany','stornovany')),
    responsible_user_id INTEGER NOT NULL REFERENCES app_user(id),
    approved_by         INTEGER REFERENCES app_user(id),
    approved_at         TEXT,

    cash_payee_name     TEXT,
    cash_payee_address  TEXT,
    cash_payee_id_number TEXT,
    cash_receipt_signed INTEGER NOT NULL DEFAULT 0,

    attachment_path     TEXT,

    created_at          TEXT NOT NULL DEFAULT (now()::text),
    updated_at          TEXT NOT NULL DEFAULT (now()::text),

    UNIQUE (accounting_unit_id, doc_type, doc_number)
);
ALTER TABLE document ADD COLUMN IF NOT EXISTS fx_rate DOUBLE PRECISION;
ALTER TABLE document ADD COLUMN IF NOT EXISTS fx_rate_unit INTEGER DEFAULT 1;

-- Údaje pro elektronické podání DPH (DPHDP3/KH1) — kód finančního úřadu
-- a strukturovaná adresa dle XSD (samostatně od volné adresy na faktuře).
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS ufo_code TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS fs_street TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS fs_house_number TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS fs_orientation_number TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS fs_city TEXT;
ALTER TABLE accounting_unit ADD COLUMN IF NOT EXISTS fs_zip TEXT;

CREATE TABLE IF NOT EXISTS document_line (
    id                  SERIAL PRIMARY KEY,
    document_id         INTEGER NOT NULL REFERENCES document(id),
    line_no             INTEGER NOT NULL,
    description         TEXT NOT NULL,
    quantity            DOUBLE PRECISION NOT NULL DEFAULT 1,
    unit_price          DOUBLE PRECISION NOT NULL,
    vat_rate            DOUBLE PRECISION,
    line_amount         DOUBLE PRECISION NOT NULL,
    suggested_account_id INTEGER REFERENCES chart_of_accounts(id),
    UNIQUE (document_id, line_no)
);

-- Pozn.: file_path zůstává stejné jako v desktop schématu, aby routes/documents.js
-- šlo beze změny nad oběma backendy. Na Vercelu (efemérní filesystem) to ale
-- znamená, že nahrané přílohy nepřežijí cold start/jiný serverless instance —
-- pro produkční web nasazení je to námět na navazující práci (např. Vercel Blob).
-- storage_backend / storage_url — viz schema.sql pro vysvětlení, 1:1 překlad.
-- Na Vercelu je disk funkce dočasný, takže produkčně se používá backend 'blob'.
CREATE TABLE IF NOT EXISTS document_attachment (
    id                  SERIAL PRIMARY KEY,
    document_id         INTEGER NOT NULL REFERENCES document(id),
    file_name           TEXT NOT NULL,
    mime_type           TEXT NOT NULL,
    file_path           TEXT NOT NULL,
    size_bytes          INTEGER NOT NULL,
    storage_backend     TEXT NOT NULL DEFAULT 'fs' CHECK (storage_backend IN ('fs','blob')),
    storage_url         TEXT,
    uploaded_at         TEXT NOT NULL DEFAULT (now()::text)
);
ALTER TABLE document_attachment ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'fs';
ALTER TABLE document_attachment ADD COLUMN IF NOT EXISTS storage_url TEXT;

CREATE TABLE IF NOT EXISTS posting (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),
    posting_number      INTEGER NOT NULL,
    document_id         INTEGER REFERENCES document(id),
    posting_date        TEXT NOT NULL,
    description         TEXT NOT NULL,
    storno_of_posting_id INTEGER REFERENCES posting(id),
    created_by          INTEGER NOT NULL REFERENCES app_user(id),
    created_at          TEXT NOT NULL DEFAULT (now()::text),
    UNIQUE (accounting_unit_id, posting_number)
);

CREATE TABLE IF NOT EXISTS posting_line (
    id                  SERIAL PRIMARY KEY,
    posting_id          INTEGER NOT NULL REFERENCES posting(id),
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    side                TEXT NOT NULL CHECK (side IN ('MD','D')),
    amount              DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    project_id          INTEGER REFERENCES project(id)
);

CREATE TABLE IF NOT EXISTS vat_ledger_entry (
    id                      SERIAL PRIMARY KEY,
    document_id             INTEGER NOT NULL REFERENCES document(id),
    direction               TEXT NOT NULL CHECK (direction IN ('uskutecnene','prijate')),
    vat_base                DOUBLE PRECISION NOT NULL,
    vat_rate                DOUBLE PRECISION NOT NULL,
    vat_amount              DOUBLE PRECISION NOT NULL,
    counterparty_dic        TEXT,
    duzp                    TEXT NOT NULL,
    requires_individual_kh  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fixed_asset (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    acquisition_cost    DOUBLE PRECISION NOT NULL,
    acquisition_date    TEXT NOT NULL,
    useful_life_months  INTEGER NOT NULL,
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    depreciation_account_id INTEGER REFERENCES chart_of_accounts(id),
    residual_value      DOUBLE PRECISION NOT NULL DEFAULT 0,
    active              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS depreciation_entry (
    id                  SERIAL PRIMARY KEY,
    fixed_asset_id      INTEGER NOT NULL REFERENCES fixed_asset(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),
    entry_date          TEXT NOT NULL,
    amount              DOUBLE PRECISION NOT NULL,
    posting_id          INTEGER REFERENCES posting(id)
);

CREATE TABLE IF NOT EXISTS bank_statement_line (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    bank_account        TEXT NOT NULL,
    statement_date      TEXT NOT NULL,
    amount              DOUBLE PRECISION NOT NULL,
    counterparty_name   TEXT,
    variable_symbol     TEXT,
    matched_document_id INTEGER REFERENCES document(id),
    posting_id          INTEGER REFERENCES posting(id),
    external_ref        TEXT,
    imported_at         TEXT NOT NULL DEFAULT (now()::text)
);
ALTER TABLE bank_statement_line ADD COLUMN IF NOT EXISTS posting_id INTEGER REFERENCES posting(id);
ALTER TABLE bank_statement_line ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_statement_line_external_ref
    ON bank_statement_line(accounting_unit_id, external_ref) WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------
-- Párovací e-mailová adresa banky (Fakturoid-styl) — viz schema.sql pro
-- vysvětlení, 1:1 překlad.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_inbound_mailbox (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    token               TEXT NOT NULL UNIQUE,
    bank_account        TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);

-- ---------------------------------------------------------------------
-- Platby vydaných faktur přes Stripe Checkout — viz schema.sql pro
-- vysvětlení, 1:1 překlad.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_payment (
    id                      SERIAL PRIMARY KEY,
    accounting_unit_id      INTEGER NOT NULL REFERENCES accounting_unit(id),
    document_id             INTEGER NOT NULL UNIQUE REFERENCES document(id),
    pay_token               TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
    stripe_session_id       TEXT,
    stripe_payment_intent_id TEXT,
    amount                  DOUBLE PRECISION,
    currency                TEXT NOT NULL DEFAULT 'CZK',
    paid_at                 TEXT,
    created_at              TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS bank_category_rule (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    match_text          TEXT NOT NULL,
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    hits                INTEGER NOT NULL DEFAULT 1,
    updated_at          TEXT NOT NULL DEFAULT (now()::text),
    UNIQUE (accounting_unit_id, match_text)
);

CREATE TABLE IF NOT EXISTS inventory_check (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),
    as_of_date          TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (now()::text),
    created_by          INTEGER NOT NULL REFERENCES app_user(id),
    note                TEXT
);

CREATE TABLE IF NOT EXISTS inventory_check_line (
    id                  SERIAL PRIMARY KEY,
    inventory_check_id  INTEGER NOT NULL REFERENCES inventory_check(id),
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    book_balance        DOUBLE PRECISION NOT NULL,
    physical_balance    DOUBLE PRECISION,
    difference          DOUBLE PRECISION,
    note                TEXT
);

CREATE TABLE IF NOT EXISTS document_number_sequence (
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    doc_type            TEXT NOT NULL,
    fiscal_year         INTEGER NOT NULL,
    last_number         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (accounting_unit_id, doc_type, fiscal_year)
);

CREATE TABLE IF NOT EXISTS posting_number_sequence (
    accounting_unit_id  INTEGER PRIMARY KEY REFERENCES accounting_unit(id),
    last_number         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
    id                  SERIAL PRIMARY KEY,
    occurred_at         TEXT NOT NULL DEFAULT (now()::text),
    accounting_unit_id  INTEGER REFERENCES accounting_unit(id),
    user_id             INTEGER REFERENCES app_user(id),
    action              TEXT NOT NULL,
    entity_table        TEXT NOT NULL,
    entity_id           INTEGER,
    before_data         TEXT,
    after_data          TEXT
);

CREATE TABLE IF NOT EXISTS posting_template (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    doc_type            TEXT,
    description         TEXT,
    active              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS posting_template_line (
    id                  SERIAL PRIMARY KEY,
    template_id         INTEGER NOT NULL REFERENCES posting_template(id),
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    side                TEXT NOT NULL CHECK (side IN ('MD','D')),
    amount_source       TEXT NOT NULL DEFAULT 'celkem' CHECK (amount_source IN ('celkem','zaklad','dph'))
);

-- ---------------------------------------------------------------------
-- FÁZE 2 fakturace — Ceník, Nabídky, Pravidelné faktury (šablony).
-- `offer`/`offer_line` jsou SCHVÁLENĚ separátní od `document` (ne nový
-- doc_type) — nejsou to účetní záznamy (§ 33a ZoÚ), NESMÍ tečou do
-- výkazů/DPH a nesvazují se triggery period-lock/no-delete/edit-guard
-- (viz .claude/agent-memory/architect/accounting-doc-invariants.md).
-- Číselná řada nabídek (NAB) ale sdílí document_number_sequence.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_list_item (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    description         TEXT,
    unit_price          DOUBLE PRECISION NOT NULL,
    unit                TEXT,
    vat_rate            DOUBLE PRECISION,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS offer (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    offer_number        TEXT NOT NULL,
    contact_id          INTEGER REFERENCES contact(id),
    project_id          INTEGER REFERENCES project(id),
    issue_date          TEXT NOT NULL,
    valid_until         TEXT,
    description         TEXT,
    total_amount        DOUBLE PRECISION NOT NULL DEFAULT 0,
    currency            TEXT NOT NULL DEFAULT 'CZK',
    is_vat_document     INTEGER NOT NULL DEFAULT 0,
    vat_base_amount     DOUBLE PRECISION,
    vat_rate            DOUBLE PRECISION,
    vat_amount          DOUBLE PRECISION,
    status              TEXT NOT NULL DEFAULT 'koncept'
                            CHECK (status IN ('koncept','odeslana','prijata','odmitnuta','prevedena')),
    converted_document_id INTEGER REFERENCES document(id),
    responsible_user_id INTEGER NOT NULL REFERENCES app_user(id),
    created_at          TEXT NOT NULL DEFAULT (now()::text),
    updated_at          TEXT NOT NULL DEFAULT (now()::text),
    UNIQUE (accounting_unit_id, offer_number)
);

CREATE TABLE IF NOT EXISTS offer_line (
    id                  SERIAL PRIMARY KEY,
    offer_id            INTEGER NOT NULL REFERENCES offer(id),
    line_no             INTEGER NOT NULL,
    description         TEXT NOT NULL,
    quantity            DOUBLE PRECISION NOT NULL DEFAULT 1,
    unit_price          DOUBLE PRECISION NOT NULL,
    vat_rate            DOUBLE PRECISION,
    line_amount         DOUBLE PRECISION NOT NULL,
    UNIQUE (offer_id, line_no)
);

CREATE TABLE IF NOT EXISTS recurring_invoice (
    id                  SERIAL PRIMARY KEY,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    contact_id          INTEGER REFERENCES contact(id),
    project_id          INTEGER REFERENCES project(id),
    interval            TEXT NOT NULL CHECK (interval IN ('mesicne','ctvrtletne','rocne')),
    next_run_date       TEXT NOT NULL,
    start_date          TEXT,
    end_date            TEXT,
    max_occurrences     INTEGER,
    occurrences_done    INTEGER NOT NULL DEFAULT 0,
    description         TEXT,
    is_vat_document     INTEGER NOT NULL DEFAULT 0,
    vat_rate            DOUBLE PRECISION,
    currency            TEXT NOT NULL DEFAULT 'CZK',
    active              INTEGER NOT NULL DEFAULT 1,
    last_generated_at   TEXT,
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS recurring_invoice_line (
    id                      SERIAL PRIMARY KEY,
    recurring_invoice_id    INTEGER NOT NULL REFERENCES recurring_invoice(id),
    line_no                 INTEGER NOT NULL,
    description             TEXT NOT NULL,
    quantity                DOUBLE PRECISION NOT NULL DEFAULT 1,
    unit_price              DOUBLE PRECISION NOT NULL,
    vat_rate                DOUBLE PRECISION,
    UNIQUE (recurring_invoice_id, line_no)
);

-- ---------------------------------------------------------------------
-- Příloha k účetní závěrce (§ 18 ZoÚ, § 39 vyhl. 500/2002 Sb.) — viz
-- schema.sql pro vysvětlení, 1:1 překlad.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_statement_note (
    id                              SERIAL PRIMARY KEY,
    accounting_unit_id              INTEGER NOT NULL REFERENCES accounting_unit(id),
    period_id                       INTEGER NOT NULL REFERENCES accounting_period(id),
    pouzite_ucetni_metody           TEXT,
    informace_majetek_komentar      TEXT,
    pohledavky_zavazky_komentar     TEXT,
    udalosti_po_rozvahovem_dni      TEXT,
    prumerny_pocet_zamestnancu      INTEGER,
    doplnujici_informace            TEXT,
    version                         INTEGER NOT NULL DEFAULT 1,
    updated_at                      TEXT NOT NULL DEFAULT (now()::text),
    updated_by                      INTEGER REFERENCES app_user(id),
    UNIQUE (accounting_unit_id, period_id)
);

CREATE TABLE IF NOT EXISTS financial_statement_note_version (
    id                  SERIAL PRIMARY KEY,
    note_id             INTEGER NOT NULL REFERENCES financial_statement_note(id),
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),
    version             INTEGER NOT NULL,
    snapshot_json        TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (now()::text),
    created_by          INTEGER REFERENCES app_user(id)
);

-- ---------------------------------------------------------------------
-- Kurzy ČNB — cache. GLOBÁLNÍ, bez accounting_unit_id — viz schema.sql pro
-- vysvětlení (veřejná referenční data, vědomá výjimka z per-unit scope invariantu).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exchange_rate (
    id                  SERIAL PRIMARY KEY,
    rate_date           TEXT NOT NULL,
    currency            TEXT NOT NULL,
    rate                DOUBLE PRECISION NOT NULL,
    unit                INTEGER NOT NULL DEFAULT 1,
    source              TEXT NOT NULL DEFAULT 'CNB',
    created_at          TEXT NOT NULL DEFAULT (now()::text),
    UNIQUE (rate_date, currency)
);

-- ---------------------------------------------------------------------
-- Indexy
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_posting_line_account ON posting_line(account_id);
CREATE INDEX IF NOT EXISTS idx_posting_period ON posting(period_id);
CREATE INDEX IF NOT EXISTS idx_document_unit_date ON document(accounting_unit_id, issue_date);
CREATE INDEX IF NOT EXISTS idx_document_status ON document(status);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_table, entity_id);
CREATE INDEX IF NOT EXISTS idx_vat_ledger_duzp ON vat_ledger_entry(duzp);

-- =====================================================================
-- TRIGGERY — vynucení append-only (§ 33a, § 35 ZoÚ)
-- SQLite "SELECT RAISE(ABORT, 'msg')" se v Postgresu dělá přes PL/pgSQL
-- trigger funkci s RAISE EXCEPTION; WHEN klauzule zůstává stejná.
-- =====================================================================

CREATE OR REPLACE FUNCTION trg_fn_posting_no_update() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Účetní zápisy jsou append-only (§ 33a zákona o účetnictví). Použijte storno.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_posting_no_update ON posting;
CREATE TRIGGER trg_posting_no_update BEFORE UPDATE ON posting
    FOR EACH ROW EXECUTE FUNCTION trg_fn_posting_no_update();

CREATE OR REPLACE FUNCTION trg_fn_posting_no_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Účetní zápisy jsou append-only (§ 33a zákona o účetnictví). Použijte storno.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_posting_no_delete ON posting;
CREATE TRIGGER trg_posting_no_delete BEFORE DELETE ON posting
    FOR EACH ROW EXECUTE FUNCTION trg_fn_posting_no_delete();

-- Starší produkční verze vytvářela INSERT trigger, který uzamkl posting
-- už po první řádce a znemožnil vložit vyvažující stranu zápisu. Trigger
-- není součástí současného schématu, takže jej odstraňujeme cíleně podle
-- textu jeho funkce; append-only UPDATE/DELETE ochrany níže zůstávají.
DO $$
DECLARE legacy_trigger RECORD;
BEGIN
  FOR legacy_trigger IN
    SELECT t.tgname
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid=t.tgfoid
     WHERE t.tgrelid='posting_line'::regclass
       AND NOT t.tgisinternal
       AND (p.prosrc ILIKE '%Dokončený účetní zápis%'
            OR p.prosrc ILIKE '%další řádek nelze přidat%')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON posting_line', legacy_trigger.tgname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION trg_fn_posting_line_no_update() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Řádky účetních zápisů jsou append-only (§ 33a zákona o účetnictví).';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_posting_line_no_update ON posting_line;
CREATE TRIGGER trg_posting_line_no_update BEFORE UPDATE ON posting_line
    FOR EACH ROW EXECUTE FUNCTION trg_fn_posting_line_no_update();

CREATE OR REPLACE FUNCTION trg_fn_posting_line_no_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Řádky účetních zápisů jsou append-only (§ 33a zákona o účetnictví).';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_posting_line_no_delete ON posting_line;
CREATE TRIGGER trg_posting_line_no_delete BEFORE DELETE ON posting_line
    FOR EACH ROW EXECUTE FUNCTION trg_fn_posting_line_no_delete();

CREATE OR REPLACE FUNCTION trg_fn_audit_log_no_update() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit log je append-only a nelze jej upravit.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_fn_audit_log_no_update();

CREATE OR REPLACE FUNCTION trg_fn_audit_log_no_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit log je append-only a nelze jej smazat.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_fn_audit_log_no_delete();

-- Doklad lze upravit jen v konceptu; po schválení/zaúčtování/stornu nelze editovat ani mazat
CREATE OR REPLACE FUNCTION trg_fn_document_edit_guard() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('schvaleny','zauctovany','stornovany') AND NEW.status = OLD.status THEN
        RAISE EXCEPTION 'Doklad je již schválený, zaúčtovaný nebo stornovaný — nelze upravit. Vytvořte opravný doklad.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_document_edit_guard ON document;
CREATE TRIGGER trg_document_edit_guard BEFORE UPDATE ON document
    FOR EACH ROW EXECUTE FUNCTION trg_fn_document_edit_guard();

CREATE OR REPLACE FUNCTION trg_fn_document_no_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Doklady nelze mazat (§ 11, § 33a ZoÚ) — pouze stornovat.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_document_no_delete ON document;
CREATE TRIGGER trg_document_no_delete BEFORE DELETE ON document
    FOR EACH ROW EXECUTE FUNCTION trg_fn_document_no_delete();

-- Uzamčení účetního období — zápisy do uzavřeného období jsou zakázány
CREATE OR REPLACE FUNCTION trg_fn_document_period_lock() RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT status FROM accounting_period WHERE id = NEW.period_id) = 'uzavrene' THEN
        RAISE EXCEPTION 'Účetní období je uzavřené po inventarizaci — zápis není možný.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_document_period_lock ON document;
CREATE TRIGGER trg_document_period_lock BEFORE INSERT ON document
    FOR EACH ROW EXECUTE FUNCTION trg_fn_document_period_lock();

CREATE OR REPLACE FUNCTION trg_fn_posting_period_lock() RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT status FROM accounting_period WHERE id = NEW.period_id) = 'uzavrene' THEN
        RAISE EXCEPTION 'Účetní období je uzavřené po inventarizaci — zápis není možný.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_posting_period_lock ON posting;
CREATE TRIGGER trg_posting_period_lock BEFORE INSERT ON posting
    FOR EACH ROW EXECUTE FUNCTION trg_fn_posting_period_lock();

-- Měsíční uzávěrka — viz schema.sql pro vysvětlení, 1:1 překlad.
CREATE OR REPLACE FUNCTION trg_fn_document_month_lock() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM period_month_lock
        WHERE accounting_unit_id = NEW.accounting_unit_id
          AND fiscal_year = substring(NEW.issue_date from 1 for 4)::int
          AND month = substring(NEW.issue_date from 6 for 2)::int
          AND unlocked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Měsíc je uzamčen měsíční uzávěrkou — zápis s tímto datem není možný.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_document_month_lock ON document;
CREATE TRIGGER trg_document_month_lock BEFORE INSERT ON document
    FOR EACH ROW EXECUTE FUNCTION trg_fn_document_month_lock();

CREATE OR REPLACE FUNCTION trg_fn_posting_month_lock() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM period_month_lock
        WHERE accounting_unit_id = NEW.accounting_unit_id
          AND fiscal_year = substring(NEW.posting_date from 1 for 4)::int
          AND month = substring(NEW.posting_date from 6 for 2)::int
          AND unlocked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Měsíc je uzamčen měsíční uzávěrkou — zápis s tímto datem není možný.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_posting_month_lock ON posting;
CREATE TRIGGER trg_posting_month_lock BEFORE INSERT ON posting
    FOR EACH ROW EXECUTE FUNCTION trg_fn_posting_month_lock();

CREATE OR REPLACE FUNCTION trg_fn_cash_nonnegative() RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT account_number FROM chart_of_accounts WHERE id = NEW.account_id) LIKE '211%'
       AND (SELECT COALESCE(SUM(CASE WHEN side='MD' THEN amount ELSE -amount END),0)
            FROM posting_line WHERE account_id = NEW.account_id) < -0.005 THEN
        RAISE EXCEPTION 'Pokladna (211) nemůže mít záporný zůstatek. Nejprve zaúčtujte příjem hotovosti.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cash_nonnegative ON posting_line;
CREATE TRIGGER trg_cash_nonnegative AFTER INSERT ON posting_line
    FOR EACH ROW EXECUTE FUNCTION trg_fn_cash_nonnegative();
