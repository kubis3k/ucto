// =====================================================================
// statementMapping.js — mapování syntetických účtů na řádky rozvahy a
// výsledovky podle přílohy č. 1 a č. 2 vyhlášky č. 500/2002 Sb.,
// zjednodušený rozsah pro mikro účetní jednotku (aktuální struktura po
// novele 2016 — bez zrušených položek "Zřizovací výdaje" a "Mimořádné
// výnosy/náklady").
//
// ⚠ PRÁVNÍ UPOZORNĚNÍ (viz zadání úkolu 2, akceptační kritérium): tato
// mapa je INŽENÝRSKÝ NÁVRH podle veřejně dostupného znění vyhlášky, NENÍ
// to potvrzeno účetní firmou. Před použitím výkazu pro reálné podání
// (přiznání, sbírka listin) MUSÍ účetní firma zkontrolovat, že mapování
// odpovídá tomu, co by sama sestavila ručně — najít případné rozdíly je
// levnější teď na testovacích datech než po podání.
//
// Účet, který není v ACCOUNT_TO_ROW namapovaný explicitně, spadne do
// řádku "Nezařazeno" (podle třídy/strany) — NIKDY nezmizí ze sumy, jen
// upozorní, že mapu je třeba doplnit.
// =====================================================================

// ---------------------------------------------------------------- ROZVAHA
const ROZVAHA_ROWS = [
  { code: "B.I.", label: "Dlouhodobý nehmotný majetek", strana: "AKTIVA" },
  { code: "B.II.", label: "Dlouhodobý hmotný majetek", strana: "AKTIVA" },
  { code: "B.III.", label: "Dlouhodobý finanční majetek", strana: "AKTIVA" },
  { code: "C.I.", label: "Zásoby", strana: "AKTIVA" },
  { code: "C.II.", label: "Pohledávky", strana: "AKTIVA" },
  { code: "C.III.", label: "Krátkodobý finanční majetek", strana: "AKTIVA" },
  { code: "C.IV.", label: "Peněžní prostředky", strana: "AKTIVA" },
  { code: "D.", label: "Časové rozlišení aktiv", strana: "AKTIVA" },
  { code: "AKTIVA.X", label: "Nezařazeno (doplnit mapu)", strana: "AKTIVA" },

  { code: "A.I.", label: "Základní kapitál", strana: "PASIVA" },
  { code: "A.II.", label: "Ážio a kapitálové fondy", strana: "PASIVA" },
  { code: "A.III.", label: "Fondy ze zisku", strana: "PASIVA" },
  { code: "A.IV.", label: "Výsledek hospodaření minulých let (+/-)", strana: "PASIVA" },
  { code: "A.V.", label: "Výsledek hospodaření běžného účetního období (+/-)", strana: "PASIVA" },
  { code: "B.", label: "Rezervy", strana: "PASIVA" },
  { code: "C.I.p", label: "Dlouhodobé závazky", strana: "PASIVA" },
  { code: "C.II.p", label: "Krátkodobé závazky", strana: "PASIVA" },
  { code: "D.p", label: "Časové rozlišení pasiv", strana: "PASIVA" },
  { code: "PASIVA.X", label: "Nezařazeno (doplnit mapu)", strana: "PASIVA" },
];

// account_number -> řádek rozvahy. "431" (VH ve schvalovacím řízení) se
// promítá do A.IV. — po schválení valnou hromadou se stejně rozpustí do
// 428/429, do té doby je to nejbližší smysluplné místo ve zjednodušeném rozsahu.
const ACCOUNT_TO_ROZVAHA_ROW = {
  "013": "B.I.", "014": "B.I.",
  "021": "B.II.", "022": "B.II.", "042": "B.II.", "082": "B.II.",
  "132": "C.I.", "139": "C.I.",
  "211": "C.IV.", "213": "C.IV.", "221": "C.IV.", "261": "C.IV.",
  "311": "C.II.", "314": "C.II.", "315": "C.II.", "353": "C.II.", "354": "C.II.", "388": "C.II.",
  "381": "D.", "385": "D.",

  "321": "C.II.p", "324": "C.II.p", "325": "C.II.p", "331": "C.II.p", "333": "C.II.p",
  "336": "C.II.p", "341": "C.II.p", "342": "C.II.p", "343": "C.II.p", "345": "C.II.p",
  "365": "C.II.p", "379": "C.II.p", "389": "C.II.p",
  "461": "C.I.p", "479": "C.I.p",
  "384": "D.p",
  "411": "A.I.",
  "413": "A.II.",
  "421": "A.III.", "427": "A.III.",
  "428": "A.IV.", "429": "A.IV.", "431": "A.IV.",
  "366": "C.II.p", // vypořádání podílu na zisku vůči společníkům je krátkodobý závazek, ne vlastní kapitál
  "451": "B.", "459": "B.",
};

