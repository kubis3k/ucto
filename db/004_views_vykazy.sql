-- =====================================================================
-- 004_views_vykazy.sql
-- Reportovací vrstva: Hlavní kniha, Rozvaha, Výsledovka, sledování
-- obratu pro DPH limit, kniha pohledávek/závazků.
--
-- Toto je logické pokračování po schématu a byznys logice — jde o
-- moduly "Hlavní kniha" a "Výkazy" z architektury (Ucetni_system_brief).
-- Rozvaha/Výsledovka jsou implementovány jako table-valued funkce
-- (ne prosté views), protože potřebují parametr "k datu" / "za období".
-- =====================================================================
SET search_path TO ucetnictvi;

-- ---------------------------------------------------------------------
-- Pomocná funkce: normální zůstatek účtu podle jeho typu
-- (aktivní/náklad = MD-D je "přirozený" nárůst; pasivní/výnos = D-MD)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION account_natural_balance(
    p_account_id BIGINT, p_as_of_date DATE
) RETURNS NUMERIC AS $$
DECLARE
    v_type account_type;
    v_md NUMERIC(14,2);
    v_d  NUMERIC(14,2);
BEGIN
    SELECT account_type INTO v_type FROM chart_of_accounts WHERE id = p_account_id;

    SELECT COALESCE(SUM(pl.amount) FILTER (WHERE pl.side = 'MD'), 0),
           COALESCE(SUM(pl.amount) FILTER (WHERE pl.side = 'D'), 0)
    INTO v_md, v_d
    FROM posting_line pl
    JOIN posting p ON p.id = pl.posting_id
    WHERE pl.account_id = p_account_id AND p.posting_date <= p_as_of_date;

    IF v_type IN ('rozvahovy_aktivni', 'vysledkovy_naklad') THEN
        RETURN v_md - v_d;
    ELSE
        RETURN v_d - v_md;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- HLAVNÍ KNIHA — pohyby a průběžný zůstatek po jednotlivých účtech
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_hlavni_kniha(
    p_unit_id BIGINT, p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS TABLE (
    account_number VARCHAR, account_name TEXT, posting_date DATE,
    posting_number BIGINT, description TEXT, md_amount NUMERIC, d_amount NUMERIC,
    running_balance NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        coa.account_number, coa.name, p.posting_date, p.posting_number, p.description,
        (CASE WHEN pl.side = 'MD' THEN pl.amount ELSE NULL END) AS md_amount,
        (CASE WHEN pl.side = 'D'  THEN pl.amount ELSE NULL END) AS d_amount,
        SUM(
            CASE
                WHEN coa.account_type IN ('rozvahovy_aktivni','vysledkovy_naklad')
                    THEN (CASE WHEN pl.side='MD' THEN pl.amount ELSE -pl.amount END)
                ELSE (CASE WHEN pl.side='D' THEN pl.amount ELSE -pl.amount END)
            END
        ) OVER (PARTITION BY coa.id ORDER BY p.posting_date, p.posting_number
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
    FROM posting_line pl
    JOIN posting p ON p.id = pl.posting_id
    JOIN chart_of_accounts coa ON coa.id = pl.account_id
    WHERE coa.accounting_unit_id = p_unit_id AND p.posting_date <= p_as_of_date
    ORDER BY coa.account_number, p.posting_date, p.posting_number;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- ROZVAHA (zjednodušený rozsah — mikro účetní jednotka)
-- Pozn.: jde o orientační agregaci podle tříd 0-4; přesné zařazení
-- do řádků dle přílohy č. 1 vyhl. 500/2002 Sb. doporučujeme nechat
-- ověřit účetní firmou před prvním oficiálním výstupem.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_rozvaha(
    p_unit_id BIGINT, p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS TABLE (
    strana TEXT, account_class SMALLINT, account_number VARCHAR,
    account_name TEXT, zustatek NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE WHEN coa.account_type = 'rozvahovy_aktivni' THEN 'AKTIVA' ELSE 'PASIVA' END,
        coa.account_class, coa.account_number, coa.name,
        account_natural_balance(coa.id, p_as_of_date)
    FROM chart_of_accounts coa
    WHERE coa.accounting_unit_id = p_unit_id
      AND coa.account_type IN ('rozvahovy_aktivni', 'rozvahovy_pasivni')
      AND coa.parent_account_id IS NULL   -- jen syntetické účty, bez analytik
    ORDER BY strana DESC, coa.account_number;
END;
$$ LANGUAGE plpgsql STABLE;

-- Kontrolní součet AKTIVA = PASIVA (§ 4 odst. 11 vyhl. 500/2002 Sb.)
CREATE OR REPLACE FUNCTION fn_rozvaha_kontrola(
    p_unit_id BIGINT, p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS TABLE (aktiva_celkem NUMERIC, pasiva_celkem NUMERIC, rozdil NUMERIC) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(zustatek) FILTER (WHERE strana = 'AKTIVA'), 0),
        COALESCE(SUM(zustatek) FILTER (WHERE strana = 'PASIVA'), 0),
        COALESCE(SUM(zustatek) FILTER (WHERE strana = 'AKTIVA'), 0)
            - COALESCE(SUM(zustatek) FILTER (WHERE strana = 'PASIVA'), 0)
    FROM fn_rozvaha(p_unit_id, p_as_of_date);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- VÝSLEDOVKA (výkaz zisku a ztráty) za účetní období — zjednodušený rozsah
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_vysledovka(
    p_unit_id BIGINT, p_period_id BIGINT
) RETURNS TABLE (
    druh TEXT, account_number VARCHAR, account_name TEXT, castka NUMERIC
) AS $$
DECLARE
    v_start DATE; v_end DATE;
BEGIN
    SELECT start_date, end_date INTO v_start, v_end
    FROM accounting_period WHERE id = p_period_id;

    RETURN QUERY
    SELECT
        CASE WHEN coa.account_type = 'vysledkovy_naklad' THEN 'NÁKLAD' ELSE 'VÝNOS' END,
        coa.account_number, coa.name,
        SUM(CASE
                WHEN coa.account_type = 'vysledkovy_naklad' AND pl.side = 'MD' THEN pl.amount
                WHEN coa.account_type = 'vysledkovy_vynos'  AND pl.side = 'D'  THEN pl.amount
                ELSE 0
            END)
    FROM posting_line pl
    JOIN posting p ON p.id = pl.posting_id
    JOIN chart_of_accounts coa ON coa.id = pl.account_id
    WHERE coa.accounting_unit_id = p_unit_id
      AND coa.account_type IN ('vysledkovy_naklad', 'vysledkovy_vynos')
      AND p.posting_date BETWEEN v_start AND v_end
      AND coa.parent_account_id IS NULL
    GROUP BY coa.account_type, coa.account_number, coa.name
    ORDER BY druh, coa.account_number;
END;
$$ LANGUAGE plpgsql STABLE;

-- Výsledek hospodaření za období = výnosy - náklady (musí sedět s rozvahou)
CREATE OR REPLACE FUNCTION fn_vysledek_hospodareni(
    p_unit_id BIGINT, p_period_id BIGINT
) RETURNS NUMERIC AS $$
DECLARE
    v_vynosy NUMERIC; v_naklady NUMERIC;
BEGIN
    SELECT COALESCE(SUM(castka) FILTER (WHERE druh = 'VÝNOS'), 0),
           COALESCE(SUM(castka) FILTER (WHERE druh = 'NÁKLAD'), 0)
    INTO v_vynosy, v_naklady
    FROM fn_vysledovka(p_unit_id, p_period_id);

    RETURN v_vynosy - v_naklady;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- SLEDOVÁNÍ OBRATU PRO DPH LIMIT (2 mil. Kč / 12 po sobě jdoucích měsíců)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_obrat_12m AS
SELECT
    d.accounting_unit_id,
    SUM(d.total_amount) AS obrat_12m,
    SUM(d.total_amount) >= 2000000 AS blizi_se_limitu_dph,
    2000000 - SUM(d.total_amount) AS zbyva_do_limitu
FROM document d
WHERE d.doc_type = 'faktura_vydana'
  AND d.status <> 'stornovany'
  AND d.issue_date >= (CURRENT_DATE - INTERVAL '12 months')
GROUP BY d.accounting_unit_id;

COMMENT ON VIEW v_obrat_12m IS
    'Proaktivní sledování obratu vůči zákonnému limitu pro povinnou registraci k DPH (§ 6 zákona o DPH). Kontrolovat alespoň měsíčně.';

-- ---------------------------------------------------------------------
-- KNIHA POHLEDÁVEK A ZÁVAZKŮ — nesplacené faktury k dnešnímu dni
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_kniha_pohledavky_zavazky AS
SELECT
    d.id AS document_id, d.doc_type, d.doc_number, c.name AS protistrana,
    d.issue_date, d.due_date, d.total_amount,
    (CURRENT_DATE - d.due_date) AS dni_po_splatnosti,
    d.status
FROM document d
LEFT JOIN contact c ON c.id = d.contact_id
LEFT JOIN bank_statement_line b ON b.matched_document_id = d.id
WHERE d.doc_type IN ('faktura_vydana', 'faktura_prijata')
  AND d.status <> 'stornovany'
  AND b.id IS NULL   -- není spárováno s žádnou platbou = stále neuhrazeno
ORDER BY d.due_date;

COMMENT ON VIEW v_kniha_pohledavky_zavazky IS
    'Otevřené (neuhrazené) pohledávky a závazky — pro sledování cash-flow a upomínky.';
