# FIX_REPORT — uzavření mezer z DOKUMENTACE.md sekcí 9 a 12

Datum: 25. 7. 2026
Rozsah: TŘÍDA A (dokončeno a nasazeno) + FÁZE B (hotová, vědomě nenasazená)
Testy: **60 zelených** (`cd app && npm test`), z toho 49 před fází B a 11 nových
Ověřeno na SQLite i PostgreSQL (fáze B ověřena i proti reálné PG instanci)

---

## Souhrn

| Co | Stav | Commit |
|---|---|---|
| A1 — perzistence příloh do objektového úložiště | ✅ hotovo, na `main` | `bfd3035` |
| A2 — automatické zálohování (cron + restore) | ✅ hotovo, na `main` | `49910bc` |
| A3 — zpřísnění zámků období a měsíce | ✅ hotovo, na `main` | `da88519` |
| A4 + A5 — `set-password` a BankID fail-closed | ✅ hotovo, na `main` | `67b3e32` |
| B — mechanismus přeshraniční DPH | ⏸ hotovo, **nenasazeno** | `1f4baf3` na `feature/preshranicni-dph` |
| Dokumentace + tento report | ✅ | tento commit |

---

## TŘÍDA A — co se opravilo

### A1 — Přílohy dokladů (`lib/attachmentStore.js`)

**Problém:** na Vercelu byl `getUserDataDir()` = `os.tmpdir()`. Přílohy tedy
zmizely s instancí serverless funkce — účetní doklady bez příloh.

**Řešení:** jednotné rozhraní `save()` / `load()` se dvěma backendy. S
`BLOB_READ_WRITE_TOKEN` se ukládá do Vercel Blob (`attachments/<unit>/<doc>/…`),
bez tokenu na lokální disk — desktop a lokální vývoj fungují bez konfigurace.
Upload používá `multer.memoryStorage()`, download streamuje s kontrolou
příslušnosti k účetní jednotce.

**Vědomé rozhodnutí:** `file_path` se recykluje jako klíč úložiště (absolutní
cesta pro disk, `pathname` pro Blob) — SQLite neumí zrušit `NOT NULL` bez
přestavby tabulky, a přestavba tabulky s append-only triggery je větší riziko
než reinterpretace jednoho sloupce (popsáno v komentáři u kódu). **Přílohy se
nemažou z DB** — jsou součástí průkaznosti účetnictví.

**Testy (3):** příloha je stažitelná po „restartu" (jiný temp adresář), firma B
nestáhne přílohu firmy A, lokální režim funguje bez tokenu.

### A2 — Zálohování (`lib/backup.js`, `routes/cron.js`, `scripts/restore-backup.js`)

**Problém:** žádná vlastní záloha. Jediná pojistka byla na straně poskytovatele
databáze — a nebyla zapnutá.

**Řešení, dvě vrstvy:**

1. **Aplikační** — `GET /api/cron/backup` (autorizace `Bearer CRON_SECRET`,
   403 bez něj) serializuje **všechny** tabulky do archivu v objektovém
   úložišti pod `backups/`, retence `BACKUP_RETENTION_DAYS` (výchozí 90 dní).
   Zapsáno do `vercel.json` crons. Obnova: `scripts/restore-backup.js`
   (`--dry-run` / `--force`), který respektuje pořadí FK, na dobu obnovy v jedné
   transakci vypne append-only triggery, srovná sekvence a po obnovení zapíše
   `RESTORE` do `audit_log`.
2. **Infrastrukturní** — PITR / branching u Neonu. **Toto je potřeba zapnout
   ručně v konzoli poskytovatele**, kód s tím nemůže pomoct. Postup je
   v DOKUMENTACE.md 10.6.

**Vědomá rozhodnutí:**
- **Žádný `pg_dump`.** V serverless běhu není binárka; serializace přes
  `store.listTables()` je jediná cesta, která tam skutečně funguje.
- Seznam tabulek se **čte z katalogu**, nezadrátovává se — nová tabulka
  v záloze tiše nechybí.
- `createBackup()` bez nakonfigurovaného úložiště vrací **503, ne ticho**.
  Záloha, o které se člověk domnívá, že běží, je horší než žádná.
- Skript pro obnovu neobchází § 33a ZoÚ: to pravidlo chrání **běžící** systém
  před změnou historie, ne obnovu havarované databáze z vlastní zálohy.
  Vysvětleno v hlavičce skriptu.

**Testy (6):** 403 bez tajemství, archiv obsahuje všechny tabulky a všechny
firmy, retence maže podle `uploadedAt` (ne podle jména souboru), 503 bez
úložiště.

### A3 — Zámky období a měsíce

