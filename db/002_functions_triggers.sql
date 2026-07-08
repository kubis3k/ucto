-- =====================================================================
-- 002_functions_triggers.sql
-- Byznys logika vynucující zákonné požadavky ze SQL vrstvy — funkce
-- a triggery zde nejsou "nice to have", ale přímá implementace § 33a,
-- § 35 a § 8 zákona o účetnictví (neměnnost, průkaznost, auditní stopa).
-- =====================================================================
SET search_path TO ucetnictvi;

-- ---------------------------------------------------------------------
-- 1) APPEND-ONLY: znemožnit UPDATE a DELETE na posting, posting_line
--    a audit_log — jednou zapsáno, navždy zapsáno (§ 33a ZoÚ)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'Operace % na tabulce % není povolena — účetní záznamy jsou append-only (§ 33a zákona o účetnictví). Použijte storno zápis.',
        TG_OP, TG_TABLE_NAME;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_posting_no_update
    BEFORE UPDATE OR DELETE ON posting
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TRIGGER trg_posting_line_no_update
    BEFORE UPDATE OR DELETE ON posting_line
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TRIGGER trg_audit_log_no_update
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Doklad lze editovat jen v konceptu — po schválení/zaúčtování stejná ochrana
CREATE OR REPLACE FUNCTION forbid_document_edit_after_posting() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('zauctovany', 'stornovany') THEN
        RAISE EXCEPTION
            'Doklad % nelze upravit — je již ve stavu "%". Vytvořte opravný/stornovací doklad.',
            OLD.doc_number, OLD.status;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_document_edit_guard
    BEFORE UPDATE ON document
    FOR EACH ROW EXECUTE FUNCTION forbid_document_edit_after_posting();

CREATE TRIGGER trg_document_no_delete
    BEFORE DELETE ON document
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- ---------------------------------------------------------------------
-- 2) NEPŘERUŠENÁ ČÍSELNÁ ŘADA dokladů (§ 11 ZoÚ)
--    Formát: {TYP}-{ROK}-{POŘADÍ}, např. FV-2026-0001
-- ---------------------------------------------------------------------
CREATE TABLE document_number_sequence (
    accounting_unit_id  BIGINT NOT NULL REFERENCES accounting_unit(id),
    doc_type            document_type NOT NULL,
    fiscal_year         INTEGER NOT NULL,
    last_number         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (accounting_unit_id, doc_type, fiscal_year)
);

CREATE OR REPLACE FUNCTION generate_document_number(
    p_unit_id BIGINT, p_type document_type, p_year INTEGER
) RETURNS VARCHAR AS $$
DECLARE
    v_next INTEGER;
    v_prefix VARCHAR(4);
