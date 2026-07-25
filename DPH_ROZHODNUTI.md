# Přeshraniční DPH — rozhodnutí, která musí potvrdit účetní

> **STAV: ČEKÁ NA ÚČETNÍ. NENASAZOVAT DO PRODUKCE.**
>
> Tento dokument není závěr, je to **soupis otevřených otázek**. Kód fáze B umí
> mechanismus (evidenci režimů, samovyměření, souhrnné hlášení, XML), ale
> **záměrně odmítá cokoli vygenerovat, dokud tady někdo kompetentní nedoplní a
> nepotvrdí odpovědi**. Návrhy v tabulkách jsou podklad k odsouhlasení nebo
> opravě, ne hotové řešení.
>
> Vypracoval: automatizovaný agent (Claude) na základě oficiálních XSD finanční
> správy a struktury systému. **Bez daňové kvalifikace.** Nic z toho nepředstavuje
> daňové poradenství.

Datum vypracování: 2026-07-25
Větev: `feature/preshranicni-dph`
Potvrdil (jméno, datum, podpis): ______________________________

---

## 0. Jak systém pracuje s nerozhodnutým stavem

Klíčový návrhový princip: **`NULL` znamená „nerozhodnuto“, ne „ne“.**

V tabulce `vat_regime_config` jsou sloupce `deduction_allowed` a
`include_in_summary_report` nullable. Dokud jsou `NULL`:

- samovyměření (`POST /api/vat/self-assessment/:documentId`) vrátí **HTTP 409**
  a výpis toho, co chybí,
- souhrnné hlášení dané plnění **nezahrne** a k výstupu přidá upozornění,
- přiznání k DPH plnění **nezahrne** do žádného řádku a do XML vloží komentář
  „UPOZORNĚNÍ“ se seznamem nezařazených částek.

Stejně tak `confirmed_at IS NULL` znamená „rozpracováno“ — rozpracovaná
konfigurace se do žádného podání nedostane.

**Vědomé rozhodnutí:** v uživatelském rozhraní **není tlačítko „Potvrdit“.**
Konfigurace režimů se zadává přes API (`PUT /api/vat/regimes/:regime`), aby
potvrzení daňového rozhodnutí nemohl proklikat běžný uživatel bez účetní. Až
tento dokument bude potvrzený, dá se UI doplnit — do té doby je absence
tlačítka funkce, ne nedodělek.

---

## 1. Číselník režimů plnění — je úplný a správně pojmenovaný?

Zavedený enum (`document.vat_regime`, `vat_ledger_entry.vat_regime`):

| Klíč | Popis v systému | Otázka pro účetní |
|---|---|---|
| `tuzemsko_standard` | tuzemské plnění, daň odvádí dodavatel | výchozí hodnota u všech existujících dokladů — OK? |
| `reverse_charge_tuzemsko` | tuzemský reverse charge (§ 92a a násl.) | potřebujeme vůbec? firma dnes stavební práce nemá |
| `reverse_charge_sluzba_eu` | přijatá služba od osoby registrované v EU | **týká se reálných dodavatelů (Meta, Google Ireland, Stripe)** |
| `reverse_charge_sluzba_3zeme` | přijatá služba ze třetí země | **týká se reálných dodavatelů (Anthropic, Vercel)** |
| `intrakomunitarni_porizeni_zbozi` | pořízení zboží z EU (§ 16) | firma dnes nemá, ponechat pro budoucnost? |
| `dodani_zbozi_eu` | dodání zboží do EU (§ 64) | — |
| `sluzba_eu_poskytnuta` | poskytnutá služba do EU (§ 9 odst. 1) | plánuje firma prodávat do EU? |
| `dovoz` | dovoz zboží ze třetí země | — |
| `vyvoz` | vývoz zboží (§ 66) | — |
| `osvobozeno` | osvobozené plnění | s nárokem / bez nároku se dnes nerozlišuje — stačí? |
| `mimo_predmet` | není předmětem DPH | — |

**Otevřené otázky:**

