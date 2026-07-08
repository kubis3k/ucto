-- =====================================================================
-- 003_seed_data.sql
-- Počáteční data: účetní jednotka Globaal Elevate a startovní účtový
-- rozvrh (viz kapitola 5.3 dokumentu Ucetni_system_brief.docx).
-- =====================================================================
SET search_path TO ucetnictvi;

-- ---------------------------------------------------------------------
-- Účetní jednotka
-- ---------------------------------------------------------------------
INSERT INTO accounting_unit (name, ico, dic, accounting_mode, unit_category, is_vat_payer, fiscal_year_start_month)
VALUES ('Globaal Elevate Production s.r.o.', '00000000', 'CZ24972070',
        'podvojne_ucetnictvi', 'mikro', FALSE, 1);
-- Pozn.: IČO doplnit skutečnou hodnotou před ostrým nasazením (DIČ CZ24972070 dle rozhodnutí FÚ).

-- ---------------------------------------------------------------------
-- První uživatel (jednatel)
-- ---------------------------------------------------------------------
INSERT INTO app_user (accounting_unit_id, full_name, email, role)
VALUES (1, 'Luigi', 'luigi@globaalelevate.com', 'admin');

-- ---------------------------------------------------------------------
-- Účetní období — rok 2026 (od data vzniku firmy 20.4.2026 do 31.12.2026)
-- ---------------------------------------------------------------------
INSERT INTO accounting_period (accounting_unit_id, fiscal_year, start_date, end_date, status)
VALUES (1, 2026, '2026-04-20', '2026-12-31', 'otevrene');

-- ---------------------------------------------------------------------
-- Startovní účtový rozvrh (dle kap. 5.3 brief dokumentu)
-- account_class: první číslice účtu; account_type dle rozvahový/výsledkový
-- ---------------------------------------------------------------------
INSERT INTO chart_of_accounts (accounting_unit_id, account_number, name, account_class, account_type) VALUES
(1, '211', 'Pokladna',                                   2, 'rozvahovy_aktivni'),
(1, '221', 'Bankovní účet',                               2, 'rozvahovy_aktivni'),
(1, '311', 'Odběratelé',                                  3, 'rozvahovy_aktivni'),
(1, '321', 'Dodavatelé',                                  3, 'rozvahovy_pasivni'),
(1, '325', 'Ostatní závazky (honoráře bez faktury)',       3, 'rozvahovy_pasivni'),
(1, '343', 'DPH (aktivuje se s registrací)',               3, 'rozvahovy_pasivni'),
(1, '381', 'Náklady příštích období',                     3, 'rozvahovy_aktivni'),
(1, '022', 'Samostatné movité věci (dlouhodobý majetek)',  0, 'rozvahovy_aktivni'),
(1, '082', 'Oprávky k samostatným movitým věcem',          0, 'rozvahovy_aktivni'),
(1, '411', 'Základní kapitál',                            4, 'rozvahovy_pasivni'),
(1, '431', 'Výsledek hospodaření ve schvalovacím řízení',  4, 'rozvahovy_pasivni'),
(1, '501', 'Spotřeba materiálu',                          5, 'vysledkovy_naklad'),
(1, '512', 'Cestovné',                                    5, 'vysledkovy_naklad'),
(1, '518', 'Ostatní služby (pronájmy, technika, právní/účetní služby)', 5, 'vysledkovy_naklad'),
(1, '531', 'Daně a poplatky (OSA, správní poplatky)',       5, 'vysledkovy_naklad'),
(1, '538', 'Ostatní daně a poplatky',                      5, 'vysledkovy_naklad'),
(1, '551', 'Odpisy dlouhodobého majetku',                  5, 'vysledkovy_naklad'),
(1, '602', 'Tržby z prodeje služeb (vstupenky, sponzoring)', 6, 'vysledkovy_vynos'),
(1, '604', 'Tržby za zboží',                               6, 'vysledkovy_vynos'),
(1, '701', 'Počáteční účet rozvažný',                      7, 'zaverkovy'),
(1, '702', 'Konečný účet rozvažný',                        7, 'zaverkovy'),
(1, '710', 'Účet zisků a ztrát',                           7, 'zaverkovy');

-- Příklad analytického rozpadu 518 podle projektu (volitelné, ilustrační)
INSERT INTO chart_of_accounts (accounting_unit_id, account_number, parent_account_id, name, account_class, account_type)
SELECT 1, '518100', id, '518 — analytika: Nik Tendo Praha', 5, 'vysledkovy_naklad'
FROM chart_of_accounts WHERE account_number = '518' AND accounting_unit_id = 1;

INSERT INTO chart_of_accounts (accounting_unit_id, account_number, parent_account_id, name, account_class, account_type)
SELECT 1, '518200', id, '518 — analytika: 3L Fest', 5, 'vysledkovy_naklad'
FROM chart_of_accounts WHERE account_number = '518' AND accounting_unit_id = 1;

-- ---------------------------------------------------------------------
-- Projekty (aktuální akce z konverzace)
-- ---------------------------------------------------------------------
INSERT INTO project (accounting_unit_id, code, name, start_date) VALUES
(1, 'NIKTENDO2027', 'Nik Tendo Praha',   '2027-01-22'),
(1, '3LWAVE',       '3Lwave klubová série', '2027-01-01'),
(1, '58G-CHOMUTOV', '58G Chomutov (Latino klub)', '2026-09-11'),
(1, '3LFEST',       '3L Fest — Chomutov airfield pilot', '2027-06-01');
