// =====================================================================
// bankEmailParser.js — univerzální regex parser bankovních notifikačních
// e-mailů (různé banky mají různé šablony, ale typicky obsahují řádky
// jako "Částka: 1 500,00 Kč", "VS: 123456", "Odesílatel: Firma s.r.o.").
// Cíl je MVP pokrytí nejčastějších vzorů, NE 100 % všech českých bank —
// pole, která se nepodaří rozpoznat, jsou null. Parser NIKDY nehodí chybu;
// routes/inbound-email.js pohyb i tak založí (jen s chybějícími poli),
// uživatel je doplní ručně v UI banky.
// =====================================================================

function parseAmount(text) {
  const m = text.match(/(?:částka|castka|suma|amount)\s*[:\-]?\s*([+-]?\d[\d\s.,]*)\s*(kč|czk|eur|€|usd|\$)?/i);
  if (!m) return null;
  // "1 500,00" / "1.500,00" / "1500.00" -> 1500.00. Odstraníme mezery,
  // tisícové oddělovače (tečka před skupinou 3 číslic), desetinnou čárku
  // převedeme na tečku.
  let raw = m[1].trim().replace(/\s/g, "");
  const hasComma = raw.includes(",");
  if (hasComma) {
    raw = raw.replace(/\./g, ""); // tečky = tisícový oddělovač
    raw = raw.replace(",", ".");
  }
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function parseVariableSymbol(text) {
  const m = text.match(/variabiln[íi]\s*symbol\s*[:\-]?\s*(\d{1,15})/i) || text.match(/\bvs\s*[:\-]\s*(\d{1,15})/i);
  return m ? m[1] : null;
}

function parseCounterparty(text) {
  const m = text.match(/(?:odes[íi]latel|pl[áa]tce|p[řr][íi]kazce|protistrana|sender|payer)\s*[:\-]?\s*([^\n\r]+)/i);
  return m ? m[1].trim().slice(0, 120) || null : null;
}

// Vrátí +1 (příjem/credit), -1 (výdaj/debit), nebo null (nerozpoznáno).
function parseDirection(subject, body) {
  const combined = `${subject}\n${body}`;
  if (/(příjem|přijata|došel|došla|credit|incoming|na\s+váš\s+účet)/i.test(combined)) return 1;
  if (/(výdaj|odeslána|odešl|debit|outgoing|z\s+vašeho\s+účtu|platba\s+z\s+účtu)/i.test(combined)) return -1;
  return null;
}

// parseBankEmail(subject, textBody) -> { amount, variableSymbol, counterpartyName, direction }
// amount je se znaménkem, pokud se podařilo rozpoznat i směr (+příjem/-výdaj);
// jinak je vrácena absolutní hodnota beze znaménka (uživatel/autoMatch to
// stejně ověří proti VS a částce dokladu).
function parseBankEmail(subject, textBody) {
  const combined = `${subject || ""}\n${textBody || ""}`;
  try {
    const rawAmount = parseAmount(combined);
    const direction = parseDirection(subject || "", textBody || "");
    const amount = rawAmount === null ? null : (direction !== null ? direction * Math.abs(rawAmount) : rawAmount);
    return {
      amount,
      variableSymbol: parseVariableSymbol(combined),
      counterpartyName: parseCounterparty(combined),
      direction,
    };
  } catch (err) {
    return { amount: null, variableSymbol: null, counterpartyName: null, direction: null };
  }
}

module.exports = { parseBankEmail };
