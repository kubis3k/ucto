-- =====================================================================
-- GLOBAAL ELEVATE PRODUCTION s.r.o. — Nezávislý účetní systém (desktop)
-- SQLite schéma pro sql.js (Electron aplikace)
--
-- Portace z PostgreSQL schématu (viz ../../db/001_schema.sql a násl.),
-- přizpůsobená SQLite: ENUM -> TEXT + CHECK, PL/pgSQL funkce -> JS vrstva
-- (server/lib/*.js), append-only vynuceno triggery RAISE(ABORT, ...).
--
-- Právní podklad: zákon č. 563/1991 Sb. o účetnictví (novela 316/2025 Sb.,
-- účinná od 1.1.2026), vyhláška č. 500/2002 Sb., zákon č. 235/2004 Sb.
-- o DPH, § 7b zákona č. 586/1992 Sb. o daních z příjmů.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Účetní jednotka (firma / OSVČ)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_unit (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Uživatelé a role
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    full_name           TEXT NOT NULL,
    email               TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL DEFAULT 'zadavatel'
                            CHECK (role IN ('admin','zadavatel','schvalovatel','ucetni','ctenar')),
    active              INTEGER NOT NULL DEFAULT 1,
    password_hash       TEXT,
    bankid_verified      INTEGER NOT NULL DEFAULT 0,
    bankid_sub           TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Jednatelé/statutární orgán firmy — zdroj pravdy pro ověření přes BankID
-- (jméno vrácené z BankID se porovná s tímto seznamem). V produkci by šlo
-- doplnit/ověřit proti obchodnímu/živnostenskému rejstříku; zatím se
-- zadává ručně podle výpisu z rejstříku.
CREATE TABLE IF NOT EXISTS company_director (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    full_name           TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pozvánky společníků/kolegů do sdíleného přístupu k firmě.
CREATE TABLE IF NOT EXISTS company_invite (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    email               TEXT NOT NULL,
    token               TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL DEFAULT 'zadavatel'
                            CHECK (role IN ('admin','zadavatel','schvalovatel','ucetni','ctenar')),
    invited_by          INTEGER REFERENCES app_user(id),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    used_at             TEXT
);

-- ---------------------------------------------------------------------
-- Účtový rozvrh
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- ---------------------------------------------------------------------
-- Účetní období
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_period (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    fiscal_year         INTEGER NOT NULL,
    start_date          TEXT NOT NULL,
    end_date            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'otevrene' CHECK (status IN ('otevrene','uzavrene')),
    closed_at           TEXT,
    closed_by           INTEGER REFERENCES app_user(id),
    UNIQUE (accounting_unit_id, fiscal_year)
);

-- ---------------------------------------------------------------------
-- Kontakty
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Projekty / zakázky
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    code                TEXT NOT NULL,
    name                TEXT NOT NULL,
    budget              REAL,
    start_date          TEXT,
    end_date            TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    UNIQUE (accounting_unit_id, code)
);

-- ---------------------------------------------------------------------
-- Doklady (§ 11 ZoÚ náležitosti)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
    total_amount        REAL NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'CZK',

    is_vat_document     INTEGER NOT NULL DEFAULT 0,
    vat_base_amount     REAL,
    vat_rate            REAL,
    vat_amount          REAL,
    counterparty_dic    TEXT,

    status              TEXT NOT NULL DEFAULT 'koncept' CHECK (status IN ('koncept','schvaleny','zauctovany','stornovany')),
    responsible_user_id INTEGER NOT NULL REFERENCES app_user(id),
    approved_by         INTEGER REFERENCES app_user(id),
    approved_at         TEXT,

    -- Hotovostní platby fyzickým osobám (umělci) — doplněk nad rámec zákona (kap. 5.4 brief)
    cash_payee_name     TEXT,
    cash_payee_address  TEXT,
    cash_payee_id_number TEXT,
    cash_receipt_signed INTEGER NOT NULL DEFAULT 0,

    attachment_path     TEXT,

    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE (accounting_unit_id, doc_type, doc_number)
);

CREATE TABLE IF NOT EXISTS document_line (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id         INTEGER NOT NULL REFERENCES document(id),
    line_no             INTEGER NOT NULL,
    description         TEXT NOT NULL,
    quantity            REAL NOT NULL DEFAULT 1,
    unit_price          REAL NOT NULL,
    vat_rate            REAL,
    line_amount         REAL NOT NULL,
    suggested_account_id INTEGER REFERENCES chart_of_accounts(id),
    UNIQUE (document_id, line_no)
);

CREATE TABLE IF NOT EXISTS document_attachment (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id         INTEGER NOT NULL REFERENCES document(id),
    file_name           TEXT NOT NULL,
    mime_type           TEXT NOT NULL,
    file_path           TEXT NOT NULL,
    size_bytes          INTEGER NOT NULL,
    uploaded_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- ÚČETNÍ ZÁPISY — append-only jádro průkaznosti
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posting (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),
    posting_number      INTEGER NOT NULL,
    document_id         INTEGER REFERENCES document(id),
    posting_date        TEXT NOT NULL,
    description         TEXT NOT NULL,
    storno_of_posting_id INTEGER REFERENCES posting(id),
    created_by          INTEGER NOT NULL REFERENCES app_user(id),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (accounting_unit_id, posting_number)
);

CREATE TABLE IF NOT EXISTS posting_line (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    posting_id          INTEGER NOT NULL REFERENCES posting(id),
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    side                TEXT NOT NULL CHECK (side IN ('MD','D')),
    amount              REAL NOT NULL CHECK (amount > 0),
    project_id          INTEGER REFERENCES project(id)
);

-- ---------------------------------------------------------------------
-- Evidence pro účely DPH (§ 100 ZDPH)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vat_ledger_entry (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id             INTEGER NOT NULL REFERENCES document(id),
    direction               TEXT NOT NULL CHECK (direction IN ('uskutecnene','prijate')),
    vat_base                REAL NOT NULL,
    vat_rate                REAL NOT NULL,
    vat_amount              REAL NOT NULL,
    counterparty_dic        TEXT,
    duzp                    TEXT NOT NULL,
    requires_individual_kh  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- Dlouhodobý majetek a odpisy
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_asset (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    acquisition_cost    REAL NOT NULL,
    acquisition_date    TEXT NOT NULL,
    useful_life_months  INTEGER NOT NULL,
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    depreciation_account_id INTEGER REFERENCES chart_of_accounts(id),
    residual_value      REAL NOT NULL DEFAULT 0,
    active              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS depreciation_entry (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    fixed_asset_id      INTEGER NOT NULL REFERENCES fixed_asset(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),
    entry_date          TEXT NOT NULL,
    amount              REAL NOT NULL,
    posting_id          INTEGER REFERENCES posting(id)
);

-- ---------------------------------------------------------------------
-- Bankovní výpisy a pokladna
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_statement_line (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    bank_account        TEXT NOT NULL,
    statement_date      TEXT NOT NULL,
    amount              REAL NOT NULL,
    counterparty_name   TEXT,
    variable_symbol     TEXT,
    matched_document_id INTEGER REFERENCES document(id),
    posting_id          INTEGER REFERENCES posting(id),
    -- Idempotence pro pohyby z e-mailu (MessageID) / Stripe (payment_intent) —
    -- viz lib/bankMovements.js createBankStatementLine a UNIQUE index níže
    -- (přidán přes db-sqlite.js migrate(), SQLite nemá ADD COLUMN IF NOT EXISTS).
    external_ref        TEXT,
    imported_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Párovací e-mailová adresa banky (Fakturoid-styl) — token = MailboxHash
-- u Postmark Inbound, mapuje na firmu + bankovní účet, na který se pohyby
-- z e-mailu připisují (routes/inbound-email.js).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_inbound_mailbox (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    token               TEXT NOT NULL UNIQUE,
    bank_account        TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Platby vydaných faktur přes Stripe Checkout (veřejná stránka /pay/:token).
-- Samostatná tabulka, NE sloupce na document — document má silné triggery
-- (period-lock/no-update/no-delete), platba má vlastní lifecycle nezávislý
-- na účetním stavu dokladu (viz flow-state.md "ROZHODNUTÍ").
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_payment (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id      INTEGER NOT NULL REFERENCES accounting_unit(id),
    document_id             INTEGER NOT NULL UNIQUE REFERENCES document(id),
    pay_token               TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
    stripe_session_id       TEXT,
    stripe_payment_intent_id TEXT,
    amount                  REAL,
    currency                TEXT NOT NULL DEFAULT 'CZK',
    paid_at                 TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Naučená pravidla kategorizace bankovních/pokladních pohybů — když
-- uživatel zaúčtuje pohyb bez dokladu (např. bankovní poplatek, úrok)
-- na konkrétní účet, systém si zapamatuje protistranu -> účet a příště
-- ho sám navrhne (viz /api/bank/suggest-categories).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_category_rule (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    match_text          TEXT NOT NULL,
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    hits                INTEGER NOT NULL DEFAULT 1,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (accounting_unit_id, match_text)
);

-- ---------------------------------------------------------------------
-- Inventarizace (roční uzávěrka) — inventurní soupisy
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_check (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    period_id           INTEGER NOT NULL REFERENCES accounting_period(id),
    as_of_date          TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    created_by          INTEGER NOT NULL REFERENCES app_user(id),
    note                TEXT
);

CREATE TABLE IF NOT EXISTS inventory_check_line (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    inventory_check_id  INTEGER NOT NULL REFERENCES inventory_check(id),
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    book_balance        REAL NOT NULL,
    physical_balance    REAL,
    difference          REAL,
    note                TEXT
);

-- ---------------------------------------------------------------------
-- Číselné řady dokladů a účetních zápisů
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- AUDIT LOG — append-only (§ 33 odst. 8-9, § 33a ZoÚ)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at         TEXT NOT NULL DEFAULT (datetime('now')),
    accounting_unit_id  INTEGER REFERENCES accounting_unit(id),
    user_id             INTEGER REFERENCES app_user(id),
    action              TEXT NOT NULL,
    entity_table        TEXT NOT NULL,
    entity_id           INTEGER,
    before_data         TEXT,
    after_data          TEXT
);

-- ---------------------------------------------------------------------
-- Předkontace (posting templates) — šablony pro opakující se účetní
-- případy (kap. 5.2 brief: "pronájem klubu → 518/321"). Inspirováno
-- předkontacemi v Pohodě/Money S3 — umožňují rychlé a konzistentní
-- zaúčtování dokladů jedním kliknutím.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posting_template (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    doc_type            TEXT,
    description         TEXT,
    active              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS posting_template_line (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id         INTEGER NOT NULL REFERENCES posting_template(id),
    account_id          INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    side                TEXT NOT NULL CHECK (side IN ('MD','D')),
    -- Ze které částky dokladu se řádek naplní: celková částka / základ DPH / výše DPH
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
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    name                TEXT NOT NULL,
    description         TEXT,
    unit_price          REAL NOT NULL,
    unit                TEXT,
    vat_rate            REAL,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offer (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    accounting_unit_id  INTEGER NOT NULL REFERENCES accounting_unit(id),
    offer_number        TEXT NOT NULL,
    contact_id          INTEGER REFERENCES contact(id),
    project_id          INTEGER REFERENCES project(id),
    issue_date          TEXT NOT NULL,
    valid_until         TEXT,
    description         TEXT,
    total_amount        REAL NOT NULL DEFAULT 0,
    currency            TEXT NOT NULL DEFAULT 'CZK',
    is_vat_document     INTEGER NOT NULL DEFAULT 0,
    vat_base_amount     REAL,
    vat_rate            REAL,
    vat_amount          REAL,
    status              TEXT NOT NULL DEFAULT 'koncept'
                            CHECK (status IN ('koncept','odeslana','prijata','odmitnuta','prevedena')),
    converted_document_id INTEGER REFERENCES document(id),
    responsible_user_id INTEGER NOT NULL REFERENCES app_user(id),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (accounting_unit_id, offer_number)
);

CREATE TABLE IF NOT EXISTS offer_line (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id            INTEGER NOT NULL REFERENCES offer(id),
    line_no             INTEGER NOT NULL,
    description         TEXT NOT NULL,
    quantity            REAL NOT NULL DEFAULT 1,
    unit_price          REAL NOT NULL,
    vat_rate            REAL,
    line_amount         REAL NOT NULL,
    UNIQUE (offer_id, line_no)
);

CREATE TABLE IF NOT EXISTS recurring_invoice (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
    vat_rate            REAL,
    currency            TEXT NOT NULL DEFAULT 'CZK',
    active              INTEGER NOT NULL DEFAULT 1,
    last_generated_at   TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recurring_invoice_line (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    recurring_invoice_id    INTEGER NOT NULL REFERENCES recurring_invoice(id),
    line_no                 INTEGER NOT NULL,
    description             TEXT NOT NULL,
    quantity                REAL NOT NULL DEFAULT 1,
    unit_price              REAL NOT NULL,
    vat_rate                REAL,
    UNIQUE (recurring_invoice_id, line_no)
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
-- =====================================================================

-- Účetní zápisy nelze nikdy upravit ani smazat
CREATE TRIGGER IF NOT EXISTS trg_posting_no_update
BEFORE UPDATE ON posting
BEGIN
    SELECT RAISE(ABORT, 'Účetní zápisy jsou append-only (§ 33a zákona o účetnictví). Použijte storno.');
END;

CREATE TRIGGER IF NOT EXISTS trg_posting_no_delete
BEFORE DELETE ON posting
BEGIN
    SELECT RAISE(ABORT, 'Účetní zápisy jsou append-only (§ 33a zákona o účetnictví). Použijte storno.');
END;

CREATE TRIGGER IF NOT EXISTS trg_posting_line_no_update
BEFORE UPDATE ON posting_line
BEGIN
    SELECT RAISE(ABORT, 'Řádky účetních zápisů jsou append-only (§ 33a zákona o účetnictví).');
END;

CREATE TRIGGER IF NOT EXISTS trg_posting_line_no_delete
BEFORE DELETE ON posting_line
BEGIN
    SELECT RAISE(ABORT, 'Řádky účetních zápisů jsou append-only (§ 33a zákona o účetnictví).');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'Audit log je append-only a nelze jej upravit.');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'Audit log je append-only a nelze jej smazat.');
END;

-- Doklad lze upravit jen v konceptu; po schválení/zaúčtování/stornu nelze editovat ani mazat
CREATE TRIGGER IF NOT EXISTS trg_document_edit_guard
BEFORE UPDATE ON document
WHEN OLD.status IN ('zauctovany','stornovany') AND NEW.status = OLD.status
BEGIN
    SELECT RAISE(ABORT, 'Doklad je již zaúčtovaný nebo stornovaný — nelze upravit. Vytvořte opravný doklad.');
END;

CREATE TRIGGER IF NOT EXISTS trg_document_no_delete
BEFORE DELETE ON document
BEGIN
    SELECT RAISE(ABORT, 'Doklady nelze mazat (§ 11, § 33a ZoÚ) — pouze stornovat.');
END;

-- Uzamčení účetního období — zápisy do uzavřeného období jsou zakázány
CREATE TRIGGER IF NOT EXISTS trg_document_period_lock
BEFORE INSERT ON document
WHEN (SELECT status FROM accounting_period WHERE id = NEW.period_id) = 'uzavrene'
BEGIN
    SELECT RAISE(ABORT, 'Účetní období je uzavřené po inventarizaci — zápis není možný.');
END;

CREATE TRIGGER IF NOT EXISTS trg_posting_period_lock
BEFORE INSERT ON posting
WHEN (SELECT status FROM accounting_period WHERE id = NEW.period_id) = 'uzavrene'
BEGIN
    SELECT RAISE(ABORT, 'Účetní období je uzavřené po inventarizaci — zápis není možný.');
END;
