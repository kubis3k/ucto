// =====================================================================
// chartOfAccountsSeed.js — účtový rozvrh (směrná účtová osnova podle
// přílohy č. 4 vyhl. 500/2002 Sb.), zúžený na účty reálně potřebné pro
// malou s.r.o. v oblasti produkce/marketingu (ne plný osnovní katalog
// pro výrobu/zemědělství apod.).
//
// Formát řádku: [číslo, název, třída (0-9), typ, nadřazený_účet|null]
// =====================================================================

const ACCOUNTS = [
  // Třída 0 — dlouhodobý majetek
  ["013", "Software", 0, "rozvahovy_aktivni", null],
  ["014", "Ocenitelná práva", 0, "rozvahovy_aktivni", null],
  ["021", "Stavby", 0, "rozvahovy_aktivni", null],
  ["022", "Samostatné movité věci (dlouhodobý majetek)", 0, "rozvahovy_aktivni", null],
  ["042", "Nedokončený dlouhodobý hmotný majetek", 0, "rozvahovy_aktivni", null],
  ["082", "Oprávky k samostatným movitým věcem", 0, "rozvahovy_aktivni", null],

  // Třída 1 — zásoby
  ["132", "Zboží na skladě a v prodejnách", 1, "rozvahovy_aktivni", null],
  ["139", "Zboží na cestě", 1, "rozvahovy_aktivni", null],

  // Třída 2 — finanční účty
  ["211", "Pokladna", 2, "rozvahovy_aktivni", null],
  ["213", "Ceniny (stravenky, dálniční známky)", 2, "rozvahovy_aktivni", null],
  ["221", "Bankovní účet", 2, "rozvahovy_aktivni", null],
  ["261", "Peníze na cestě", 2, "rozvahovy_aktivni", null],

  // Třída 3 — zúčtovací vztahy
  ["311", "Odběratelé", 3, "rozvahovy_aktivni", null],
  ["314", "Poskytnuté provozní zálohy", 3, "rozvahovy_aktivni", null],
  ["315", "Ostatní pohledávky", 3, "rozvahovy_aktivni", null],
  ["321", "Dodavatelé", 3, "rozvahovy_pasivni", null],
  ["324", "Přijaté provozní zálohy", 3, "rozvahovy_pasivni", null],
  ["325", "Ostatní závazky (honoráře bez faktury)", 3, "rozvahovy_pasivni", null],
  ["331", "Zaměstnanci", 3, "rozvahovy_pasivni", null],
  ["333", "Ostatní závazky vůči zaměstnancům", 3, "rozvahovy_pasivni", null],
  ["336", "Zúčtování s institucemi soc. a zdrav. zabezpečení", 3, "rozvahovy_pasivni", null],
  ["341", "Daň z příjmů", 3, "rozvahovy_pasivni", null],
  ["342", "Ostatní přímé daně", 3, "rozvahovy_pasivni", null],
  ["343", "DPH (aktivuje se s registrací)", 3, "rozvahovy_pasivni", null],
  ["345", "Ostatní daně a poplatky", 3, "rozvahovy_pasivni", null],
  ["354", "Pohledávky za společníky", 3, "rozvahovy_aktivni", null],
  ["353", "Pohledávky za upsaný vlastní kapitál", 3, "rozvahovy_aktivni", null],
  ["365", "Ostatní závazky ke společníkům", 3, "rozvahovy_pasivni", null],
  ["366", "Závazky ke společníkům při rozdělování zisku", 3, "rozvahovy_pasivni", null],
  ["379", "Jiné závazky", 3, "rozvahovy_pasivni", null],
  ["381", "Náklady příštích období", 3, "rozvahovy_aktivni", null],
  ["384", "Výnosy příštích období", 3, "rozvahovy_pasivni", null],
  ["385", "Příjmy příštích období", 3, "rozvahovy_aktivni", null],
  ["388", "Dohadné účty aktivní", 3, "rozvahovy_aktivni", null],
  ["389", "Dohadné účty pasivní", 3, "rozvahovy_pasivni", null],

  // Třída 4 — kapitálové účty a dlouhodobé závazky
  ["411", "Základní kapitál", 4, "rozvahovy_pasivni", null],
  ["413", "Ostatní kapitálové fondy", 4, "rozvahovy_pasivni", null],
  ["421", "Rezervní fond", 4, "rozvahovy_pasivni", null],
  ["427", "Ostatní fondy ze zisku", 4, "rozvahovy_pasivni", null],
  ["428", "Nerozdělený zisk minulých let", 4, "rozvahovy_pasivni", null],
  ["429", "Neuhrazená ztráta minulých let", 4, "rozvahovy_pasivni", null],
  ["431", "Výsledek hospodaření ve schvalovacím řízení", 4, "rozvahovy_pasivni", null],
  ["451", "Rezervy podle zvláštních právních předpisů", 4, "rozvahovy_pasivni", null],
  ["459", "Ostatní rezervy", 4, "rozvahovy_pasivni", null],
  ["461", "Dlouhodobé bankovní úvěry", 4, "rozvahovy_pasivni", null],
  ["479", "Jiné dlouhodobé závazky", 4, "rozvahovy_pasivni", null],

  // Třída 5 — náklady
  ["501", "Spotřeba materiálu", 5, "vysledkovy_naklad", null],
  ["502", "Spotřeba energie", 5, "vysledkovy_naklad", null],
  ["504", "Prodané zboží", 5, "vysledkovy_naklad", null],
  ["511", "Opravy a udržování", 5, "vysledkovy_naklad", null],
  ["512", "Cestovné", 5, "vysledkovy_naklad", null],
  ["513", "Náklady na reprezentaci", 5, "vysledkovy_naklad", null],
  ["518", "Ostatní služby (pronájmy, technika, právní/účetní služby)", 5, "vysledkovy_naklad", null],
  ["521", "Mzdové náklady", 5, "vysledkovy_naklad", null],
  ["524", "Zákonné sociální a zdravotní pojištění", 5, "vysledkovy_naklad", null],
  ["525", "Ostatní sociální pojištění", 5, "vysledkovy_naklad", null],
  ["527", "Zákonné sociální náklady", 5, "vysledkovy_naklad", null],
  ["528", "Ostatní sociální náklady", 5, "vysledkovy_naklad", null],
  ["531", "Daně a poplatky (OSA, správní poplatky)", 5, "vysledkovy_naklad", null],
  ["538", "Ostatní daně a poplatky", 5, "vysledkovy_naklad", null],
  ["541", "Zůstatková cena prodaného dlouhodobého majetku", 5, "vysledkovy_naklad", null],
  ["543", "Dary", 5, "vysledkovy_naklad", null],
  ["544", "Smluvní pokuty a úroky z prodlení", 5, "vysledkovy_naklad", null],
  ["545", "Ostatní pokuty a penále", 5, "vysledkovy_naklad", null],
  ["546", "Odpis pohledávky", 5, "vysledkovy_naklad", null],
  ["548", "Ostatní provozní náklady", 5, "vysledkovy_naklad", null],
  ["549", "Manka a škody", 5, "vysledkovy_naklad", null],
  ["551", "Odpisy dlouhodobého majetku", 5, "vysledkovy_naklad", null],
  ["562", "Úroky", 5, "vysledkovy_naklad", null],
  ["563", "Kursové ztráty", 5, "vysledkovy_naklad", null],
  ["568", "Ostatní finanční náklady", 5, "vysledkovy_naklad", null],
  ["569", "Manka a škody na finančním majetku", 5, "vysledkovy_naklad", null],
  ["591", "Daň z příjmů splatná", 5, "vysledkovy_naklad", null],
  ["595", "Dodatečné odvody daně z příjmů", 5, "vysledkovy_naklad", null],

  // Třída 6 — výnosy
  ["602", "Tržby z prodeje služeb (vstupenky, sponzoring)", 6, "vysledkovy_vynos", null],
  ["604", "Tržby za zboží", 6, "vysledkovy_vynos", null],
  ["641", "Tržby z prodeje dlouhodobého nehmotného a hmotného majetku", 6, "vysledkovy_vynos", null],
  ["644", "Smluvní pokuty a úroky z prodlení", 6, "vysledkovy_vynos", null],
  ["648", "Ostatní provozní výnosy", 6, "vysledkovy_vynos", null],
  ["662", "Úroky", 6, "vysledkovy_vynos", null],
  ["663", "Kursové zisky", 6, "vysledkovy_vynos", null],
  ["668", "Ostatní finanční výnosy", 6, "vysledkovy_vynos", null],

  // Třída 7 — uzávěrkové a podrozvahové účty
  ["701", "Počáteční účet rozvažný", 7, "zaverkovy", null],
  ["702", "Konečný účet rozvažný", 7, "zaverkovy", null],
  ["710", "Účet zisků a ztrát", 7, "zaverkovy", null],

  // Analytické podúčty k 518 (per akce/klient)
  ["518100", "518 — analytika: Nik Tendo Praha", 5, "vysledkovy_naklad", "518"],
  ["518200", "518 — analytika: 3L Fest", 5, "vysledkovy_naklad", "518"],
  ["518300", "Software a cloudové služby (SaaS)", 5, "vysledkovy_naklad", "518"],
  ["518400", "Reklama a marketing", 5, "vysledkovy_naklad", "518"],
  ["518500", "Telekomunikační služby a firemní e-SIM", 5, "vysledkovy_naklad", "518"],
];