1. Chybí nějaký režim, který firma reálně potřebuje? (např. zasílání zboží /
   OSS podle § 110a, třístranný obchod podle § 17, přemístění majetku)
2. Je rozlišení `osvobozeno` bez podrozlišení „s nárokem / bez nároku na
   odpočet“ dostatečné, nebo je potřeba rozdělit na dva režimy?
3. Má se režim odvozovat automaticky z DIČ protistrany (např. `IE…` → EU),
   nebo ho vždy volí uživatel ručně? **Systém dnes nic neodvozuje** — režim se
   zadává výslovně, výchozí je tuzemský.

---

## 2. Účty pro samovyměření — jaké konkrétně?

`vat_regime_config.output_vat_account_id` a `input_vat_account_id`.
V kódu **není žádný výchozí účet**; bez zadání se zápis nevygeneruje.

Vygenerovaný zápis (v CZK, přepočet kurzem zamrznutým na dokladu):

```
MD  input_vat_account_id    ... daň na vstupu
D   output_vat_account_id   ... daň na výstupu
```

**Dvojí význam účtu na vstupu** (podle `deduction_allowed`):

| `deduction_allowed` | co má být v `input_vat_account_id` |
|---|---|
| `1` (nárok je) | účet nároku na odpočet, typicky analytika 343 |
| `0` (nárok není) | **nákladový** účet, na kterém neodpočitatelná daň zůstane jako náklad |
| `NULL` | nerozhodnuto → systém neúčtuje |

**Otázky:**

4. Má se pro daň na výstupu ze samovyměření použít samostatná analytika
   (např. 343.100 „DPH — samovyměření“) místo souhrnného 343? Doporučení
   agenta: **ano**, kvůli dohledatelnosti v přiznání — ale je to volba účetní.
5. Který nákladový účet u režimů bez nároku na odpočet?
6. Má se rozlišovat analytika podle režimu (EU vs. třetí země), nebo stačí
   jedna společná?

Vyplňte:

| Režim | Účet daně na výstupu | Účet daně na vstupu | Nárok na odpočet (ano/ne) |
|---|---|---|---|
| `reverse_charge_sluzba_eu` | | | |
| `reverse_charge_sluzba_3zeme` | | | |
| `reverse_charge_tuzemsko` | | | |
| `intrakomunitarni_porizeni_zbozi` | | | |
| `dovoz` | | | |

---

## 3. Sazba daně u samovyměření — kdo ji určuje?

**Systém sazbu neodhaduje.** Pokud doklad nemá vyplněnou `vat_rate`,
samovyměření skončí chybou „sazbu pro samovyměření musí zadat účetní, systém
ji neodhaduje“.

**Otázky:**

7. Je u přijaté reklamní služby z EU (Meta, Google) správná základní sazba
   21 %? Potvrdit, ať to uživatel nezadává naslepo.
8. Existuje u firmy plnění, na které dopadá snížená sazba 12 %?
9. Základ daně: systém bere `vat_base_amount`, a když není vyplněný, použije
   **celou částku dokladu** (`total_amount`) — u přenesené daňové povinnosti
   dodavatel fakturuje bez daně, takže celá fakturovaná částka je základem.
   Je to takhle správně?
10. Přepočet cizí valuty používá kurz **zamrznutý ke dni vystavení dokladu**
    (§ 24 odst. 6–7 ZoÚ, stejně jako zbytek systému). Nemá se u DPH použít
    kurz k DUZP, pokud se liší?

---

## 4. Mapování na řádky přiznání k DPH (DPHDP3)

Systém **nemapuje režimy na řádky přiznání sám.** Mapování se zadává jako text
do `vat_regime_config.vat_return_row` ve formátu:

```
uskutecnene=Veta1:p_sl23_e,dan_psl23_e|prijate=Veta4:odp_tuz23
```

- `uskutecnene` = řádek pro daň na výstupu, `prijate` = řádek pro nárok na odpočet
- za dvojtečkou element XML a atributy: **první = základ, druhý (volitelný) = daň**
- názvy atributů se validují proti seznamu opsanému z `dphdp3_epo2.xsd`;
  překlep skončí chybou při zadávání, ne až v podání

