-- =====================================================================
-- GLOBAAL ELEVATE PRODUCTION s.r.o. — Nezávislý účetní systém
-- 001_schema.sql — Základní databázové schéma (PostgreSQL 15+)
--
-- Navrženo podle právního researche (zákon č. 563/1991 Sb. o účetnictví,
-- vyhláška č. 500/2002 Sb., zákon č. 235/2004 Sb. o DPH, § 7b ZDP).
--
-- Klíčový princip: APPEND-ONLY účetní zápisy (posting/posting_line)
-- a audit_log — vynuceno triggery v souboru 002_functions_triggers.sql.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS ucetnictvi;
SET search_path TO ucetnictvi;

-- ---------------------------------------------------------------------
-- ENUM typy
-- ---------------------------------------------------------------------
CREATE TYPE accounting_mode AS ENUM ('podvojne_ucetnictvi', 'danova_evidence');
CREATE TYPE unit_category   AS ENUM ('mikro', 'mala', 'stredni', 'velka');
CREATE TYPE user_role       AS ENUM ('admin', 'zadavatel', 'schvalovatel', 'ucetni', 'ctenar');
CREATE TYPE period_status   AS ENUM ('otevrene', 'uzavrene');
CREATE TYPE contact_type    AS ENUM ('odberatel', 'dodavatel', 'umelec', 'zamestnanec', 'jiny');
CREATE TYPE document_type   AS ENUM (
    'faktura_vydana', 'faktura_prijata', 'pokladni_prijem',
    'pokladni_vydej', 'bankovni_pohyb', 'interni_doklad'
);
CREATE TYPE document_status AS ENUM ('koncept', 'schvaleny', 'zauctovany', 'stornovany');
CREATE TYPE account_type    AS ENUM (
    'rozvahovy_aktivni', 'rozvahovy_pasivni',
    'vysledkovy_naklad', 'vysledkovy_vynos',
    'zaverkovy', 'podrozvahovy'
);
CREATE TYPE posting_side    AS ENUM ('MD', 'D');   -- MD = Má dáti (debet), D = Dal (kredit)
CREATE TYPE vat_direction   AS ENUM ('uskutecnene', 'prijate');

