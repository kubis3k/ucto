// =====================================================================
// companySetup.js — jednorázové/idempotentní opravy základních dat firmy,
// spouštěné při každém startu serveru, aby se dostaly i do appek
// nainstalovaných před přidáním přihlašování/BankID ověření.
// =====================================================================

const KNOWN_DIRECTORS = {
  // IČO -> jednatelé podle výpisu ze živnostenského rejstříku
  "24972070": ["Jakub Lučan", "Jan Leština", "Štěpán Lísa"],
};

async function ensureCompanyDirectors(store) {
  const units = await store.all("SELECT id, ico FROM accounting_unit");
  for (const unit of units) {
    const directors = KNOWN_DIRECTORS[unit.ico];
    if (!directors) continue;
    const existing = new Set(
      (await store.all("SELECT full_name FROM company_director WHERE accounting_unit_id = ?", [unit.id])).map((r) => r.full_name)
    );
    for (const name of directors) {
      if (!existing.has(name)) {
        await store.run("INSERT INTO company_director (accounting_unit_id, full_name) VALUES (?,?)", [unit.id, name]);
      }
    }
  }
  store.persist();
}

// Oprava placeholder IČO "00000000" použitého v dřívějším seed.js na reálné
// IČO ze živnostenského rejstříku — nutné, aby DIČ i BankID/ARES ověření dávalo smysl.
async function fixPlaceholderIco(store) {
  await store.run(
    "UPDATE accounting_unit SET ico = '24972070' WHERE ico = '00000000' AND dic = 'CZ24972070'"
  );
  store.persist();
}

module.exports = { ensureCompanyDirectors, fixPlaceholderIco };
