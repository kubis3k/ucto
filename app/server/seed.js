// =====================================================================
// seed.js — počáteční data při prvním spuštění (prázdná databáze).
// Zrcadlí ../../db/003_seed_data.sql, portováno na SQLite.
// =====================================================================
const store = require("./db");
const { insertAccounts } = require("./lib/chartOfAccountsSeed");

async function seed() {
  const existing = await store.get("SELECT id FROM accounting_unit LIMIT 1");
  if (existing) return; // už osazeno, nic nedělat

  await store.transaction(async () => {
    await store.run(
      `INSERT INTO accounting_unit (name, ico, dic, accounting_mode, unit_category, is_vat_payer, fiscal_year_start_month)
       VALUES (?,?,?,?,?,?,?)`,
      ["Globaal Elevate Production s.r.o.", "24972070", "CZ24972070", "podvojne_ucetnictvi", "mikro", 0, 1]
    );
    const unitId = (await store.get("SELECT last_insert_rowid() AS id")).id;

    await store.run(
      `INSERT INTO app_user (accounting_unit_id, full_name, email, role) VALUES (?,?,?,?)`,
      [unitId, "Luigi", "luigi@globaalelevate.com", "admin"]
    );

    // Statutární orgán (jednatelé) podle výpisu ze živnostenského rejstříku —
    // zdroj pravdy pro ověření přihlášení přes BankID.
    const directors = ["Jakub Lučan", "Jan Leština", "Štěpán Lísa"];
    for (const name of directors) {
      await store.run(`INSERT INTO company_director (accounting_unit_id, full_name) VALUES (?,?)`, [unitId, name]);
    }

    await store.run(
      `INSERT INTO accounting_period (accounting_unit_id, fiscal_year, start_date, end_date, status)
       VALUES (?,?,?,?,?)`,
      [unitId, 2026, "2026-04-20", "2026-12-31", "otevrene"]
    );

    const acctIds = await insertAccounts(store, unitId);

    const projects = [
      ["NIKTENDO2027", "Nik Tendo Praha", "2027-01-22"],
      ["3LWAVE", "3Lwave klubová série", "2027-01-01"],
      ["58G-CHOMUTOV", "58G Chomutov (Latino klub)", "2026-09-11"],
      ["3LFEST", "3L Fest — Chomutov airfield pilot", "2027-06-01"],
    ];
    for (const [code, name, start] of projects) {
      await store.run(
        `INSERT INTO project (accounting_unit_id, code, name, start_date) VALUES (?,?,?,?)`,
        [unitId, code, name, start]
      );
    }

    // Startovní předkontace (šablony zaúčtování) pro typické případy firmy.
    // Formát: [název, doc_type, popis, [[účet, strana, zdroj_částky], ...]]
    const templates = [
      ["Přijatá faktura — služby/pronájem", "faktura_prijata", "Pronájem klubu, technika, právní/účetní služby → 518 / 321",
        [["518", "MD", "celkem"], ["321", "D", "celkem"]]],
      ["Vydaná faktura — tržby za služby", "faktura_vydana", "Vstupenky, sponzoring, produkce → 311 / 602",
        [["311", "MD", "celkem"], ["602", "D", "celkem"]]],
      ["Pokladní výdej — honorář umělci", "pokladni_vydej", "Hotovostní honorář bez faktury → 518 / 211",
        [["518", "MD", "celkem"], ["211", "D", "celkem"]]],
      ["Úhrada přijaté faktury z banky", "bankovni_pohyb", "Zaplacení závazku dodavateli → 321 / 221",
        [["321", "MD", "celkem"], ["221", "D", "celkem"]]],
      ["Přijatá faktura s DPH (po registraci)", "faktura_prijata", "Základ → 518, DPH → 343, celkem → 321",
        [["518", "MD", "zaklad"], ["343", "MD", "dph"], ["321", "D", "celkem"]]],
    ];
    for (const [name, docType, desc, lines] of templates) {
      await store.run(`INSERT INTO posting_template (accounting_unit_id, name, doc_type, description) VALUES (?,?,?,?)`,
        [unitId, name, docType, desc]);
      const tplId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      for (const [accNum, side, src] of lines) {
        if (!acctIds[accNum]) continue;
        await store.run(`INSERT INTO posting_template_line (template_id, account_id, side, amount_source) VALUES (?,?,?,?)`,
          [tplId, acctIds[accNum], side, src]);
      }
    }
  });
}

module.exports = { seed };