// Vloží účty (v pořadí bez rodičů, pak s rodiči) pro danou accounting_unit_id.
// Vrací mapu account_number -> id (pro navázání analytických podúčtů a šablon).
async function insertAccounts(store, unitId) {
  const acctIds = {};
  const withoutParent = ACCOUNTS.filter((a) => !a[4]);
  const withParent = ACCOUNTS.filter((a) => a[4]);
  for (const [number, name, cls, type] of withoutParent) {
    await store.run(
      `INSERT INTO chart_of_accounts (accounting_unit_id, account_number, name, account_class, account_type)
       VALUES (?,?,?,?,?)`,
      [unitId, number, name, cls, type]
    );
    acctIds[number] = (await store.get("SELECT last_insert_rowid() AS id")).id;
  }
  for (const [number, name, cls, type, parentNumber] of withParent) {
    await store.run(
      `INSERT INTO chart_of_accounts (accounting_unit_id, account_number, parent_account_id, name, account_class, account_type)
       VALUES (?,?,?,?,?,?)`,
      [unitId, number, acctIds[parentNumber] || null, name, cls, type]
    );
    acctIds[number] = (await store.get("SELECT last_insert_rowid() AS id")).id;
  }
  return acctIds;
}

// Idempotentně doplní chybějící účty pro VŠECHNY existující účetní jednotky
// (spouštěno při každém startu serveru) — nové účty se tak dostanou i do
// appky, která už byla dříve nainstalovaná a osazená staršími seed daty.
async function ensureChartOfAccounts(store) {
  const units = await store.all("SELECT id FROM accounting_unit");
  for (const unit of units) {
    const existingNumbers = new Set(
      (await store.all("SELECT account_number FROM chart_of_accounts WHERE accounting_unit_id = ?", [unit.id]))
        .map((r) => r.account_number)
    );
    const missingWithoutParent = ACCOUNTS.filter((a) => !a[4] && !existingNumbers.has(a[0]));
    const missingWithParent = ACCOUNTS.filter((a) => a[4] && !existingNumbers.has(a[0]));
    if (!missingWithoutParent.length && !missingWithParent.length) continue;

    await store.transaction(async () => {
      const parentIds = {};
      for (const [number, name, cls, type] of missingWithoutParent) {
        await store.run(
          `INSERT INTO chart_of_accounts (accounting_unit_id, account_number, name, account_class, account_type)
           VALUES (?,?,?,?,?)`,
          [unit.id, number, name, cls, type]
        );
      }
      for (const [number, name, cls, type, parentNumber] of missingWithParent) {
        const parentRow = await store.get(
          "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = ?",
          [unit.id, parentNumber]
        );
        await store.run(
          `INSERT INTO chart_of_accounts (accounting_unit_id, account_number, parent_account_id, name, account_class, account_type)
           VALUES (?,?,?,?,?,?)`,
          [unit.id, number, parentRow ? parentRow.id : null, name, cls, type]
        );
      }
    });
  }
  store.persist();
}

module.exports = { ACCOUNTS, insertAccounts, ensureChartOfAccounts };