**Problém:** kontrola uzavřenosti byla jen u 4 operací. Operace s **nepřímým**
účetním dopadem ji obcházely: párování platby (generuje kurzový zápis), rychlé
zaúčtování bankovního pohybu, obě storno cesty, přecenění kurzů, inventurní
soupis, editace konceptu.

**Řešení:** `assertPeriodOpen()` + `assertMonthOpen()` doplněné ke všem těmto
operacím. `stornoPosting()` má nově `unitId` jako **povinný** parametr (bez něj
vyhodí chybu) — dřív šlo stornovat cizí zápis. `trg_document_edit_guard`
rozšířen na `schvaleny` v obou variantách schématu s doslova stejnou hláškou.
Storno v uzavřeném období je **zakázané** — oprava se dělá opravným dokladem
v otevřeném období.

**Vědomé rozhodnutí:** `BEFORE UPDATE` guard na `posting_line` / `document_line`
se **nepřidal**. U `posting_line` už jakýkoli UPDATE blokuje append-only
trigger, takže by šlo o duplicitu. U `document_line` je editace řádků konceptu
implementovaná jako `DELETE` + `INSERT` celé sady, takže by guard musel povolit
mazání a zakázat úpravu — v součtu by nechránil nic. Datum, na kterém zámek
závisí, navíc leží na hlavičce, ne na řádku, takže kontrola v aplikaci u
`PUT /api/documents/:id` (kontroluje **původní i nové** datum, aby doklad nešel
z uzamčeného měsíce „vyvést" přepsáním data) je přesnější než trigger nad
řádkem, který datum nezná. Zapsáno i v DOKUMENTACE.md 12.3.

**Nález během práce:** test „storno dokladu v uzavřeném období" odhalil, že
nezaúčtovaný koncept se do `stornoPosting()` nikdy nedostane — kontrola musela
přijít i do storno endpointu dokladů, ne jen do `lib/core.js`.

**Testy (11):** každá z uvedených operací zvlášť + regrese, že schválený doklad
jde dál normálně zaúčtovat i stornovat.

### A4 — Zabrání účtu přes `set-password`

**Problém:** `POST /api/auth/set-password` byl veřejný. Stačilo znát e-mail
uživatele bez hesla a útočník získal plnou session. `POST /api/users` navíc
zakládal uživatele **bez hesla** — dvojice těch dvou byla použitelná jako
přihlašovací obchvat.

**Řešení:** `set-password` vyžaduje platnou jednorázovou pozvánku **na stejný
e-mail** (spotřebuje se) nebo vlastní přihlášenou session (`verifySessionToken`,
který odmítá `typ === "bankid_state"`). `POST /api/users` uživatele bez hesla
nezakládá a odpovědí odkazuje na pozvánky; v UI je místo formuláře odkaz na
pozvánkový tok.

**Testy (5):** veřejné nastavení hesla odmítnuto a hash zůstal `null`; pozvánka
na stejný e-mail projde a je jednorázová; pozvánka na cizí e-mail neprojde;
`POST /api/users` vrací 400 a nic nezaloží; celý tok invite → accept → login.

### A5 — BankID fail-closed

**Problém:** bez `BANKID_MODE` se otevíral **mock** — fail-open.

**Řešení:** `resolveBankidMode()` vrací `{mode, reason}` a bez výslovné
konfigurace **odmítá**. Mock jen při `BANKID_MODE=mock` **a** neprodukčním
`NODE_ENV`. Kontrola v `/bankid/start` běží **před** dohledáním firmy, aby
odpověď neprozradila, které IČO v systému existuje. Při startu v produkci se
loguje varování o sandbox issueru a o chybějícím `BLOB_READ_WRITE_TOKEN` /
`CRON_SECRET`.

**Ponecháno vědomě:** BankID zůstává na **sandbox** issueru — na vlastní pokyn
(„ano, kromě BankID, ještě nemám produkční smlouvu"). Není to nedopatření,
je to čekání na smlouvu.

**Testy (3):** bez `BANKID_MODE` odmítnuto, `mock` v produkčním `NODE_ENV`
odmítnuto, `mock` v neprodukčním prostředí funguje.

---

## FÁZE B — hotová, ale NENASAZENÁ

Větev `feature/preshranicni-dph`, commit `1f4baf3`.

> **Fáze B se nesmí nasadit do produkce, dokud účetní nepotvrdí
> `DPH_ROZHODNUTI.md`.** Je to zapsané v commit message, v hlavičce
> `DPH_ROZHODNUTI.md` i v DOKUMENTACE.md 12.2.

**Co je hotové:** enum režimů plnění na dokladu i v evidenci DPH, tabulka
`vat_regime_config`, samovyměření s konfigurovatelnými účty, souhrnné hlášení
(`GET /api/vat/souhrnne-hlaseni` + DPHSHV XML), `identifikovaná osoba`
v nastavení + pasivní varování na dashboardu, rozšíření DPHDP3 o přeshraniční
řádky.

**Proč to není nasazené:** protože mechanismus bez daňového rozhodnutí nemá co
generovat, a hádat ho by bylo horší než ho nemít. Konkrétně systém:

- neodvozuje režim plnění z DIČ ani ze země protistrany,
- nemá **žádné** výchozí účty ani výchozí mapování na řádky přiznání,
- neodhaduje sazbu daně,
- nerozhoduje, co patří do souhrnného hlášení,
- nevyhodnocuje vznik registrační povinnosti identifikované osoby.

Dokud konfigurace není potvrzená, samovyměření vrací **409** se seznamem toho,
co chybí; souhrnné hlášení se nevygeneruje; přiznání dané plnění nezahrne do
žádného řádku a do XML vloží komentář `UPOZORNĚNÍ` s nezařazenými částkami
(plus hlavička `X-Nepokryty-Rezim`). V UI **záměrně není tlačítko „Potvrdit"** —
daňové rozhodnutí nemá proklikat běžný uživatel.

**Nálezy, které patří na stůl účetní:**

1. **Souhrnné hlášení možná firmu vůbec netýká.** Ověřil jsem strukturu proti
   oficiálnímu `dphshv_epo2.xsd`: všechny kódy plnění `k_pln_eu` (0 = dodání
   zboží do EU, 1 = přemístění majetku, 2 = třístranný obchod, 3 = služba
   s místem plnění v jiném členském státě) popisují plnění **poskytnutá** do
   EU. Dodavatelé firmy (Meta, Google, Stripe, Vercel, Anthropic) jsou plnění
   **přijatá**. Zapsáno jako rozhodovací bod (DPH_ROZHODNUTI.md sekce 5), **ne**
   jako můj závěr.
2. **Dvojí započtení odpočtu.** Původní součet do přiznání bral všechny řádky
   evidence bez ohledu na režim — samovyměřený odpočet by tak spadl zároveň do
   tuzemského řádku 40 i do řádku přeshraničního. Tuzemský součet je proto
   zúžený na `vat_regime = 'tuzemsko_standard'`. Test to hlídá.
3. **Účet daně na vstupu má dvojí význam** podle `deduction_allowed` (účet
   nároku na odpočet vs. nákladový účet pro neodpočitatelnou daň). Řešeno takto
   místo přidání dalšího sloupce; je to popsané v kódu i v dokumentu pro účetní.

**Ověření:** 11 nových testů, které cílí právě na odmítání — kdyby někdo
v budoucnu do kódu doplnil výchozí účty nebo výchozí mapování, testy spadnou.
Celá sada prošla na SQLite i proti reálné PostgreSQL instanci; `schema-pg.sql`
se načte bez chyb a je idempotentní.

---

## Co vědomě zůstalo neopravené

| Věc | Proč |
|---|---|
| BankID na sandbox issueru | čeká na produkční smlouvu — rozhodnutí vlastníka, ne technická mezera |
| PITR / branching u Neonu | zapíná se v konzoli poskytovatele, kód to udělat nemůže; postup v DOKUMENTACE.md 10.6 |
| `BEFORE UPDATE` guard na `posting_line` / `document_line` | duplicitní resp. rozbíjí pracovní postup — zdůvodněno výše a v DOKUMENTACE.md 12.3 |
| Mzdy, daň z příjmů, skladová evidence | mimo zadání, popsané v DOKUMENTACE.md 12.1 |
| Zastaralá nápověda v aplikaci (tvrdí, že data zůstávají lokálně) | text, ne funkce; hlášeno v DOKUMENTACE.md 12.3 |
| UI pro potvrzení konfigurace režimů DPH | úmyslně chybí, dokud účetní nepotvrdí `DPH_ROZHODNUTI.md` |

---

## Co je potřeba udělat mimo kód

1. **Zapnout PITR / branching u Neonu** (druhá vrstva zálohy).
2. **Zkontrolovat, že na Vercelu jsou nastavené** `BLOB_READ_WRITE_TOKEN`
   a `CRON_SECRET` — bez nich se přílohy neukládají trvale a záloha neběží.
   Aplikace na to při startu v produkci upozorní v logu.
3. **Dát `DPH_ROZHODNUTI.md` účetní k vyplnění a podpisu.** Bez toho fáze B
   zůstává na větvi.
4. **Dořešit produkční smlouvu s BankID**, pak přepnout issuer ze sandboxu.