-- ---------------------------------------------------------------------
-- Účetní jednotka (firma / OSVČ) — systém je multi-tenant připravený
-- ---------------------------------------------------------------------
CREATE TABLE accounting_unit (
    id                  BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    ico                 VARCHAR(8) NOT NULL UNIQUE,
    dic                 VARCHAR(12),
    accounting_mode     accounting_mode NOT NULL DEFAULT 'podvojne_ucetnictvi',
    unit_category       unit_category NOT NULL DEFAULT 'mikro',
    is_vat_payer        BOOLEAN NOT NULL DEFAULT FALSE,
    vat_payer_since     DATE,
    fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Uživatelé a role (příprava na budoucí tým — zadavatel vs. schvalovatel)
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    full_name           TEXT NOT NULL,
    email               TEXT NOT NULL UNIQUE,
    role                user_role NOT NULL DEFAULT 'zadavatel',
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Účtový rozvrh (dle směrné účtové osnovy — příloha č. 4 vyhl. 500/2002 Sb.)
-- ---------------------------------------------------------------------
CREATE TABLE chart_of_accounts (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    account_number      VARCHAR(10) NOT NULL,       -- např. '518', '518100' (analytika)
    parent_account_id   BIGINT REFERENCES chart_of_accounts(id),
    name                TEXT NOT NULL,
    account_class       SMALLINT NOT NULL CHECK (account_class BETWEEN 0 AND 9),
    account_type        account_type NOT NULL,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (accounting_unit_id, account_number)
);

-- ---------------------------------------------------------------------
-- Účetní období — uzamykání po roční uzávěrce (§ 29-30 ZoÚ)
-- ---------------------------------------------------------------------
CREATE TABLE accounting_period (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    fiscal_year         INTEGER NOT NULL,
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,
    status              period_status NOT NULL DEFAULT 'otevrene',
    closed_at           TIMESTAMPTZ,
    closed_by           BIGINT REFERENCES app_user(id),
    UNIQUE (accounting_unit_id, fiscal_year)
);

-- ---------------------------------------------------------------------
-- Kontakty (odběratelé, dodavatelé, umělci...) — sdíleno napříč doklady
-- ---------------------------------------------------------------------
CREATE TABLE contact (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    contact_type        contact_type NOT NULL,
    ico                 VARCHAR(8),
    dic                 VARCHAR(12),
    is_vat_payer        BOOLEAN NOT NULL DEFAULT FALSE,
    address             TEXT,
    bank_account        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Projekty / zakázky — analytické sledování nákladů a výnosů po akcích
-- (Nik Tendo, 3Lwave, 58G Chomutov, 3L Fest...)
-- ---------------------------------------------------------------------
CREATE TABLE project (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    code                VARCHAR(30) NOT NULL,
    name                TEXT NOT NULL,
    budget              NUMERIC(14,2),
    start_date          DATE,
    end_date            DATE,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (accounting_unit_id, code)
);

-- ---------------------------------------------------------------------
-- Doklady — centrální vstupní bod (§ 11 ZoÚ náležitosti)
-- ---------------------------------------------------------------------
CREATE TABLE document (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    doc_type            document_type NOT NULL,
    doc_number          VARCHAR(30) NOT NULL,        -- generováno funkcí generate_document_number()
    variable_symbol     VARCHAR(20),
    contact_id          BIGINT REFERENCES contact(id),
    project_id          BIGINT REFERENCES project(id),
    period_id           BIGINT NOT NULL REFERENCES accounting_period(id),

    issue_date          DATE NOT NULL,                -- den vyhotovení
    taxable_supply_date DATE,                          -- DUZP (§ 29 ZDPH)
    due_date            DATE,

    description         TEXT NOT NULL,
    total_amount         NUMERIC(14,2) NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'CZK',

    -- DPH pole — existují od začátku, i když firma zatím není plátce (viz kap. 2.5 brief)
    is_vat_document     BOOLEAN NOT NULL DEFAULT FALSE,
    vat_base_amount     NUMERIC(14,2),
    vat_rate            NUMERIC(5,2),
    vat_amount          NUMERIC(14,2),

    status              document_status NOT NULL DEFAULT 'koncept',
    responsible_user_id BIGINT NOT NULL REFERENCES app_user(id),   -- odpovědný za účetní případ
    approved_by         BIGINT REFERENCES app_user(id),             -- odpovědný za zaúčtování
    approved_at         TIMESTAMPTZ,

    attachment_url      TEXT,                          -- sken/PDF originálu

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (accounting_unit_id, doc_type, doc_number)
);

-- ---------------------------------------------------------------------
-- Položky dokladu (řádky faktury apod.)
-- ---------------------------------------------------------------------
CREATE TABLE document_line (
    id                  BIGSERIAL PRIMARY KEY,
    document_id         BIGINT NOT NULL REFERENCES document(id),
    line_no             INTEGER NOT NULL,
    description         TEXT NOT NULL,
    quantity            NUMERIC(12,3) NOT NULL DEFAULT 1,
    unit_price          NUMERIC(14,2) NOT NULL,
    vat_rate            NUMERIC(5,2),
    line_amount         NUMERIC(14,2) NOT NULL,
    suggested_account_id BIGINT REFERENCES chart_of_accounts(id),
    UNIQUE (document_id, line_no)
);

-- ---------------------------------------------------------------------
-- ÚČETNÍ ZÁPISY — jádro průkaznosti (append-only, viz 002_functions_triggers.sql)
-- Hlavička (posting) + řádky (posting_line), aby šlo dělit náklad na víc účtů/projektů
-- ---------------------------------------------------------------------
CREATE TABLE posting (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    period_id           BIGINT NOT NULL REFERENCES accounting_period(id),
    posting_number      BIGINT NOT NULL,               -- nepřerušená řada, viz trigger
    document_id         BIGINT REFERENCES document(id),
    posting_date        DATE NOT NULL,
    description         TEXT NOT NULL,
    storno_of_posting_id BIGINT REFERENCES posting(id), -- self-reference pro opravné zápisy
    created_by          BIGINT NOT NULL REFERENCES app_user(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (accounting_unit_id, posting_number)
);

CREATE TABLE posting_line (
    id                  BIGSERIAL PRIMARY KEY,
    posting_id          BIGINT NOT NULL REFERENCES posting(id),
    account_id          BIGINT NOT NULL REFERENCES chart_of_accounts(id),
    side                posting_side NOT NULL,          -- MD / D
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    project_id          BIGINT REFERENCES project(id)    -- volitelné analytické přiřazení
);

-- ---------------------------------------------------------------------
-- Evidence pro účely DPH (§ 100 ZDPH) — aktivní až po registraci k DPH
-- ---------------------------------------------------------------------
CREATE TABLE vat_ledger_entry (
    id                      BIGSERIAL PRIMARY KEY,
    document_id             BIGINT NOT NULL REFERENCES document(id),
    direction               vat_direction NOT NULL,
    vat_base                NUMERIC(14,2) NOT NULL,
    vat_rate                NUMERIC(5,2) NOT NULL,
    vat_amount              NUMERIC(14,2) NOT NULL,
    counterparty_dic        VARCHAR(12),
    duzp                    DATE NOT NULL,
    requires_individual_kh  BOOLEAN NOT NULL DEFAULT FALSE   -- doklady nad 10 000 Kč vč. daně
);

-- ---------------------------------------------------------------------
-- Dlouhodobý majetek a odpisy
-- ---------------------------------------------------------------------
CREATE TABLE fixed_asset (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    acquisition_cost    NUMERIC(14,2) NOT NULL,
    acquisition_date    DATE NOT NULL,
    useful_life_months  INTEGER NOT NULL,
    account_id          BIGINT NOT NULL REFERENCES chart_of_accounts(id),
    residual_value      NUMERIC(14,2) NOT NULL DEFAULT 0,
    active              BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE depreciation_entry (
    id                  BIGSERIAL PRIMARY KEY,
    fixed_asset_id      BIGINT NOT NULL REFERENCES fixed_asset(id),
    period_id           BIGINT NOT NULL REFERENCES accounting_period(id),
    amount              NUMERIC(14,2) NOT NULL,
    posting_id          BIGINT REFERENCES posting(id)
);

-- ---------------------------------------------------------------------
-- Bankovní výpisy — import a párování s doklady
-- ---------------------------------------------------------------------
CREATE TABLE bank_statement_line (
    id                  BIGSERIAL PRIMARY KEY,
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    bank_account        TEXT NOT NULL,
    statement_date      DATE NOT NULL,
    amount              NUMERIC(14,2) NOT NULL,          -- kladné = příjem, záporné = výdej
    counterparty_name   TEXT,
    variable_symbol     VARCHAR(20),
    matched_document_id BIGINT REFERENCES document(id),
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- AUDIT LOG — append-only, nezměnitelný (§ 33 odst. 8-9, § 33a ZoÚ)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    id                  BIGSERIAL PRIMARY KEY,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    accounting_unit_id  BIGINT REFERENCES accounting_unit(id),
    user_id             BIGINT REFERENCES app_user(id),
    action              TEXT NOT NULL,          -- 'INSERT', 'UPDATE', 'STORNO', 'PERIOD_CLOSE', 'LOGIN', ...
    entity_table        TEXT NOT NULL,
    entity_id           BIGINT,
    before_data         JSONB,
    after_data          JSONB
);

-- ---------------------------------------------------------------------
-- Indexy pro výkonnost běžných dotazů (hlavní kniha, DPH obrat, apod.)
-- ---------------------------------------------------------------------
CREATE INDEX idx_posting_line_account ON posting_line(account_id);
CREATE INDEX idx_posting_period ON posting(period_id);
CREATE INDEX idx_document_unit_date ON document(accounting_unit_id, issue_date);
CREATE INDEX idx_document_status ON document(status);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_table, entity_id);
CREATE INDEX idx_vat_ledger_duzp ON vat_ledger_entry(duzp);