Kandidátní atributy z oficiálního schématu
(<https://adisspr.mfcr.cz/adis/jepo/schema/dphdp3_epo2.xsd>), **jen jako
nabídka, nikoli jako doporučené přiřazení**:

| Atributy (základ / daň) | Anotace ve schématu |
|---|---|
| `p_sl23_e` / `dan_psl23_e` | přijetí služby od osoby registrované k dani v jiném členském státě, 23% sazba |
| `p_sl5_e` / `dan_psl5_e` | totéž, snížená sazba |
| `p_sl23_z` / `dan_psl23_z` | služba od neusazené osoby s místem plnění v tuzemsku (§ 108) |
| `p_zb23` / `dan_pzb23` | pořízení zboží z jiného členského státu (§ 16) |
| `rez_pren23` / `dan_rpren23` | příjemce v režimu přenesení daňové povinnosti |
| `dov_zb23` / `dan_dzb23` | dovoz zboží |
| `pln_sluzby` (Veta2) | poskytnutí služby do jiného členského státu (§ 9 odst. 1) |
| `dod_zb` (Veta2) | dodání zboží do jiného členského státu (§ 64) |
| `pln_vyvoz` (Veta2) | vývoz (§ 66) |
| `pln_rez_pren` (Veta2) | plnění v režimu přenesení daňové povinnosti |
| `odp_tuz23` / `odp_tuz23_nar` (Veta4) | odpočet daně na vstupu |

**Otázky:**

11. Přiřaďte každému používanému režimu odpovídající atribut(y). Bez toho se
    plnění do XML nedostane — objeví se jen v komentáři „UPOZORNĚNÍ“ a musí se
    doplnit ručně v EPO.
12. Patří odpočet ze samovyměření do `odp_tuz23`, nebo do jiného řádku
    (`odp_tuz23_nar` při plném nároku)?
13. Sečtení tuzemského a přeshraničního odpočtu do stejného atributu `odp_tuz23`
    (systém to dnes dělá) — správné, nebo se to má vykazovat odděleně?

Vyplňte:

| Režim | `vat_return_row` |
|---|---|
| `reverse_charge_sluzba_eu` | |
| `reverse_charge_sluzba_3zeme` | |
| `intrakomunitarni_porizeni_zbozi` | |
| `sluzba_eu_poskytnuta` | |
| `dodani_zbozi_eu` | |

---

## 5. Souhrnné hlášení (§ 102) — otevřená otázka, ne závěr

Struktura XML **ověřena** proti oficiálnímu `dphshv_epo2.xsd`:
root `Pisemnost` → `DPHSHV` → `VetaD` (období, `shvies_forma="R"`), `VetaP`
(podávající), `VetaR` (řádky: `k_stat`, `c_vat`, `k_pln_eu`, `pln_pocet`,
`pln_hodnota`), `VetaS` (třístranný obchod, jen u `k_pln_eu = 2` — systém
negeneruje).

Číselník `k_pln_eu` ze schématu:

| Kód | Význam |
|---|---|
| `0` | dodání zboží do jiného členského státu |
| `1` | přemístění obchodního majetku do jiného členského státu |
| `2` | dodání zboží prostřední osobou v třístranném obchodu |
| `3` | poskytnutí služby s místem plnění v jiném členském státě |

> **ZJIŠTĚNÍ, KTERÉ JE POTŘEBA POTVRDIT:** všechny čtyři kódy popisují plnění
> **poskytnutá** (výstupní) do EU. Dodavatelé, které firma reálně má (Meta,
> Google, Stripe, Vercel, Anthropic), jsou plnění **přijatá** (vstupní). Podle
> struktury schématu by tedy firma za přijaté služby souhrnné hlášení
> nepodávala — ale **tohle je pozorování nad XSD, ne daňový závěr**, a musí to
> potvrdit účetní.

**Otázky:**

14. Podává firma souhrnné hlášení vůbec? Pokud dnes jen přijímá služby ze
    zahraničí, vzniká povinnost?
15. Pro každý režim: `include_in_summary_report` = 1/0 a `summary_report_code`
    (kód `k_pln_eu` výše).
16. Perioda hlášení: měsíčně, nebo kvartálně (a za jakých podmínek)?
17. Systém dnes generuje pouze **řádné** hlášení (`shvies_forma="R"`).
    Následné (`"N"`) je potřeba?
18. `pln_hodnota` se zaokrouhluje na **celé Kč** (schéma nepřipouští haléře).
    Je zaokrouhlení matematicky (`Math.round`) správné, nebo se má zaokrouhlovat
    dolů/nahoru?

Vyplňte:

| Režim | Do souhrnného hlášení (1/0) | Kód `k_pln_eu` |
|---|---|---|
| `sluzba_eu_poskytnuta` | | |
| `dodani_zbozi_eu` | | |
| `reverse_charge_sluzba_eu` | | |
| `reverse_charge_sluzba_3zeme` | | |
| `intrakomunitarni_porizeni_zbozi` | | |

---

## 6. Identifikovaná osoba (§ 6g–6i ZDPH)

Systém eviduje stav (`accounting_unit.identifikovana_osoba`,
`identifikovana_osoba_od`) a na dashboardu zobrazí upozornění, když firma není
plátce ani identifikovaná osoba. **Upozornění netvrdí, že povinnost vznikla** —
říká „ověřte s účetní“.

**Otázky:**

19. Vznikla firmě povinnost registrace jako identifikovaná osoba přijetím
    služeb z EU / třetích zemí (Meta, Google, Anthropic, Vercel)? Od kdy?
20. Jaká je lhůta pro registraci a hrozí za dosavadní stav sankce?
21. Má systém tento stav vůbec vyhodnocovat automaticky (např. „přišel doklad
    v režimu přijaté služby z EU → připomeň registraci“), nebo má zůstat u
    pasivního upozornění? Doporučení agenta: **zůstat u pasivního upozornění** —
    automatické vyhodnocování registračních povinností je daňové posouzení.

---

## 7. Kontrolní hlášení (DPHKH1) a přeshraniční plnění

22. Patří přeshraniční plnění do kontrolního hlášení (§ 100), a pokud ano, do
    které věty? Systém dnes do KH posílá **pouze** řádky s
    `requires_individual_kh = 1` bez ohledu na režim, což u přeshraničních
    plnění nemusí být správné.
23. Platí u samovyměření limit 10 000 Kč pro individuální evidenci stejně jako
    u tuzemských plnění?

---

## 8. Co systém záměrně NEDĚLÁ (a proč)

Pro úplnost — tohle nejsou nedodělky, ale místa, kde by hádání bylo horší než
absence funkce:

- **Neodvozuje režim plnění z DIČ ani ze země protistrany.** Režim volí člověk.
- **Nemá výchozí účty ani výchozí mapování na řádky přiznání.** Prázdná
  konfigurace = mechanismus stojí.
- **Neodhaduje sazbu daně.**
- **Nerozhoduje, co patří do souhrnného hlášení.**
- **Nevyhodnocuje vznik registrační povinnosti.**
- **Negeneruje následné souhrnné hlášení ani větu VetaS** (třístranný obchod).
- **Neopravuje historii.** Chybné samovyměření se řeší stornem, ne editací
  (§ 33a ZoÚ, vynuceno databázovými triggery).

---

## 9. Postup po potvrzení tohoto dokumentu

1. Doplnit tabulky výše a podepsat.
2. Nastavit konfiguraci každého používaného režimu:
   `PUT /api/vat/regimes/:regime` s `confirm: true`.
3. Ověřit na jednom reálném dokladu (nejlépe Meta/Google faktura), že
   vygenerovaný zápis odpovídá tomu, jak by ho účetní zaúčtovala ručně.
4. Vygenerovat DPHDP3 a případně DPHSHV a **nechat je zkontrolovat účetní před
   podáním** — výstup je podklad, ne ověřené podání.
5. Teprve pak lze větev `feature/preshranicni-dph` sloučit a nasadit.