// ---------------------------------------------------------------- VÝSLEDOVKA
// Řádky ve zjednodušeném rozsahu (druhové členění), včetně mezisoučtů
// (level:"sum" — počítané z ostatních řádků, nemají vlastní účty).
const VYSLEDOVKA_ROWS = [
  { code: "I.", label: "Tržby z prodeje výrobků a služeb a za zboží", druh: "VÝNOS" },
  { code: "A.", label: "Výkonová spotřeba", druh: "NÁKLAD" },
  { code: "+", label: "Přidaná hodnota", druh: "SUM", formula: (r) => r["I."] - r["A."] },
  { code: "B.", label: "Osobní náklady", druh: "NÁKLAD" },
  { code: "C.", label: "Úpravy hodnot (odpisy)", druh: "NÁKLAD" },
  { code: "II.", label: "Ostatní provozní výnosy", druh: "VÝNOS" },
  { code: "D.", label: "Ostatní provozní náklady", druh: "NÁKLAD" },
  { code: "*P", label: "Provozní výsledek hospodaření", druh: "SUM",
    formula: (r) => (r["I."] - r["A."]) + r["II."] - r["B."] - r["C."] - r["D."] },
  { code: "III.", label: "Výnosové úroky a podobné výnosy, ostatní finanční výnosy", druh: "VÝNOS" },
  { code: "E.", label: "Nákladové úroky a podobné náklady, ostatní finanční náklady", druh: "NÁKLAD" },
  { code: "*F", label: "Finanční výsledek hospodaření", druh: "SUM", formula: (r) => r["III."] - r["E."] },
  { code: "**", label: "Výsledek hospodaření před zdaněním", druh: "SUM", formula: (r) => r["*P"] + r["*F"] },
  { code: "F2.", label: "Daň z příjmů", druh: "NÁKLAD" },
  { code: "***", label: "Výsledek hospodaření za účetní období", druh: "SUM", formula: (r) => r["**"] - r["F2."] },
];

const ACCOUNT_TO_VYSLEDOVKA_ROW = {
  "602": "I.", "604": "I.",
  "501": "A.", "502": "A.", "504": "A.", "511": "A.", "512": "A.", "513": "A.", "518": "A.",
  "521": "B.", "524": "B.", "525": "B.", "527": "B.", "528": "B.",
  "551": "C.",
  "641": "II.", "644": "II.", "648": "II.",
  "531": "D.", "538": "D.", "541": "D.", "543": "D.", "544": "D.", "545": "D.",
  "546": "D.", "548": "D.", "549": "D.",
  "662": "III.", "663": "III.", "668": "III.",
  "562": "E.", "563": "E.", "568": "E.", "569": "E.",
  "591": "F2.", "595": "F2.",
};

// Prefix fallback pro nenamapované/vlastní analytické účty (např. "518100"
// dědí mapování z "518") — jinak přesná shoda podle account_number.
function resolveRow(accountNumber, map) {
  if (map[accountNumber]) return map[accountNumber];
  for (let len = accountNumber.length - 1; len >= 3; len--) {
    const prefix = accountNumber.slice(0, len);
    if (map[prefix]) return map[prefix];
  }
  return null;
}

module.exports = {
  ROZVAHA_ROWS, ACCOUNT_TO_ROZVAHA_ROW,
  VYSLEDOVKA_ROWS, ACCOUNT_TO_VYSLEDOVKA_ROW,
  resolveRow,
};
