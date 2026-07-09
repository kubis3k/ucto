# Handoff — stav k 09.07.2026 (konec session, málo tokenů)

Poslední commit: `7db5288` (pushnuto na `kubis3k/ucto` main).

## Co je HOTOVÉ a ověřené v této session

1. **Bug „nikam se to nepropisuje" na `ucto.globaalelevate.com` — VYŘEŠENO (návod pro uživatele, nic k programování).**
   Příčina: na Vercelu chybí `DATABASE_URL` a `JWT_SECRET` → appka spadá na SQLite v `/tmp`, které se maže při každém coldstartu serverless funkce (jiný request = jiný kontejner = prázdná DB). Proto i "Neplatná session" napořád.
   **Uživatel má za úkol:** založit Postgres (Neon/Supabase, zdarma), nastavit `DATABASE_URL` + `JWT_SECRET` ve Vercel env vars, redeploy. Backend pro Postgres (`app/server/db-pg.js` + `schema-pg.sql`) je hotový a čeká na to. Nic dalšího tady není potřeba psát — jen deploy config.

2. **Sken faktury (PDF) v „Nový doklad"** — hotovo, ověřeno v Node přímo na reálné faktuře (`C:\Users\jakub\Downloads\faktura_20260019.pdf`, extrahovalo správně datum, splatnost, VS, částku, IČO/DIČ, číslo účtu).
   - Backend: `app/server/lib/invoiceScan.js` (pdf-parse v2 API — `PDFParse` třída, ne funkce!) + route `POST /api/documents/scan` v `documents.js`.
   - Frontend: `documentFormModal()` má nahoře box s file inputem + tlačítkem „Naskenovat"; `scanInvoiceDocument()` prefilluje pole a dotáhne dodavatele přes ARES podle IČO (jméno z PDF layoutu nejde spolehlivě parsovat — dvousloupcové faktury se textově proplétají).
   - PNG/JPG: soubor lze přiložit, ale OCR NENÍ implementované (bylo by potřeba tesseract.js — vynecháno kvůli tokenům). `ocr_supported: false` se vrací a frontend na to upozorní.
   - **NEOVĚŘENO v prohlížeči** — jen node test + syntax check (`node --check`). Než na to spolehnout, udělat jeden průchod v preview (otevřít Doklady → Nový doklad → vybrat PDF → Naskenovat → zkontrolovat, že se pole vyplní a že se po submitu příloha nahraje).

3. **Banka a pokladna — chytřejší modul** — hotovo, backend ověřený end-to-end přes curl (import → suggest-categories → quick-post → vyrovnaný zápis v hlavní knize → cashflow), frontend jen syntax-checked.
   - Nová tabulka `bank_category_rule` (učení: protistrana → účet) + sloupec `bank_statement_line.posting_id` (migrace v `db-sqlite.js` `migrate()`, přímo v `schema-pg.sql` pro Postgres).
   - Nové routy v `server/routes/bank.js`: `GET /suggest-categories`, `POST /:id/quick-post`, `GET /cashflow`.
   - `renderBank()` v `app.js` přepsaný — cashflow KPI karty nahoře, u nespárovaných řádků tlačítko „⚡ navržený účet" (jedním klikem zaúčtuje) nebo ruční výběr.
   - **NEOVĚŘENO v prohlížeči** — příští krok: otevřít Banka a pokladna, zkontrolovat, že se karty a tlačítka vykreslí a funkčně kliknou.

## Co ZBÝVÁ (řečeno uživateli, čeká na pokyn/tokeny)

- Auto-zaúčtování podle pravidel (obecné, ne jen pro banku) — **uživatel řekl vynechat pro teď**, není dost tokenů.
- Staré rozpracované úkoly z dřívějška (byly „pending" už před touto session, možná částečně hotové jinou session — **zkontrolovat, než se do nich pouštět**, ať se nedělá duplicitní práce):
  - #17 Odstranění seed projektů + rozšíření účtového rozvrhu → **rozvrh vypadá už rozšířený** (viz test výše: unit 2 měl 013,014,021...568,569...662,663,668 — mnohem víc než původní ~20 účtů). Ověřit, jestli #17/#18 (mazání projektů/účtů) je potřeba, nebo jsou hotové.
  - #19–21 (upload PDF k dokladům, CSV import v Účetním deníku) → **upload k dokladům (multer/attachments) UŽ EXISTUJE** v `documents.js` (viděno při této session) — task list je zastaralý, tyhle úkoly jsou pravděpodobně už hotové. CSV import přímo v Účetním deníku (ne v Bance) zatím neověřeno/nenalezeno.
  - #22 Přepsat SYSTEM.md souhrn celého systému — nehotové.

## Důležité poznámky pro dalšího agenta

- **Autentizace je teď povinná na všech API routách.** Testovat curlem = potřeba nejdřív token (`POST /auth/login` nebo `/auth/register-company`, viz práce v této session).
- **`pdf-parse` v2 má jinou API** než v1 — `const { PDFParse } = require("pdf-parse")`, `new PDFParse({data: buffer}).getText()`, ne `require("pdf-parse")(buffer)`.
- **Postgres kompatibilita:** `server/routes/*.js` je sdílený kód pro SQLite i Postgres (`db-pg.js` má translateQuery, co překládá `?`→`$1`, `last_insert_rowid()`→`lastval()`, `datetime('now')`→`now()`). Nové SQL psát v SQLite dialektu, translator to převede — ALE parametrizované časové razítko (JS `new Date().toISOString()`) je bezpečnější než spoléhat na překladač u složitějších výrazů.
- **Task list (TaskList tool) je zastaralý** — úkoly #17–22 tam visí jako "pending" z dřívějška, ale minimálně #19/#20 (upload) vypadají už hotové z jiné session. Než na ně sahat, ověřit realný stav kódu, ne věřit slepě task listu.
- Databáze pro dev testy: `app/.devdata` — smazat před čistým testem (`rm -rf app/.devdata`), jinak se seed data nepustí znovu.

## Rychlý start pro pokračování

```bash
cd app && rm -rf .devdata && node server/index.js
# v jiném terminálu: přihlásit se (viz curl příkazy v git historii commitu 7db5288)
```

Priorita dalšího kroku: **browser-verify sken faktury a Banku** (preview_start api + renderer, proklikat), pak teprve nové featury.
