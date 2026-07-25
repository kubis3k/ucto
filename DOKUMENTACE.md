# Dokumentace — Globaal Elevate, nezávislý účetní systém

**Verze aplikace:** 1.0.1
**Dokumentace zpracována:** 2026-07-21
**Účetní jednotka:** Globaal Elevate Production s.r.o., IČO 24972070
**Zdrojový kód:** `github.com/kubis3k/ucto` (privátní)
**Webová verze:** `ucto.globaalelevate.com`

> Tato dokumentace je psaná podle skutečného stavu kódu, ne podle původního zadání.
> Sekce [12. Známá omezení](#12-známá-omezení-a-mezery) uvádí i to, co systém **neumí** —
> je určená mimo jiné k předání účetní firmě nebo auditorovi k rozboru.

---

## Obsah

1. [Co to je](#1-co-to-je)
2. [Proč to vzniklo](#2-proč-to-vzniklo)
3. [Architektura](#3-architektura)
4. [Právní základ](#4-právní-základ)
5. [Pravidla vynucená na úrovni databáze](#5-pravidla-vynucená-na-úrovni-databáze)
6. [Funkční moduly](#6-funkční-moduly)
7. [Datový model](#7-datový-model)
8. [Účtový rozvrh](#8-účtový-rozvrh)
9. [Bezpečnost a izolace dat](#9-bezpečnost-a-izolace-dat)
10. [Provoz a nasazení](#10-provoz-a-nasazení)
11. [Testování](#11-testování)
12. [Známá omezení a mezery](#12-známá-omezení-a-mezery)

---

## 1. Co to je

Vlastní software pro vedení **podvojného účetnictví** a **evidence pro účely DPH** podle
českého práva. Není to jen fakturační nástroj — obsahuje plný účetní deník, hlavní knihu,
účtový rozvrh, účetní výkazy (rozvaha, výsledovka, příloha k závěrce), inventarizaci,
uzávěrku a nezměnitelný audit log.

Existuje ve dvou podobách nad **jedním a tímtéž zdrojovým kódem**:

| | Webová verze | Desktopová aplikace |
|---|---|---|
| Kde běží | `ucto.globaalelevate.com` (Vercel) | Windows / macOS (Electron) |
| Databáze | PostgreSQL (Neon) | žádná vlastní — je to **tenký klient** |
| Přístup | prohlížeč, včetně mobilu | nativní okno |
| Offline | jen čtení naposledy stažených dat | totéž |

Desktopová appka **nemá vlastní databázi ani server** — načítá živou webovou aplikaci
(`loadURL`) a přidává nativní okno, automatické aktualizace a systémovou integraci.
Jediný zdroj pravdy je vždy web.

---

## 2. Proč to vzniklo

Namísto komerčního softwaru (Pohoda, Money S3, Fakturoid, iDoklad) je systém vyvinutý
interně, s těmito cíli:

- **Kontrola nad daty** — žádný cizí dodavatel nemá přístup k účetnictví firmy.
- **Auditovatelnost na úrovni jednotlivého zápisu** — každý úkon je v append-only audit logu.
- **Přizpůsobení firemním procesům** — fakturace, párování banky, projektová analytika
  přesně podle toho, jak firma reálně funguje (produkce, marketing, eventy).
- **Průkaznost vynucená technicky, ne jen procesně** — nezměnitelnost účetních zápisů
  je vynucená databázovými triggery, ne pouhou dohodou nebo aplikační logikou (viz [sekce 5](#5-pravidla-vynucená-na-úrovni-databáze)).

---

## 3. Architektura

### 3.1 Technologie

| Vrstva | Technologie |
|---|---|
| Runtime | Node.js, Express.js (REST API) |
| Databáze (web) | PostgreSQL — driver `pg` |
| Databáze (lokální vývoj) | SQLite ve WebAssembly — `sql.js` |
| Frontend | Vanilla JavaScript, **bez frameworku a bez build kroku** |
| Desktop shell | Electron 31 + `electron-updater` |
| Autentizace | JWT (`Authorization: Bearer`), hesla přes `bcryptjs` |
| Ověření jednatele | BankID (OIDC) — režimy `mock` / `live` |
| PDF | `pdfkit` (faktury, nabídky, závěrka, měsíční uzávěrka) |
| OCR / sken faktury | `pdf-parse` (server, PDF) + Tesseract.js (prohlížeč, obrázky) |
| E-mail | `nodemailer` (odesílání), vlastní parser (příjem bankovních notifikací) |
| Platby | Stripe Checkout, QR platba ve standardu SPD |
| Kurzy | kurzovní lístek ČNB (denní, s cache v DB) |
| Nasazení webu | Vercel serverless (`api/index.js`) + statické rewrites |
| Testy | `node:test` (vestavěný v Node, žádná další závislost) |

**Frontend nemá žádný bundler ani transpiling.** Celá aplikace je jeden soubor
`app/renderer/app.js` (~3 800 řádků) + `style.css`. Grafy, ikony, router, modaly —
vlastní kód. Z CDN se v runtime tahá jen Tesseract.js (lazy, až při prvním OCR obrázku)
a fonty IBM Plex.

### 3.2 Přepínání databáze

Soubor `app/server/db.js` je jednořádkový rozhodovací bod:

```js
module.exports = process.env.DATABASE_URL ? require("./db-pg") : require("./db-sqlite");
```

Oba adaptéry vystavují **identické asynchronní rozhraní**
(`init` / `all` / `get` / `run` / `transaction` / `persist` / `getDb` / `getUserDataDir`),
takže žádná routa ani business logika neví, se kterým backendem mluví. Obchodní pravidla,
výpočty a validace jsou tedy pro web i lokální vývoj **doslova stejný kód**.

Postgres adaptér navíc řeší souběžnost: transakce si zapůjčí klienta z poolu a naváže ho na
`AsyncLocalStorage`, aby souběžné požadavky různých firem nemohly omylem sdílet cizí
transakci.

### 3.3 Struktura repozitáře

```
api/index.js                  Vstupní bod pro Vercel serverless
app/
  main.js, preload.js         Electron shell (tenký klient)
  server/
    index.js                  Express app, mountování rout, bezpečnostní middleware
    db.js, db-pg.js, db-sqlite.js   Databázové adaptéry
    schema.sql, schema-pg.sql       Schéma (SQLite / PostgreSQL), 36 tabulek, 12 triggerů
    seed.js                   Prvotní naplnění
    routes/                   22 souborů — API endpointy
    lib/                      21 souborů — business logika, výpočty, PDF, integrace
  renderer/                   Frontend (app.js, style.css, index.html, sw.js)
  test/                       19 automatizovaných testů
db/                           Referenční PostgreSQL schéma z fáze 0-1
brief/                        Původní zadání (.docx)
vercel.json                   Rewrites + cron pro pravidelné faktury
.github/workflows/            CI build desktop instalátorů
```

---

## 4. Právní základ

Systém je navržený tak, aby požadavky českého účetního a daňového práva **vynucoval**,
nikoli jen umožňoval. Následující odkazy jsou skutečně přítomné v kódu (schéma databáze,
business logika i uživatelské rozhraní) — nejde o dodatečně sepsaný seznam.

### 4.1 Zákon č. 563/1991 Sb., o účetnictví (ZoÚ)

Uvedeno včetně **novely č. 316/2025 Sb., účinné od 1. 1. 2026**.

| Ustanovení | Co z něj systém plní |
|---|---|
| **§ 11** | Náležitosti účetního dokladu — struktura tabulky `document`, workflow schválení s odpovědnou osobou. Doklady **nelze mazat** (jen stornovat). |
| **§ 18** | Příloha k účetní závěrce — samostatný modul s textovými částmi, automaticky dopočítanými údaji (majetek, pohledávky/závazky po splatnosti) a **verzovanou historií**. |
| **§ 24 odst. 6–7** | Kurz devizového trhu ČNB u cizoměnových dokladů — kurz se „zamrzne" při vzniku dokladu a už se nikdy nepřepisuje; přecenění otevřených pohledávek/závazků k rozvahovému dni. |
| **§ 29–30** | Inventarizace majetku a závazků — inventurní soupis (účetní vs. fyzický stav) a uzávěrka období, po níž systém odmítne další zápis. |
| **§ 33 odst. 8–9** | Audit log — nezměnitelný záznam všech úkonů včetně JSON stavu před/po. |
| **§ 33a** | **Nezměnitelnost účetních záznamů** — nejtvrdší mechanismus systému. Účetní zápisy nelze po vložení změnit ani smazat, a to ani administrátorem. Jediná povolená oprava je **storno** (nový protichůdný zápis s odkazem na původní). |
| **§ 35** | Součást hlavičky triggerové sekce spolu s § 33a. |

### 4.2 Vyhláška č. 500/2002 Sb.

| Ustanovení | Co z něj systém plní |
|---|---|
| **Příloha č. 1** | Struktura rozvahy (zjednodušený rozsah pro mikro účetní jednotku). |
| **Příloha č. 2** | Struktura výkazu zisku a ztráty (druhové členění). |
| **Příloha č. 4** | Směrná účtová osnova — účtový rozvrh systému (86 účtů, viz [sekce 8](#8-účtový-rozvrh)). |
| **§ 39** | Obsah přílohy k účetní závěrce (spolu s § 18 ZoÚ). |

Mapování účtů na řádky výkazů zohledňuje **novelu 2016** — neobsahuje zrušené položky
„Zřizovací výdaje" ani „Mimořádné výnosy/náklady".

> **Právní upozornění zabudované do systému:** mapování účtů na řádky výkazů je v kódu
> označené jako *návrh dle vyhlášky*. Toto upozornění se propisuje i do generovaného PDF:
> „Mapování účtů na řádky výkazu je návrh dle vyhlášky — před oficiálním podáním nechte
> potvrdit účetní firmou."

### 4.3 Zákon č. 235/2004 Sb., o dani z přidané hodnoty (ZDPH)

| Ustanovení | Co z něj systém plní |
|---|---|
| **§ 6** | Sledování obratu za 12 měsíců proti limitu **2 000 000 Kč** pro povinnou registraci; dashboard hlásí, kolik zbývá. |
| **§ 45** | Pravidlo pro opravný daňový doklad (odkaz na původní doklad + důvod opravy) — uvedeno v nápovědě. |
| **§ 100** | Evidence pro účely DPH; systém sám hlídá **limit 10 000 Kč včetně daně**, nad který kontrolní hlášení vyžaduje jednotlivou evidenci — a bez DIČ protistrany takový doklad odmítne zapsat. |

Systém dále generuje **XML pro elektronické podání** podle oficiálních XSD schémat
Finanční správy: přiznání k DPH (`DPHDP3`) a kontrolní hlášení (`DPHKH1`) k nahrání na
portál MOJE daně / EPO. Rozsah je vědomě omezený — viz [sekce 12](#12-známá-omezení-a-mezery).

### 4.4 Zákon č. 586/1992 Sb., o daních z příjmů

**§ 7b** — daňová evidence. Účetní jednotka může být přepnutá do režimu daňové evidence
místo podvojného účetnictví (`accounting_mode`).

### 4.5 Ochrana osobních údajů

Zásady zpracování osobních údajů odkazují na **čl. 6 odst. 1 písm. c) GDPR** (zpracování
nutné pro splnění právní povinnosti) v návaznosti na zákon o účetnictví a zákon o DPH.

### 4.6 Archivační lhůty

Nápověda uvádí: účetní záznamy se uchovávají **5 let**, doklady rozhodné pro DPH
**10 let** od konce příslušného zdaňovacího období.

---

## 5. Pravidla vynucená na úrovni databáze

Toto je jádro průkaznosti systému. Následující pravidla **nejsou** v aplikační logice
(kterou by šlo obejít jiným API voláním nebo chybou v kódu) — jsou to databázové triggery.
Existují ve dvou funkčně identických variantách pro SQLite i PostgreSQL, s **doslova
stejnými chybovými hláškami**.

### 5.1 Nezměnitelnost účetních zápisů (§ 33a)

| Trigger | Kdy | Hláška |
|---|---|---|
| `trg_posting_no_update` | jakýkoli UPDATE na `posting` | *Účetní zápisy jsou append-only (§ 33a zákona o účetnictví). Použijte storno.* |
| `trg_posting_no_delete` | jakýkoli DELETE na `posting` | *(totéž)* |
| `trg_posting_line_no_update` | UPDATE na `posting_line` | *Řádky účetních zápisů jsou append-only (§ 33a zákona o účetnictví).* |
| `trg_posting_line_no_delete` | DELETE na `posting_line` | *(totéž)* |

Tyto čtyři jsou **bezpodmínečné**. Zaúčtovaný zápis nelze změnit ani smazat žádnou cestou.
API vrstva takovou akci ani nenabízí — v kódu je to explicitně zdůvodněné tím, že by ji
databáze stejně odmítla.

**Jediná povolená oprava je storno:** vloží se nový zápis s prohozenými stranami MD/D,
stejnými částkami a odkazem `storno_of_posting_id` na původní zápis. Původní zápis zůstává
navždy v deníku.

### 5.2 Nezměnitelnost audit logu (§ 33 odst. 8–9)

| Trigger | Hláška |
|---|---|
| `trg_audit_log_no_update` | *Audit log je append-only a nelze jej upravit.* |
| `trg_audit_log_no_delete` | *Audit log je append-only a nelze jej smazat.* |

### 5.3 Ochrana dokladů (§ 11, § 33a)

| Trigger | Kdy | Hláška |
|---|---|---|
| `trg_document_no_delete` | jakýkoli DELETE na `document` | *Doklady nelze mazat (§ 11, § 33a ZoÚ) — pouze stornovat.* |
| `trg_document_edit_guard` | UPDATE dokladu ve stavu `zauctovany`/`stornovany`, pokud se stav nemění | *Doklad je již zaúčtovaný nebo stornovaný — nelze upravit. Vytvořte opravný doklad.* |

Přechod `zauctovany → stornovany` trigger záměrně propustí (storno musí být možné).

### 5.4 Uzamčení účetního období (§ 29–30)

| Trigger | Kdy | Hláška |
|---|---|---|
| `trg_document_period_lock` | vložení dokladu do období se stavem `uzavrene` | *Účetní období je uzavřené po inventarizaci — zápis není možný.* |
| `trg_posting_period_lock` | vložení účetního zápisu do uzavřeného období | *(totéž)* |

### 5.5 Měsíční uzávěrka (tvrdý zámek měsíce)

Nad rámec roční uzávěrky lze uzamknout **jednotlivý měsíc** v rámci otevřeného roku.

| Trigger | Kdy | Hláška |
|---|---|---|
| `trg_document_month_lock` | vložení dokladu s datem vyhotovení v uzamčeném měsíci | *Měsíc je uzamčen měsíční uzávěrkou — zápis s tímto datem není možný.* |
| `trg_posting_month_lock` | vložení zápisu s datem v uzamčeném měsíci | *(totéž)* |

Odemčení měsíce **nemaže záznam o zámku** — vyplní se `unlocked_at` a `unlocked_by`, takže
zůstává auditní stopa, kdo a kdy měsíc odemkl. Odemknout smí pouze role `admin`.

### 5.6 Dvojpojistka v aplikační vrstvě

Funkce `assertPeriodOpen()` a `assertMonthOpen()` kontrolují totéž ještě před zápisem.
Jejich účel je **výhradně srozumitelná chybová hláška** — v kódu je výslovně uvedeno, že
skutečnou, neobejitelnou pojistkou jsou databázové triggery.

---

## 6. Funkční moduly

Navigace má 6 skupin a 19 modulů. Na mobilu se horní navigace mění na spodní lištu se 4
hlavními položkami + „Více" (čistě CSS, žádná detekce zařízení).

### Přehled

**Dashboard** — KPI karty (obrat za 12 měsíců proti limitu DPH, doklady v konceptu, doklady
po splatnosti, příjmy a výdaje tento měsíc s procentní změnou proti minulému měsíci),
vlastní SVG graf cashflow za 12 měsíců s tooltipy, panel **„Co udělat dál"** (spočtený
z reálných dat: schválit koncepty, zkontrolovat úhrady po splatnosti, doplnit IBAN, nahrát
logo), tabulka otevřených pohledávek/závazků včetně částečných úhrad a poslední aktivita
z audit logu. Na mobilu navíc velký zůstatek na účtech s přepínačem skrytí.

### Účetnictví

**Doklady** — 6 typů dokladu (faktura vydaná/přijatá, pokladní příjem/výdej, bankovní pohyb,
interní doklad), filtrování podle typu a stavu, workflow **koncept → schválený → zaúčtovaný
→ (stornovaný)**. U dokladu: detail s přepočtem cizí měny kurzem ČNB, **QR platba** (SPD),
**PDF faktury** s firemním brandingem (logo, razítko, podpis), **odeslání e-mailem**,
**platební odkaz přes Stripe**, přílohy (PDF/CSV), tisk.

Novinka nad rámec běžných systémů: **sken faktury s OCR** — PDF se zpracuje na serveru,
obrázek přímo v prohlížeči (Tesseract.js). Rozpozná datum, DUZP, splatnost, variabilní
symbol, částku a DIČ; podle IČO dohledá dodavatele v ARES a upozorní, jestli už je mezi
kontakty. Vybraný soubor se automaticky připojí k vytvořenému dokladu jako příloha.

**Účetní deník** — chronologický needitovatelný seznam všech zápisů, detail s řádky MD/D,
možnost storna, ruční zápis s kontrolou MD = D.

**Hlavní kniha** — systematický přehled po účtech s průběžným zůstatkem, filtr „ke dni",
export do CSV.

**Účtový rozvrh** — 86 přednastavených účtů, možnost přidat vlastní včetně analytických
podúčtů.

**Předkontace** — šablony zaúčtování pro opakující se případy. Určují účty, strany MD/D
a odkud se bere částka (celková / základ DPH / výše DPH). Zaúčtování dokladu je pak jedno
kliknutí.

### Fakturace

**Nabídky** — cenové nabídky se stavy (koncept → odeslaná → přijatá/odmítnutá → převedena),
PDF, odeslání e-mailem a **převod na fakturu**. Nabídky jsou vědomě oddělené od dokladů —
nejsou to účetní záznamy ve smyslu § 33a ZoÚ, takže je lze mazat a neovlivňují výkazy ani DPH.

**Ceník** — číselník položek (cena, jednotka, sazba DPH), který automaticky doplňuje řádky
nabídek i pravidelných faktur.

**Pravidelné faktury** — šablony s intervalem (měsíčně / čtvrtletně / ročně), datem dalšího
generování, koncem a maximálním počtem výskytů. Na webu je generuje **automatický cron
každý den v 6:00**, lze ho spustit i ručně.

### Evidence

**Kontakty** — odběratelé, dodavatelé, umělci, zaměstnanci. **Napojení na ARES**: načtení
firmy podle IČO (název, DIČ, adresa, plátcovství DPH) i fulltextové hledání podle názvu.

**Projekty / zakázky** — analytické členění na úrovni jednotlivého řádku účetního zápisu,
s rozpočtem a průběžným výsledkem (náklady vs. výnosy) barevně.

**Banka a pokladna** — nejbohatší modul:
- Zůstatky po jednotlivých účtech, příjmy a výdaje za 30 dní.
- **Import výpisu** — CSV (autodetekce oddělovače, heuristické rozpoznání sloupců, ruční
  mapování) i **camt.053 XML** (ISO 20022 — KB, ČSOB, Fio, Air Bank, Raiffeisenbank…).
  Opakovaný import **přeskočí duplicity**, u XML podle bankovní reference pohybu.
- **Automatický návrh párování** podle variabilního symbolu a částky.
- **Rozložené platby** — jeden doklad lze uhradit více bankovními pohyby (např. smlouva
  5 900 Kč zaplacená jako 5 000 + 900 Kč). Doklad zůstává v otevřených pohledávkách se
  zbývající částkou, dokud není doplacen.
- **Cizí měna** — při párování se počítá CZK ekvivalent kurzem ČNB k datu úhrady, vzniklý
  **kurzový rozdíl** se zaúčtuje na 563/663 a **kurzová marže banky** (rozdíl mezi reálným
  komerčním kurzem banky a kurzem ČNB) zvlášť na 568/668, protože to není kurzový rozdíl
  ve smyslu zákona.
- **Naučené kategorie** — u pohybu bez dokladu (poplatky, úroky) systém navrhne účet podle
  dříve zaúčtované protistrany nebo klíčového slova; volba se zapamatuje.
- **Automatické zaznamenání platby z e-mailu** — banka posílá upozornění na vygenerovanou
  párovací adresu, systém platbu zapíše a zkusí spárovat s fakturou.

**Majetek** — karty dlouhodobého majetku, pořizovací cena, doba odepisování, zůstatková
hodnota, výpočet a zaúčtování odpisů (551/082).

### Výstupy

**Výkazy** — **rozvaha** (s kontrolou AKTIVA = PASIVA a barevným hlášením rozdílu),
**výsledovka** (s výsledkem hospodaření), obojí s exportem do CSV a s upozorněním, že
mapování účtů má potvrdit účetní firma. Dále **příloha k účetní závěrce (§ 18 ZoÚ)** —
textové části plus automaticky dopočítané údaje (majetek s oprávkami, pohledávky a závazky
po splatnosti), s **verzovanou historií**. A **kompletní závěrka v jednom PDF** (rozvaha +
výsledovka + příloha) pro sbírku listin. Samostatná akce: **přecenění otevřených
cizoměnových pohledávek/závazků k rozvahovému dni** (idempotentní).

**DPH** — sledování obratu proti limitu 2 mil. Kč, přepínač plátcovství, evidence pro účely
DPH (§ 100) s příznakem dokladů nad limit kontrolního hlášení, a **generování XML** pro
přiznání (DPHDP3) i kontrolní hlášení (DPHKH1).

**Inventarizace a uzávěrka** — inventurní soupis k rozvahovému dni (účetní vs. fyzický stav
s rozdílem), **měsíční uzávěrka** (zamknout/odemknout jednotlivé měsíce + PDF měsíčního
snapshotu) a **roční uzávěrka** období.

### Správa

**Audit log** — posledních 300 záznamů (kdy, akce, tabulka, ID, JSON stavu po změně),
export do CSV.

**Nastavení** — údaje účetní jednotky (název, DIČ, kategorie mikro/malá/střední/velká,
účetní režim, IBAN, adresa, kontakty), **branding faktur** (logo, razítko, podpis), údaje
pro elektronické podání DPH (kód FÚ, strukturovaná adresa), **uživatelé a role**,
**pozvánky kolegů/společníků**, generování párovací e-mailové adresy pro banku a (ve webové
verzi) **stažení desktopové aplikace pro Windows/Mac**.

**Nápověda** — vysvětlení podvojného účetnictví, doporučený workflow, jak vytvořit zápis,
předkontace, opravy a storno, DPH, QR platba, import výpisu, výkazy, význam základních
účtů.

### Přihlášení

Čtyři způsoby: **e-mail + heslo**, **nastavení nového hesla**, **registrace firmy**
(včetně brandingu) a **BankID** — ověření jednatele proti seznamu statutárních orgánů
z ARES. BankID má režim `mock` (testovací, vybere jednatele ze seznamu) a `live` (reálné
OIDC). Přístup je **sdílený podle firmy** — kolegové ve stejné firmě vidí stejná data.

---

## 7. Datový model

36 tabulek, identická sada názvů v SQLite i PostgreSQL variantě.

### Identita a přístup
| Tabulka | Účel |
|---|---|
| `accounting_unit` | Účetní jednotka (firma) — korzeň izolace dat. Režim účtování, kategorie, plátcovství DPH, branding, údaje pro e-podání. |
| `app_user` | Uživatelé s rolí v rámci jedné firmy. Heslo (bcrypt), příznak ověření BankID. |
| `company_director` | Jednatelé / statutární orgán — zdroj pravdy pro ověření jména z BankID. |
| `company_invite` | Pozvánky kolegů a společníků do sdíleného přístupu. |

### Rozvrh, období, zámky
| Tabulka | Účel |
|---|---|
| `chart_of_accounts` | Účtový rozvrh včetně analytických podúčtů. |
| `accounting_period` | Účetní období (rok) a jeho roční zámek. |
| `period_month_lock` | Měsíční uzávěrka — zámek jednoho měsíce, s auditní stopou odemčení. |

### Číselníky
| Tabulka | Účel |
|---|---|
| `contact` | Odběratelé, dodavatelé, umělci, zaměstnanci. |
| `project` | Projekty a zakázky pro analytické členění. |
| `price_list_item` | Ceník položek. |

### Doklady
| Tabulka | Účel |
|---|---|
| `document` | Účetní doklad se všemi náležitostmi § 11 ZoÚ, včetně „zamrzlého" kurzu ČNB a DPH polí. |
| `document_line` | Řádky dokladu s návrhem účtu. |
| `document_attachment` | Přílohy (scan, PDF, CSV). |

### Účetní zápisy (append-only jádro)
| Tabulka | Účel |
|---|---|
| `posting` | Hlavička zápisu v deníku; storno přes odkaz `storno_of_posting_id`, nikdy mazáním. |
| `posting_line` | Strany MD/D, částka vždy > 0. |
| `posting_template` | Předkontace. |
| `posting_template_line` | Řádek předkontace včetně zdroje částky. |

### DPH, majetek
| Tabulka | Účel |
|---|---|
| `vat_ledger_entry` | Evidence pro účely DPH (§ 100) s příznakem „nad limit kontrolního hlášení". |
| `fixed_asset` | Dlouhodobý majetek a odpisový plán. |
| `depreciation_entry` | Jednotlivý odpis navázaný na účetní zápis. |

### Banka a platby
| Tabulka | Účel |
|---|---|
| `bank_statement_line` | Řádek výpisu / pohyb; párování na doklad nebo přímé zaúčtování. Idempotence přes bankovní referenci. |
| `bank_inbound_mailbox` | Mapování párovacího e-mailového tokenu na firmu a bankovní účet. |
| `invoice_payment` | Platba faktury přes Stripe. Vědomě samostatná tabulka, protože `document` má silné triggery. |
| `bank_category_rule` | Naučená pravidla kategorizace (protistrana → účet). |

### Uzávěrka a výkazy
| Tabulka | Účel |
|---|---|
| `inventory_check` | Inventurní soupis k rozvahovému dni. |
| `inventory_check_line` | Účetní vs. fyzický stav a rozdíl. |
| `financial_statement_note` | Příloha k závěrce — aktuální stav. |
| `financial_statement_note_version` | Append-only historie verzí přílohy. |

### Číselné řady, audit, kurzy
| Tabulka | Účel |
|---|---|
| `document_number_sequence` | Čítač dokladů per firma / typ / rok. |
| `posting_number_sequence` | Čítač účetních zápisů per firma. |
| `audit_log` | Nezměnitelný záznam všech úkonů s JSON stavem před/po. |
| `exchange_rate` | Cache kurzů ČNB — **vědomě globální** (veřejná referenční data, sdílená mezi firmami). |

### Fakturace (mimo účetní záznamy)
| Tabulka | Účel |
|---|---|
| `offer`, `offer_line` | Nabídky — **nejsou** účetní záznamy (§ 33a), lze mazat, netečou do výkazů ani DPH. |
| `recurring_invoice`, `recurring_invoice_line` | Šablony pravidelných faktur. |

---

## 8. Účtový rozvrh

**86 účtů** podle směrné účtové osnovy (příloha č. 4 vyhl. 500/2002 Sb.), zúžených na účty
reálně potřebné pro malou s.r.o. v oblasti produkce a marketingu.

Rozložení podle účtové třídy: **0** – 6 účtů, **1** – 2, **2** – 4, **3** – 22, **4** – 11,
**5** – 30, **6** – 8, **7** – 3.
Podle typu: rozvahové aktivní 19, rozvahové pasivní 26, výsledkové nákladové 30, výsledkové
výnosové 8, závěrkové 3.

Příklady:

| Účet | Název |
|---|---|
| 013 | Software |
| 022 | Samostatné movité věci (dlouhodobý majetek) |
| 082 | Oprávky k samostatným movitým věcem |
| 211 | Pokladna |
| 221 | Bankovní účet |
| 311 | Odběratelé |
| 321 | Dodavatelé |
| 325 | Ostatní závazky (honoráře bez faktury) |
| 343 | DPH (aktivuje se s registrací) |
| 411 | Základní kapitál |
| 428 | Nerozdělený zisk minulých let |
| 501 | Spotřeba materiálu |
| 518 | Ostatní služby (pronájmy, technika, právní/účetní služby) |
| 531 | Daně a poplatky (OSA, správní poplatky) |
| 551 | Odpisy dlouhodobého majetku |
| 563 / 663 | Kursové ztráty / zisky |
| 568 / 668 | Ostatní finanční náklady / výnosy (zde: kurzová marže banky) |
| 602 | Tržby z prodeje služeb (vstupenky, sponzoring) |
| 701 / 702 / 710 | Počáteční / konečný účet rozvažný, Účet zisků a ztrát |

Rozvrh podporuje **analytické podúčty** (např. `518100` a `518200` jako analytika k účtu 518
pro jednotlivé akce).

**Idempotentní doplňování:** funkce `ensureChartOfAccounts()` běží při každém startu serveru
a dosype chybějící účty všem existujícím firmám. Nové účty se tak dostanou i do starších
instalací bez migrace nebo resetu databáze.

---

## 9. Bezpečnost a izolace dat

### 9.1 Izolace firem (multi-tenancy)

Izolace se vynucuje ve třech vrstvách:

**Vrstva 1 — podepsaný token.** `accounting_unit_id` je součástí kryptograficky podepsaného
JWT payloadu. Klient jej nemůže ovlivnit.

**Vrstva 2 — globální přepisovací middleware.** Nejdůležitější bod. Před všemi business
routami běží:

```js
app.use("/api", requireAuth);
app.use("/api", (req, res, next) => {
  req.query.unit = req.user.accountingUnitId;
  if (req.body && typeof req.body === "object") req.body.accounting_unit_id = req.user.accountingUnitId;
  next();
});
```

Jakákoli hodnota poslaná klientem je **vždy přepsána** firmou z přihlášené session.

**Vrstva 3 — WHERE klauzule.** Každý dotaz filtruje podle `accounting_unit_id` ze session.
Podřízené tabulky bez vlastního sloupce (řádky dokladů, řádky zápisů, DPH evidence…) se
scopují joinem na rodiče.

Unikátnost je **per firma**, nikoli globální — číslo dokladu, číslo zápisu, kód projektu
i účet v rozvrhu jsou unikátní vždy v rámci jedné firmy.

### 9.2 Bezpečnostní audit (červenec 2026)

Proveden interní audit na zranitelnosti typu **IDOR** (Insecure Direct Object Reference).
Nalezeno a opraveno **16+ míst**, kde routa s parametrem `/:id` dohledávala záznam jen podle
primárního klíče bez kontroly, že patří přihlášené firmě — cizí firma tak mohla dřív načíst
například fakturu podle uhodnutého ID. Všechny opravy jsou pokryté regresními testy.

### 9.3 Model rolí

Rozhodnuto 21. 7. 2026 (varianta „střední"). Do té doby role prakticky nic neomezovaly —
kontrolovaly se jen na dvou místech, takže i `ctenar` mohl uzavřít účetní období nebo změnit
nastavení firmy.

| Úkon | admin | ucetni | schvalovatel | zadavatel | ctenar |
|---|---|---|---|---|---|
| Čtení všeho (doklady, výkazy, audit log, exporty) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Doklady, zaúčtování, storno | ✓ | ✓ | ✓ | ✓ | — |
| Banka (import, párování, zaúčtování pohybů) | ✓ | ✓ | ✓ | ✓ | — |
| Číselníky (kontakty, projekty, ceník, nabídky) | ✓ | ✓ | ✓ | ✓ | — |
| Účtový rozvrh — přidání účtu | ✓ | ✓ | — | — | — |
| Otevření a **roční uzávěrka** období | ✓ | ✓ | — | — | — |
| **Měsíční uzávěrka** — uzamčení | ✓ | ✓ | — | — | — |
| Měsíční uzávěrka — **odemčení** | ✓ | — | — | — | — |
| Nastavení účetní jednotky (včetně plátcovství DPH) | ✓ | ✓ | — | — | — |
| Přidání uživatele, pozvání kolegy | ✓ | — | — | — | — |

Vynucení je dvoustupňové:
- **`ctenar`** je odříznutý centrálním guardem (`blockReadOnlyRoles` v `lib/auth.js`) — cokoli
  jiného než `GET` vrátí 403. Záměrně globálně, aby nestačilo zapomenout kontrolu na nové routě.
- **Administrativní úkony** hlídá `requireRole(...)` per routa.

> **Poznámka k této firmě:** oba společníci mají roli `schvalovatel`. Zvládnou tedy veškerou
> běžnou účetní práci (doklady, zaúčtování, storno, banka), ale **neuzavřou období, nezmění
> nastavení firmy ani nepřidají uživatele**. Pokud to mají mít, je potřeba jim změnit roli
> na `ucetni` (resp. `admin`).

### 9.3.1 Opravené nálezy z revize dokumentace (21. 7. 2026)

Při zpracování této dokumentace byl proveden nový průchod kódem. Nálezy byly **ověřeny ve
zdrojovém kódu i proti produkčnímu nasazení** — nešlo o teoretické domněnky.

**A) `POST /api/postings/:id/storno` neměl kontrolu vlastnictví firmou. — OPRAVENO**
Endpoint volal `stornoPosting(req.params.id, …)` a ta dohledávala zápis dotazem
`SELECT * FROM posting WHERE id = ?` — **bez** `accounting_unit_id`. Globální přepisovací
middleware tu nepomůže, protože ID je v cestě URL, ne v query ani body.

*Důsledek (před opravou):* přihlášený uživatel jedné firmy mohl vytvořit stornovací zápis
v účetnictví jiné firmy jen uhádnutím číselného ID. Registrace firmy je přitom **veřejná
self-service**. V produkci byla zatím jen jedna firma, takže nebylo co zneužít — vážné by to
bylo od registrace druhé firmy.

*Oprava:* `stornoPosting()` má nově **povinný** parametr `unitId` a dohledání jím scopuje.
Chybí-li, funkce hlasitě spadne (tichý neomezený dotaz by byl horší). Pokryto regresním testem.

**B) `GET /api/users` vracel i `password_hash`. — OPRAVENO**
Dotaz byl `SELECT *`, takže odpověď obsahovala bcrypt hash hesla všech kolegů. Nešlo
o cross-tenant únik (jen vlastní firma), ale do API odpovědi to nepatří.
*Oprava:* výslovný výčet sloupců. Pokryto regresním testem.

**C) Role neomezovaly prakticky nic. — OPRAVENO**
Viz [model rolí](#93-model-rolí) výše.

#### Zbývající — ponecháno vědomě

**D) Fail-open výchozí hodnota u BankID.**
`BANKID_MODE` má v kódu default `"mock"`. V mock režimu endpoint `bankid/start` veřejně
vrátí jména jednatelů podle IČO a `bankid/callback` pak vydá **admin session** komukoli, kdo
zná IČO (veřejná informace) a jméno jednatele.

*Ověřeno na produkci:* nasazení běží v režimu **`live`**, takže tato cesta je **uzavřená**.
Riziko je v tom, že se to spoléhá na správně nastavenou proměnnou prostředí — kdyby se při
budoucím nasazení `BANKID_MODE` ztratilo, systém se tiše otevře. Bezpečnější default by byl
`live` (nebo tvrdé odmítnutí bez explicitní konfigurace).

*Vedlejší zjištění:* produkce používá **sandbox** issuer `oidc.sandbox.bankid.cz`, tedy
testovací prostředí BankID — reálné přihlášení přes BankID zatím nefunguje pro skutečné
uživatele.

**E) `POST /api/auth/set-password` je bez autentizace.**
Kdokoli, kdo zná e-mail uživatele, který ještě nemá nastavené heslo, si může nastavit vlastní
a získat plnou session.

*Ověřeno na produkci:* všichni tři existující uživatelé heslo mají, takže je to teď
uzavřené (endpoint vrací 409). Ale endpoint `POST /api/users` (v Nastavení tlačítko
„Přidat") zakládá uživatele **bez hesla** — v ten okamžik se jeho e-mail stane volně
zabíratelným. Pro přidávání kolegů je proto výrazně bezpečnější používat **pozvánky**
(token v odkazu), ne „Přidat uživatele".

#### Zámky období — nekonzistentní pokrytí

Kontrola uzavřeného období/měsíce v aplikační vrstvě běží jen u čtyř operací (vytvoření
dokladu, zaúčtování dokladu, ruční zápis, odpis majetku). **Bez ní**, ale s účetními dopady,
jsou: párování banky (generuje kurzové zápisy), rychlé zaúčtování pohybu, oba storno
endpointy, přecenění kurzů a generování inventurního soupisu.

V praxi to zachytí databázové triggery, ale ty reagují jen na **vložení** nového záznamu
(`BEFORE INSERT`), nikoli na úpravu — a nehlídají řádky (`posting_line`, `document_line`),
jen hlavičky.

### 9.4 Veřejné a jinak chráněné endpointy

Několik cest vědomě obchází uživatelskou session, protože nemají uživatele — mají vlastní
autentizaci:

| Cesta | Ochrana |
|---|---|
| `/api/auth/*` | přihlašování samo (před vznikem session) |
| `/api/stripe/webhook` | verifikace podpisu Stripe (raw body) |
| `/pay/:token` | veřejná platební stránka, identifikace přes jednorázový token |
| `/api/inbound/bank-email` | HTTP Basic Auth proti `POSTMARK_INBOUND_TOKEN`; firma se určí z párovacího tokenu v adrese |
| `/api/cron/*` | `Bearer` proti `CRON_SECRET` |

Ve všech případech platí zásada: **bez nastavené proměnné prostředí se požadavek vždy
odmítne** — nikdy se tiše nepovolí průchod.

---

## 10. Provoz a nasazení

### 10.1 Proměnné prostředí (webová verze)

| Proměnná | K čemu |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Bez ní systém spadne na SQLite. |
| `JWT_SECRET` | Podepisování přihlašovacích tokenů. |
| `BANKID_MODE` | `mock` (výchozí) nebo `live`. |
| `BANKID_CLIENT_ID`, `BANKID_CLIENT_SECRET`, `BANKID_REDIRECT_URI`, `BANKID_ISSUER` | Reálné BankID OIDC. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Odesílání faktur e-mailem. |
| `POSTMARK_INBOUND_TOKEN` | Heslo webhooku pro příjem bankovních notifikací. |
| `POSTMARK_INBOUND_DOMAIN` | Vlastní subdoména s MX na Postmark → adresa **bez `+`** (nutné, protože některé banky `+` v e-mailu odmítají — ověřeno u Raiffeisenbank). Doporučeno. |
| `POSTMARK_INBOUND_ADDRESS` | Alternativa: výchozí Postmark adresa (obsahuje `+`). |
| `GITHUB_RELEASES_TOKEN` | Read-only token pro stahování desktop instalátoru z privátního repa. |
| `CRON_SECRET` | Ochrana cron endpointu. |

### 10.2 Nasazení webu

Vercel. `vercel.json` řeší rewrites (`/api/*` → serverless funkce, `/` a `/login` →
`index.html`, statické soubory, `/pay/*`) a **cron** `/api/cron/recurring` denně v 6:00
pro generování pravidelných faktur. Žádný bundler, žádný build krok.

### 10.3 Desktopové instalátory

| Platforma | Formát | Architektury | Podpis |
|---|---|---|---|
| Windows | NSIS `.exe` | x64 | nepodepsáno |
| macOS | `.dmg` + `.zip` | x64 + arm64 | **nepodepsáno, nenotarizováno** |

Build běží v GitHub Actions (`.github/workflows/build-desktop.yml`) po pushnutí tagu `v*` —
Windows a macOS paralelně na dvou runnerech, protože macOS build nelze spolehlivě vytvořit
z Windows. Instalátory se nahrají jako assety GitHub Release.

Uživatel je stahuje z aplikace (Nastavení → Desktopová appka), server je proxuje z privátního
repozitáře přes read-only token — přímý odkaz by bez autentizace nefungoval.

> **macOS:** protože appka není podepsaná Apple certifikátem, Gatekeeper při prvním spuštění
> zobrazí varování „neznámý vývojář". Uživatel ji musí otevřít přes pravé tlačítko → Otevřít.

### 10.4 Aktualizace

Dvouúrovňové:

- **Obsah aplikace** (platí pro web i desktop) — `GET /api/version` vrací identifikátor
  nasazení. Aplikace ho kontroluje každých 5 minut a při aktivaci okna; při změně nabídne
  banner „Restart to update", který odregistruje service worker, smaže cache a znovu načte.
- **Nativní shell** (jen desktop) — `electron-updater` nad GitHub Releases. Aktualizace se
  stáhne na pozadí, uživatel dostane banner a restartem se nainstaluje.

### 10.5 Offline režim

Service worker: API požadavky **network-first** (úspěšná odpověď se uloží, při výpadku se
vrátí poslední známá), shell **cache-first**. Zápisové požadavky (POST/PUT/PATCH/DELETE)
se **vůbec nezachytávají** — offline zápis prostě selže. Je to vědomé rozhodnutí: žádná
offline fronta, žádná synchronizace, jediný zdroj pravdy je server. Uživatel vidí banner
„Offline — zobrazena poslední stažená data, ukládání není možné."

### 10.6 Lokální vývoj

```bash
cd app
npm install
npm start            # Electron desktop shell
npm run dev:server   # jen API na http://localhost:4000
npm run dev:renderer # jen UI na http://localhost:5173 (proti dev:server)
npm test             # testy
npm run dist         # Windows instalátor
npm run dist:mac     # macOS instalátory
```

---

## 11. Testování

**19 automatizovaných testů**, spouštěné vestavěným runnerem Node (`node:test`) — žádná
další závislost. Každý test běží proti skutečnému serveru s vlastní izolovanou databází
v temp adresáři.

### `accounting-invariants.test.js` — účetní invarianty

- **Podvojnost (MD = D)** — nevyrovnaný zápis je odmítnut, vyrovnaný projde.
- **Uzavřené období** — zápis do uzavřeného období je odmítnut.
- **Append-only** — přímý `DELETE` i `UPDATE` na `posting`, `posting_line` a `audit_log`
  je databází odmítnut (testováno na úrovni DB, ne API).
- **Správnost storna** — protizápis má prohozené strany MD/D, stejné součty a správný odkaz
  na původní zápis.
- **Číselné řady** — čísla dokladů jsou sekvenční per typ a rok a **nezávislé mezi firmami**
  (firma B začíná znovu od 0001).

### `security-idor.test.js` — izolace firem

Sedm testů se dvěma samostatnými firmami: firma B nesmí načíst doklad ani kontakt firmy A,
nesmí je stornovat, schválit, uzavřít cizí účetní období ani stáhnout cizí PDF. Poslední
test ověřuje, že firma A ke svým vlastním datům pořád normálně přistupuje (ochrana proti
regresi typu „zamkli jsme to všem").

---

## 12. Známá omezení a mezery

Tato sekce je záměrně explicitní — je určená k rozboru účetní firmou nebo auditorem.

### 12.1 Co systém neumí vůbec

- **Mzdy** — nulová podpora. Žádný výpočet mzdy, odvodů ani mzdové listy. Účty 331/336
  v rozvrhu existují, ale žádný modul za nimi není. Relevantní, pokud firma má zaměstnance
  nebo vyplácí odměnu jednateli přes mzdu.
- **Elektronické podání daně z příjmů (DPPO)** — zcela mimo rozsah.
- **Skladová evidence** — modul „Inventarizace" je periodická fyzická kontrola, nikoli
  průběžná evidence pohybu zásob s oceňováním. Relevantní jen při prodeji fyzického zboží.

### 12.2 Co je pokryté jen částečně

- **Elektronické podání DPH** — XML se generuje podle oficiálních XSD Finanční správy, ale
  pokrývá **jen běžná tuzemská plnění se standardní (21 %) a první sníženou (12 %) sazbou**.
  Přenesená daňová povinnost, intrakomunitární plnění, dovoz a opravy zůstávají v XML
  nevyplněné. Aplikace na to výslovně upozorňuje a doporučuje kontrolu před podáním.
- **Mapování účtů na řádky výkazů** je návrh dle vyhlášky, nikoli ověřený výklad — má ho
  potvrdit účetní firma (upozornění je i v generovaném PDF).
- **Zůstatek bankovního účtu** se počítá jako součet naimportovaných pohybů. Systém nemá
  koncept „počátečního zůstatku" — pokud import nezačíná od založení účtu, je nutné rozdíl
  doplnit vyrovnávacím pohybem.

### 12.3 Technická omezení

- **Triggery pro uzamčení období a měsíce reagují jen na vložení nového záznamu**
  (`BEFORE INSERT`), nikoli na úpravu. Doklad ve stavu koncept v uzavřeném období by tedy
  databázový trigger při úpravě nezastavil (aplikační vrstva to ale kontroluje).
- **Trigger `trg_document_edit_guard` nechrání stav `schvaleny`** — omezení pro schválený
  doklad je pouze v aplikační logice, ne v databázi.
- **Přílohy dokladů nejsou ve webové verzi trvale perzistentní** — ukládají se na dočasný
  disk serverless funkce. Řešením by bylo objektové úložiště (např. Vercel Blob).
- **Nápověda obsahuje zastaralou informaci** — tvrdí, že data se ukládají lokálně do
  souboru SQLite a nikam se neodesílají. To platilo před přechodem na tenkého klienta;
  dnes je zdrojem pravdy web a Postgres.

### 12.4 Bezpečnostní nálezy — stav

Podrobně v [sekci 9.3.1](#931-opravené-nálezy-z-revize-dokumentace-21-7-2026).

| Nález | Stav |
|---|---|
| Storno účetního zápisu bez kontroly vlastnictví firmou | **opraveno** (21. 7. 2026) + regresní test |
| `GET /api/users` vracel hash hesel | **opraveno** (21. 7. 2026) + regresní test |
| Role neomezovaly prakticky nic | **opraveno** (21. 7. 2026) — viz model rolí |
| Fail-open default u BankID (`mock`) | otevřeno; v produkci uzavřeno konfigurací (`live`) |
| `set-password` bez autentizace | dnes uzavřeno (všichni mají heslo), ale „Přidat uživatele" ho znovu otevře — **používejte pozvánky** |
| BankID běží proti **sandbox** prostředí | čeká na produkční smlouvu s BankID |

### 12.5 Provozní rizika

- **Žádné automatické zálohování** mimo zálohování na straně poskytovatele databáze.
  Export dat je jen ruční akce (CSV).
- **Žádné monitorování chyb** (error tracking) na produkčním webu.
- **Žádné externí penetrační testování** — proveden pouze interní bezpečnostní audit.
- **Žádná podpora ani záruka třetí strany** — na rozdíl od komerčních systémů neexistuje
  dodavatel, který by ručil za aktualizace při změně legislativy. Odpovědnost za soulad
  se zákonem zůstává na účetní jednotce.
- **Nulová provozní historie u jiných firem** — systém běží u jedné firmy. Komerční systémy
  (Pohoda, Money S3) mají roky provozu u tisíců firem, kde se vychytaly okrajové případy.

---

## Příloha A — Přehled API

REST API, autentizace hlavičkou `Authorization: Bearer <JWT>` (platnost 30 dní).
Vše pod `/api` je chráněné, s výjimkou endpointů uvedených v [sekci 9.4](#94-veřejné-a-jinak-chráněné-endpointy).

### Autentizace — `/api/auth` (mimo přihlášení)
| Endpoint | Co dělá |
|---|---|
| `POST /register-company` | Založí firmu + prvního uživatele (admin) + celý účtový rozvrh. Vrací JWT. |
| `POST /login` | E-mail + heslo → JWT. |
| `POST /set-password` | Nastaví heslo uživateli, který zatím žádné nemá. |
| `POST /logout` | Bez efektu na serveru (Bearer token nelze revokovat). |
| `GET /me` | Profil přihlášeného uživatele + údaje firmy. |
| `POST /invite` | Vytvoří pozvánku kolegy. **Jen role admin.** |
| `POST /accept-invite` | Podle tokenu založí uživatele s rolí z pozvánky. |
| `POST /bankid/start`, `/bankid/callback`, `/bankid/token-verify` | BankID ověření jednatele. |

### Doklady — `/api/documents`
| Endpoint | Co dělá |
|---|---|
| `GET /` | Seznam, filtry podle stavu a typu. |
| `GET /:id` | Doklad + řádky. |
| `POST /` | Vytvoří doklad (kontrola zámku období i měsíce, číselná řada, kurz ČNB). |
| `PUT /:id` | Editace — **jen ve stavu koncept**. |
| `POST /:id/approve` | Schválení. |
| `POST /:id/post` | Zaúčtování podle předkontace (kontrola MD = D). |
| `POST /:id/storno` | Storno dokladu i všech jeho zápisů. |
| `GET /:id/qr` | QR platba (SPAYD + SVG). |
| `GET /:id/pdf` | PDF faktury. |
| `POST /:id/send-email` | Odeslání faktury e-mailem. |
| `POST /:id/payment-link` | Trvalý platební odkaz (Stripe). |
| `POST /:id/attachments`, `GET /:id/attachments`, `GET /attachments/:id/download` | Přílohy (PDF/CSV/XLS/PNG/JPEG, max 15 MB). |
| `POST /scan` | Rozpoznání polí z naskenované faktury. |

### Účetní zápisy — `/api/postings`
`GET /` · `GET /:id` · `POST /` (kontrola MD = D, zámky) · `POST /:id/storno`
Update ani delete **záměrně neexistují** (§ 33a ZoÚ).

### Banka — `/api/bank`
| Endpoint | Co dělá |
|---|---|
| `GET /` | Řádky výpisu. |
| `POST /import` | Import řádků s deduplikací; vrací `{inserted, skipped}`. |
| `PATCH /:id`, `DELETE /:id` | Oprava / smazání — jen nespárovaného řádku. |
| `POST /:id/match` | Párování s dokladem; rozložené platby, kurzový rozdíl a marže banky. |
| `GET /suggest-matches` | Návrh párování podle VS a částky. |
| `GET /suggest-categories` | Návrh účtu z naučených pravidel. |
| `POST /:id/quick-post` | Zaúčtování pohybu bez dokladu + zapamatování volby. |
| `GET /cashflow` | Zůstatky po účtech, příjmy/výdaje 30/90 dní, 12 měsíců. |
| `GET`/`POST /inbound-mailbox` | Párovací e-mailová adresa pro banku. |

### Výkazy — `/api/reports`
`GET /hlavni-kniha` · `/rozvaha` · `/vysledovka` · `/obrat-dph` · `/pohledavky-zavazky`
`GET`/`PUT /priloha` + `GET /priloha/versions` (verzovaná příloha § 18 ZoÚ)
`GET /zaverka.pdf` · `GET /mesicni-uzaverka.pdf` · `POST /precenit-kurzove`

### DPH — `/api/vat`
`GET`/`POST /ledger` · `GET /priznani` · `GET /kontrolni-hlaseni`
`GET /priznani/xml` (DPHDP3) · `GET /kontrolni-hlaseni/xml` (DPHKH1)

### Ostatní
| Prefix | Endpointy |
|---|---|
| `/api` (misc) | `accounts`, `periods` (+ `:id/close`, `:id/lock-month`, `:id/unlock-month`, `:id/month-locks`), `units`, `users` |
| `/api/contacts` | CRUD; mazání blokované, pokud je kontakt na dokladu |
| `/api/projects` | CRUD; mazání blokované při napojených dokladech (409) |
| `/api/assets` | `GET /`, `POST /`, `POST /:id/depreciate` |
| `/api/inventory` | `GET /`, `POST /generate`, `GET /:id`, `PUT /:id/lines/:lineId` |
| `/api/templates` | Předkontace — `GET`, `POST`, `DELETE` (soft delete) |
| `/api/price-list` | CRUD ceníku |
| `/api/offers` | CRUD + `PATCH /:id/status`, `GET /:id/pdf`, `POST /:id/send-email`, `POST /:id/convert` |
| `/api/recurring` | CRUD + `POST /:id/run-now` |
| `/api/audit-log` | `GET /` (filtry, limit) |
| `/api/ares` | `GET /:ico`, `GET /search/:query` — read-only proxy na ARES |
| `/api/export` | CSV: `doklady`, `hlavni-kniha`, `ucetni-denik`, `rozvaha`, `vysledovka`, `audit-log` |
| `/api/download` | `GET /desktop?platform=win\|mac`, `GET /desktop/info` |

### Veřejné / jinak chráněné
| Endpoint | Ochrana |
|---|---|
| `GET /api/cron/recurring` | `Bearer CRON_SECRET` |
| `POST /api/inbound/bank-email` | Basic Auth vs `POSTMARK_INBOUND_TOKEN` |
| `POST /api/stripe/webhook` | Podpis Stripe (raw body, před `express.json()`) |
| `GET /pay/:token` | Neuhádnutelný platební token |
| `GET /api/version`, `GET /health` | Bez ochrany (jen identifikátor nasazení / stav) |

---

## Příloha B — Klíčové moduly business logiky

| Modul | Odpovědnost |
|---|---|
| `lib/core.js` | Číselné řady (nepřerušené), audit log, kontrola zámků, **storno** |
| `lib/reports.js` | Rozvaha, výsledovka, hlavní kniha, obrat DPH, kniha pohledávek/závazků |
| `lib/statementMapping.js` | Mapa účtů na řádky výkazů (vyhl. 500/2002) + právní upozornění |
| `lib/chartOfAccountsSeed.js` | Účtová osnova + idempotentní doplňování |
| `lib/cnbExchangeRate.js` | Kurz ČNB s cache (§ 24 odst. 6–7 ZoÚ) |
| `lib/fxRevaluation.js` | Přecenění cizoměnových pohledávek/závazků k rozvahovému dni |
| `lib/eDaneXml.js` | XML pro EPO / MOJE daně (DPHDP3, DPHKH1) |
| `lib/invoicePdf.js`, `lib/statementPdf.js` | PDF faktur, nabídek, závěrky, měsíční uzávěrky |
| `lib/qrplatba.js` | QR platba ve standardu SPD 1.0 (ČBA) |
| `lib/invoiceScan.js` | Extrakce textu a polí z naskenované faktury |
| `lib/bankMovements.js` | **Jediné místo vkládající bankovní pohyby** + automatické párování |
| `lib/bankEmailParser.js` | Parser notifikačních e-mailů českých bank |
| `lib/recurring.js` | Generování pravidelných faktur včetně dohnání zmeškaných |
| `lib/mailer.js` | Odesílání e-mailů (SMTP) |
| `lib/auth.js` | Hesla (bcrypt), JWT session, `requireAuth` |
| `lib/bankidOidc.js` | OIDC klient pro BankID |
| `lib/companySetup.js` | Startup doplnění jednatelů a opravy dat firmy |

---

*Dokumentace odpovídá stavu kódu k 21. 7. 2026 (commit `d9ffb5f`), ověřeno i proti běžícímu
produkčnímu nasazení.*
