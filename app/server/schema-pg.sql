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
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);

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
    created_at          TEXT NOT NULL DEFAULT (now()::text)
);

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
CREATE TABLE IF NOT EXISTS document_attachment (
    id                  SERIAL PRIMARY KEY,
    document_id         INTEGER NOT NULL REFERENCES document(id),
    file_name           TEXT NOT NULL,
    mime_type           TEXT NOT NULL,
    file_path           TEXT NOT NULL,
    size_bytes          INTEGER NOT NULL,
    uploaded_at         TEXT NOT NULL DEFAULT (now()::text)
);

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
    imported_at         TEXT NOT NULL DEFAULT (now()::text)
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
    IF OLD.status IN ('zauctovany','stornovany') AND NEW.status = OLD.status THEN
        RAISE EXCEPTION 'Doklad je již zaúčtovaný nebo stornovaný — nelze upravit. Vytvořte opravný doklad.';
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