BEGIN
    INSERT INTO document_number_sequence (accounting_unit_id, doc_type, fiscal_year, last_number)
    VALUES (p_unit_id, p_type, p_year, 1)
    ON CONFLICT (accounting_unit_id, doc_type, fiscal_year)
    DO UPDATE SET last_number = document_number_sequence.last_number + 1
    RETURNING last_number INTO v_next;

    v_prefix := CASE p_type
        WHEN 'faktura_vydana'   THEN 'FV'
        WHEN 'faktura_prijata'  THEN 'FP'
        WHEN 'pokladni_prijem'  THEN 'PP'
        WHEN 'pokladni_vydej'   THEN 'PV'
        WHEN 'bankovni_pohyb'   THEN 'BV'
        WHEN 'interni_doklad'   THEN 'ID'
    END;

    RETURN v_prefix || '-' || p_year || '-' || LPAD(v_next::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- Automatické přiřazení čísla při vložení dokladu, pokud není zadáno ručně
CREATE OR REPLACE FUNCTION assign_document_number() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.doc_number IS NULL OR NEW.doc_number = '' THEN
        NEW.doc_number := generate_document_number(
            NEW.accounting_unit_id, NEW.doc_type, EXTRACT(YEAR FROM NEW.issue_date)::INTEGER
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assign_document_number
    BEFORE INSERT ON document
    FOR EACH ROW EXECUTE FUNCTION assign_document_number();

-- Stejný princip pro nepřerušenou řadu účetních zápisů (posting_number)
CREATE TABLE posting_number_sequence (
    accounting_unit_id  BIGINT PRIMARY KEY REFERENCES accounting_unit(id),
    last_number         BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION assign_posting_number() RETURNS TRIGGER AS $$
DECLARE
    v_next BIGINT;
BEGIN
    INSERT INTO posting_number_sequence (accounting_unit_id, last_number)
    VALUES (NEW.accounting_unit_id, 1)
    ON CONFLICT (accounting_unit_id)
    DO UPDATE SET last_number = posting_number_sequence.last_number + 1
    RETURNING last_number INTO v_next;

    NEW.posting_number := v_next;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assign_posting_number
    BEFORE INSERT ON posting
    FOR EACH ROW EXECUTE FUNCTION assign_posting_number();

-- ---------------------------------------------------------------------
-- 3) VYROVNANOST ÚČETNÍHO ZÁPISU: suma MD = suma D pro každý posting
--    (deferred constraint trigger — kontrola až po vložení všech řádků)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_posting_balanced() RETURNS TRIGGER AS $$
DECLARE
    v_md NUMERIC(14,2);
    v_d  NUMERIC(14,2);
    v_posting_id BIGINT;
BEGIN
    v_posting_id := COALESCE(NEW.posting_id, OLD.posting_id);

    SELECT COALESCE(SUM(amount) FILTER (WHERE side = 'MD'), 0),
           COALESCE(SUM(amount) FILTER (WHERE side = 'D'), 0)
    INTO v_md, v_d
    FROM posting_line WHERE posting_id = v_posting_id;

    IF v_md <> v_d THEN
        RAISE EXCEPTION
            'Účetní zápis č. % není vyrovnaný: MD = %, D = %. Podvojné účetnictví vyžaduje MD = D.',
            v_posting_id, v_md, v_d;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_posting_balanced
    AFTER INSERT ON posting_line
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_posting_balanced();

-- ---------------------------------------------------------------------
-- 4) UZAMČENÍ ÚČETNÍHO OBDOBÍ po inventarizaci (§ 29-30 ZoÚ)
--    Zápisy do uzavřeného období jsou zakázány.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_period_open() RETURNS TRIGGER AS $$
DECLARE
    v_status period_status;
BEGIN
    SELECT status INTO v_status FROM accounting_period WHERE id = NEW.period_id;
    IF v_status = 'uzavrene' THEN
        RAISE EXCEPTION
            'Účetní období (period_id = %) je uzavřené po inventarizaci — zápis není možný.',
            NEW.period_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_posting_period_lock
    BEFORE INSERT ON posting
    FOR EACH ROW EXECUTE FUNCTION check_period_open();

CREATE TRIGGER trg_document_period_lock
    BEFORE INSERT ON document
    FOR EACH ROW EXECUTE FUNCTION check_period_open();

-- Funkce pro uzavření období — jediná povolená cesta ke změně period_status
CREATE OR REPLACE FUNCTION close_accounting_period(
    p_period_id BIGINT, p_closed_by BIGINT
) RETURNS VOID AS $$
BEGIN
    UPDATE accounting_period
    SET status = 'uzavrene', closed_at = now(), closed_by = p_closed_by
    WHERE id = p_period_id AND status = 'otevrene';

    INSERT INTO audit_log (accounting_unit_id, user_id, action, entity_table, entity_id, after_data)
    SELECT accounting_unit_id, p_closed_by, 'PERIOD_CLOSE', 'accounting_period', id,
           jsonb_build_object('closed_at', now())
    FROM accounting_period WHERE id = p_period_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 5) AUTOMATICKÝ AUDIT LOG na klíčových tabulkách
--    (generický trigger — zapisuje před/po hodnotu jako JSON)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION write_audit_log() RETURNS TRIGGER AS $$
DECLARE
    v_unit_id BIGINT;
BEGIN
    BEGIN
        v_unit_id := COALESCE(NEW.accounting_unit_id, OLD.accounting_unit_id);
    EXCEPTION WHEN undefined_column THEN
        v_unit_id := NULL;
    END;

    INSERT INTO audit_log (accounting_unit_id, action, entity_table, entity_id, before_data, after_data)
    VALUES (
        v_unit_id,
        TG_OP,
        TG_TABLE_NAME,
        COALESCE(NEW.id, OLD.id),
        CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
        CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END
    );
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_document
    AFTER INSERT OR UPDATE OR DELETE ON document
    FOR EACH ROW EXECUTE FUNCTION write_audit_log();

CREATE TRIGGER trg_audit_posting
    AFTER INSERT ON posting
    FOR EACH ROW EXECUTE FUNCTION write_audit_log();

CREATE TRIGGER trg_audit_chart_of_accounts
    AFTER INSERT OR UPDATE ON chart_of_accounts
    FOR EACH ROW EXECUTE FUNCTION write_audit_log();

-- ---------------------------------------------------------------------
-- 6) POMOCNÁ FUNKCE: vytvoření stornovacího zápisu
--    (jediný povolený způsob, jak "zrušit" účinek chybného posting)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION storno_posting(
    p_posting_id BIGINT, p_reason TEXT, p_created_by BIGINT
) RETURNS BIGINT AS $$
DECLARE
    v_new_posting_id BIGINT;
    v_unit_id BIGINT;
    v_period_id BIGINT;
BEGIN
    SELECT accounting_unit_id, period_id INTO v_unit_id, v_period_id
    FROM posting WHERE id = p_posting_id;

    INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id,
                          posting_date, description, storno_of_posting_id, created_by)
    VALUES (v_unit_id, v_period_id, 0, NULL, CURRENT_DATE,
            'STORNO: ' || p_reason, p_posting_id, p_created_by)
    RETURNING id INTO v_new_posting_id;

    -- Obrácené řádky (MD <-> D prohozeno) neutralizují původní účinek
    INSERT INTO posting_line (posting_id, account_id, side, amount, project_id)
    SELECT v_new_posting_id, account_id,
           CASE WHEN side = 'MD' THEN 'D' ELSE 'MD' END::posting_side,
           amount, project_id
    FROM posting_line WHERE posting_id = p_posting_id;

    RETURN v_new_posting_id;
END;
$$ LANGUAGE plpgsql;
