# Globaal Elevate — Nezávislý účetní systém

Implementace podle [brief/Ucetni_system_brief_1.docx](brief/Ucetni_system_brief_1.docx).

## Struktura projektu

- `brief/` — původní právní/architektonický brief (zdroj pravdy pro požadavky).
- `db/` — referenční PostgreSQL schéma z fáze 0–1 (schema, triggery, seed, výkazy). Použitelné, pokud se systém v budoucnu nasadí na server místo desktopu.
- `server-postgres-reference/` — původní Express API nad PostgreSQL (fáze 1). Ponecháno jako reference, **není součástí desktopové appky**.
- `app/` — **hotová desktopová aplikace** (Electron): embedded Express server + SQLite (sql.js, bez nutnosti instalovat PostgreSQL) + UI.

## Spuštění aplikace

Nainstalovaný balíček: `app/dist/Globaal Elevate Ucetnictvi Setup 1.0.0.exe` — spustitelný instalátor pro Windows.

### Vývoj / úpravy

```
cd app
npm install
npm start            # spustí Electron aplikaci
npm run dev:server   # pouze embedded API na http://localhost:4000 (bez Electronu)
npm run dev:renderer # pouze UI na http://localhost:5173 (proti dev:server, pro rychlé úpravy vzhledu)
npm run dist         # znovu vytvoří instalátor .exe do app/dist/
```

## Proč SQLite (sql.js) místo PostgreSQL v desktop verzi

Brief doporučuje PostgreSQL pro serverové nasazení. Pro samostatnou `.exe` aplikaci u jednoho uživatele (Luigi) by ale vyžadování běžícího PostgreSQL serveru znamenalo instalaci a správu další služby. `sql.js` (SQLite zkompilované do WebAssembly) běží čistě v procesu aplikace — bez instalace, bez nutnosti Visual Studio Build Tools při sestavení `.exe`. Datový model a byznys pravidla (append-only, číselné řady, uzamykání období, audit log) jsou 1:1 portovaná z PostgreSQL verze — viz `app/server/schema.sql` a `app/server/lib/core.js`. Pokud v budoucnu firma přeroste na víc uživatelů/server, `db/` obsahuje hotové PostgreSQL schéma k migraci.

Databáze reálného provozu se ukládá do `%APPDATA%\globaal-elevate-ucetnictvi\ucetnictvi.sqlite` — přežívá aktualizace i přeinstalaci aplikace.

## Implementované moduly (dle kap. 3.3 brief)

Doklady · Účetní deník a hlavní kniha · Účtový rozvrh · Banka a pokladna · DPH evidence (připraveno) · Majetek a odpisy · Výkazy (rozvaha/výsledovka) · Inventarizace a roční uzávěrka · Audit log · Kontakty a projekty · Uživatelé a role · Export (CSV) pro daňového poradce.

## Rozšíření nad rámec briefu (inspirace konkurencí: Pohoda, Money S3, iDoklad, Fakturoid)

Na přání uživatele byly doplněny funkce, které brief buď zmiňoval jen okrajově, nebo řadil „mimo rozsah 1. fáze":

- **Napojení na ARES** — v Kontaktech stačí zadat IČO a kliknout „Načíst z ARES": název, adresa, DIČ i stav plátcovství DPH se doplní automaticky z registru Ministerstva financí. Funguje i fulltextové vyhledání firmy podle názvu. (Brief řadil externí napojení mimo 1. fázi — uživatel si toto omezení výslovně přál ignorovat kvůli pohodlí. ARES je jen pro čtení a nenarušuje nezávislost účetních dat.)
- **Předkontace (šablony zaúčtování)** — brief je zmiňuje v kap. 5.2; implementováno plně podle vzoru Pohody/Money S3. Doklad se zaúčtuje jedním kliknutím výběrem šablony (např. pronájem → 518/321), včetně variant se základem a DPH.
- **QR platba (SPD)** — na každém dokladu lze zobrazit QR kód ve standardu České bankovní asociace (jako Fakturoid/iDoklad). Vyžaduje IBAN v Nastavení (vydané faktury) nebo u kontaktu (přijaté).
- **Nápověda / návod k použití** — nová sekce v aplikaci vysvětlující, jak dělat účetní deník, storno, uzávěrku, DPH, význam účtů atd.

## Deep research — zdroje

Funkce byly zvoleny na základě rešerše českého trhu účetních systémů:
- [Fakturoid vs iDoklad 2026](https://biztools.cz/articles/fakturoid-vs-idoklad-2026-ktery-fakturacni-software-je-lepsi)
- [iÚčto vs. Pohoda vs. Money S3 vs. ABRA FlexiBee](https://www.iucto.cz/iucto-vs-konkurence/)
- [ARES REST API](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty) (Ministerstvo financí ČR)
- [Specifikace QR platby (SPD 1.0)](https://qr-platba.cz/pro-vyvojare/specifikace-formatu/) (Česká bankovní asociace)

## Známá omezení / co je záměrně zjednodušené

- Bankovní import je ruční zadání řádků (ne automatický CSV parser) — v souladu s kap. 8.3 brief ("Co zůstává mimo rozsah").
- Automatizované podání na Finanční správu (EPO) není implementováno — systém exportuje podklady (CSV) pro ruční podání nebo předání účetní, jak brief požaduje.
- Přesné řádkování rozvahy/výsledovky dle přílohy č. 1 a 2 vyhl. 500/2002 Sb. je agregační (dle třídy účtu), ne doslovně řádek-po-řádku — brief výslovně doporučuje nechat strukturu ověřit účetní firmou před ostrým použitím (kap. 8.4).
- `.exe` není podepsaný (žádný code-signing certifikát) — Windows SmartScreen při prvním spuštění může zobrazit upozornění "neznámý vydavatel", což je u interního nástroje očekávané.
