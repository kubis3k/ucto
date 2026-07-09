// =====================================================================
// app.js — jednostránková aplikace (bez build kroku). Komunikuje
// s embedded Express serverem přes fetch() na window.ucetnictvi.apiBase
// (viz preload.js). Jednoduchý hash router + innerHTML rendering
// s delegovanými event listenery (data-action / data-form atributy).
// =====================================================================

const API = window.ucetnictvi.apiBase;
let STATE = { unit: null, user: null, accounts: [], periods: [] };

// ---------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------
function authToken() { return localStorage.getItem("authToken"); }
function setAuthToken(token) { localStorage.setItem("authToken", token); }
function clearAuthToken() { localStorage.removeItem("authToken"); }

async function api(method, path, body) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function toast(message, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3800);
}

// ---------------------------------------------------------------------
// Formátování
// ---------------------------------------------------------------------
const fmtMoney = (v) => (v === null || v === undefined ? "—" :
  Number(v).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " Kč");
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString("cs-CZ") : "—");
const fmtDateTime = (v) => (v ? new Date(v).toLocaleString("cs-CZ") : "—");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayISO = () => new Date().toISOString().slice(0, 10);

// =====================================================================
// PŘIHLAŠOVÁNÍ (login / registrace firmy / BankID jednatel)
// =====================================================================
let AUTH_TAB = "login";

// Podpisový prvek přihlašovací obrazovky: kompaktní ROZVAHA, která vždy
// „sedí" — součet aktiv = součet pasiv. Vtěluje podstatu podvojného
// účetnictví (MD = D) a používá reálný kontext firmy. Po načtení se
// číslice sečtou a oba součty se zamknou na shodnou hodnotu (viz
// animateBalanceSheet). Nahrazuje dřívější ledger ticker.
const BALANCE_SHEET = {
  date: "30. 6. 2026",
  aktiva: [
    { code: "221", name: "Bankovní účet", val: 842000 },
    { code: "311", name: "Odběratelé", val: 318000 },
    { code: "022", name: "Hmotný majetek", val: 80000 },
  ],
  pasiva: [
    { code: "321", name: "Dodavatelé", val: 214000 },
    { code: "411", name: "Základní kapitál", val: 200000 },
    { code: "431", name: "Výsledek hospodaření", val: 826000 },
  ],
};
function bsRows(side) {
  return BALANCE_SHEET[side].map((r) => `
    <div class="bs-row">
      <span class="bs-code">${r.code}</span>
      <span class="bs-name">${esc(r.name)}</span>
      <span class="bs-fig" data-val="${r.val}">0</span>
    </div>`).join("");
}
function renderBalanceSheet() {
  const total = BALANCE_SHEET.aktiva.reduce((s, r) => s + r.val, 0);
  return `
    <div class="bs-card" role="img" aria-label="Ukázková rozvaha — aktiva se rovnají pasivům, ${total.toLocaleString("cs-CZ")} Kč">
      <div class="bs-head"><span>Rozvaha</span><span class="bs-date">k ${BALANCE_SHEET.date}</span></div>
      <div class="bs-cols">
        <div class="bs-col"><div class="bs-col-label">Aktiva</div>${bsRows("aktiva")}</div>
        <div class="bs-col"><div class="bs-col-label">Pasiva</div>${bsRows("pasiva")}</div>
      </div>
      <div class="bs-total">
        <span class="bs-total-side"><span class="bs-total-cap">Σ Aktiva</span><span class="bs-fig bs-total-fig" data-val="${total}">0</span></span>
        <span class="bs-eq" aria-hidden="true">=</span>
        <span class="bs-total-side"><span class="bs-total-cap">Σ Pasiva</span><span class="bs-fig bs-total-fig" data-val="${total}">0</span></span>
      </div>
      <div class="bs-balanced" id="bsBalanced">Aktiva = Pasiva · knihy sedí</div>
    </div>`;
}
function animateBalanceSheet() {
  const figs = [...document.querySelectorAll(".bs-fig")];
  if (!figs.length) return;
  const done = () => document.getElementById("bsBalanced")?.classList.add("show");
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    figs.forEach((f) => { f.textContent = Number(f.dataset.val).toLocaleString("cs-CZ"); });
    done(); return;
  }
  const dur = 900, t0 = performance.now(), ease = (t) => 1 - Math.pow(1 - t, 3);
  function frame(now) {
    const p = Math.min(1, (now - t0) / dur), k = ease(p);
    figs.forEach((f) => { f.textContent = Math.round(Number(f.dataset.val) * k).toLocaleString("cs-CZ"); });
    if (p < 1) requestAnimationFrame(frame); else done();
  }
  requestAnimationFrame(frame);
}

const EYE_PATHS = '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF_PATHS = '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 1 12s4 7 11 7a9.16 9.16 0 0 0 5.39-1.61"/><path d="M9.53 9.53a3 3 0 0 0 4.24 4.24"/><path d="M2 2l20 20"/>';
function passwordField(name, attrs = "") {
  return `<div class="auth-password-field">
    <input type="password" name="${name}" ${attrs} />
    <button type="button" class="auth-password-toggle" data-action="toggle-password" tabindex="-1" aria-label="Zobrazit heslo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${EYE_PATHS}</svg>
    </button>
  </div>`;
}

function renderAuthScreen() {
  const screen = document.getElementById("authScreen");
  screen.classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");

  const tabs = [
    ["login", "Přihlásit se"],
    ["set-password", "Nastavit heslo"],
    ["register", "Založit firmu"],
    ["bankid", "BankID"],
  ];

  screen.innerHTML = `
    <div class="auth-brand-panel">
      <div class="auth-brand-inner">
        <div class="auth-brand-top">
          <div class="brand-mark">GE</div>
          <div class="auth-brand-wordmark">Globaal Elevate<span>Účetní systém</span></div>
        </div>
        <div class="auth-hero">
          <h2>Nezávislé účetnictví.<br><em>Knihy, které vždy sedí.</em></h2>
          <p>Doklady, účetní deník, DPH i závěrka na jednom místě — průkazně a dle zákona, bez cizího softwaru.</p>
        </div>
        ${renderBalanceSheet()}
      </div>
      <div class="auth-brand-footer">
        <span class="auth-legal">Vedeno dle zákona č. 563/1991 Sb., o účetnictví</span>
        <span class="auth-links"><a href="/tos" target="_blank">Podmínky</a><span class="sep">·</span><a href="/privacy-policy" target="_blank">Soukromí</a></span>
      </div>
    </div>
    <div class="auth-form-panel">
      <div class="auth-card">
        <h1>Přihlášení</h1>
        <div class="auth-sub">Přístup je sdílený podle firmy — kolegové ve stejné firmě vidí stejná data.</div>
        <div class="auth-tabs">
          <div class="auth-tabs-indicator" id="authTabsIndicator"></div>
          ${tabs.map(([id, label]) => `<button type="button" class="${AUTH_TAB === id ? "active" : ""}" data-action="auth-tab" data-tab="${id}">${label}</button>`).join("")}
        </div>
        <div id="authTabBody"></div>
        <div class="auth-secure">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Data zůstávají u vás. Zabezpečené přihlášení.
        </div>
      </div>
    </div>
  `;
  renderAuthTabBody();
  positionAuthTabIndicator();
  animateBalanceSheet();
}

function positionAuthTabIndicator() {
  const tabsEl = document.querySelector(".auth-tabs");
  const indicator = document.getElementById("authTabsIndicator");
  const activeBtn = tabsEl?.querySelector("button.active");
  if (!tabsEl || !indicator || !activeBtn) return;
  indicator.style.width = `${activeBtn.offsetWidth}px`;
  indicator.style.transform = `translateX(${activeBtn.offsetLeft - 3}px)`;
}

function renderAuthTabBody() {
  const body = document.getElementById("authTabBody");
  if (AUTH_TAB === "login") {
    body.innerHTML = `
      <form data-form="auth-login">
        <label>E-mail</label><input type="email" name="email" autocomplete="email" required />
        <label>Heslo</label>${passwordField("password", 'autocomplete="current-password" required')}
        <div class="form-actions"><button type="submit">Přihlásit se</button></div>
      </form>
      <div id="authError" class="auth-error"></div>
    `;
  } else if (AUTH_TAB === "set-password") {
    body.innerHTML = `
      <p class="auth-hint">Pro účty vytvořené před zavedením přihlašování (např. původní uživatel "Luigi") — nastavte si heslo poprvé podle e-mailu, na který byl účet založen.</p>
      <form data-form="auth-set-password">
        <label>E-mail</label><input type="email" name="email" autocomplete="email" required />
        <label>Nové heslo (min. 8 znaků)</label>${passwordField("password", 'autocomplete="new-password" minlength="8" required')}
        <div class="form-actions"><button type="submit">Nastavit heslo a přihlásit</button></div>
      </form>
      <div id="authError" class="auth-error"></div>
    `;
  } else if (AUTH_TAB === "register") {
    body.innerHTML = `
      <form data-form="auth-register-company">
        <label>Název firmy</label><input type="text" name="company_name" required />
        <label>IČO</label><input type="text" name="ico" required />
        <label>DIČ (nepovinné)</label><input type="text" name="dic" />
        <label>Vaše jméno</label><input type="text" name="full_name" required />
        <label>E-mail</label><input type="email" name="email" autocomplete="email" required />
        <label>Heslo (min. 8 znaků)</label>${passwordField("password", 'autocomplete="new-password" minlength="8" required')}
        <div class="form-actions"><button type="submit">Založit firmu</button></div>
      </form>
      <div id="authError" class="auth-error"></div>
    `;
  } else if (AUTH_TAB === "bankid") {
    body.innerHTML = `
      <p class="auth-hint">Ověření je nyní v testovacím (mock) režimu — po zadání IČO vyberte své jméno ze seznamu jednatelů firmy podle rejstříku.</p>
      <form data-form="auth-bankid-start">
        <label>IČO firmy</label><input type="text" name="ico" required />
        <div class="form-actions"><button type="submit">Pokračovat</button></div>
      </form>
      <div id="bankidStep2"></div>
      <div id="authError" class="auth-error"></div>
    `;
  }
}

async function handleAuthLogin(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const { token } = await api("POST", "/auth/login", body);
    setAuthToken(token);
    checkAuthAndStart();
  } catch (err) {
    document.getElementById("authError").textContent = err.message;
  }
}

async function handleAuthSetPassword(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const { token } = await api("POST", "/auth/set-password", body);
    setAuthToken(token);
    checkAuthAndStart();
  } catch (err) {
    document.getElementById("authError").textContent = err.message;
  }
}

async function handleAuthRegisterCompany(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const { token } = await api("POST", "/auth/register-company", body);
    setAuthToken(token);
    checkAuthAndStart();
  } catch (err) {
    document.getElementById("authError").textContent = err.message;
  }
}

async function handleAuthBankidStart(form) {
  const { ico } = Object.fromEntries(new FormData(form).entries());
  const errBox = document.getElementById("authError");
  errBox.textContent = "";
  try {
    const data = await api("POST", "/auth/bankid/start", { ico });
    if (data.mode === "live") {
      window.location.href = data.redirect; // celostránkový přesměrování na skutečné BankID přihlášení
      return;
    }
    document.getElementById("bankidStep2").innerHTML = `
      <form data-form="auth-bankid-callback" data-unit-id="${data.accounting_unit_id}">
        <label>Firma: ${esc(data.company_name)} — vyberte své jméno</label>
        <div class="auth-directors">
          ${data.directors.map((name, i) => `<label><input type="radio" name="full_name" value="${esc(name)}" ${i === 0 ? "checked" : ""} required /> ${esc(name)}</label>`).join("")}
        </div>
        <label>E-mail (jen při prvním přihlášení)</label><input type="email" name="email" />
        <div class="form-actions"><button type="submit">Přihlásit se jako jednatel</button></div>
      </form>
    `;
  } catch (err) {
    errBox.textContent = err.message;
  }
}

async function handleAuthBankidCallback(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  body.accounting_unit_id = Number(form.dataset.unitId);
  try {
    const { token } = await api("POST", "/auth/bankid/callback", body);
    setAuthToken(token);
    checkAuthAndStart();
  } catch (err) {
    document.getElementById("authError").textContent = err.message;
  }
}

function renderAcceptInviteScreen(token) {
  const screen = document.getElementById("authScreen");
  screen.classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  screen.innerHTML = `
    <div class="auth-form-panel" style="width:100%">
      <div class="auth-card">
        <h1>Přijetí pozvánky</h1>
        <div class="auth-sub">Nastavte si jméno a heslo pro sdílený přístup k firmě.</div>
        <form data-form="accept-invite" data-token="${esc(token)}">
          <label>Vaše jméno</label><input type="text" name="full_name" required />
          <label>Heslo (min. 8 znaků)</label>${passwordField("password", 'autocomplete="new-password" minlength="8" required')}
          <div class="form-actions"><button type="submit">Přijmout pozvánku</button></div>
        </form>
        <div id="authError" class="auth-error"></div>
      </div>
    </div>
  `;
}

async function handleAcceptInvite(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  body.token = form.dataset.token;
  try {
    const { token } = await api("POST", "/auth/accept-invite", body);
    setAuthToken(token);
    location.hash = "";
    checkAuthAndStart();
  } catch (err) {
    document.getElementById("authError").textContent = err.message;
  }
}

async function handleLogout() {
  await api("POST", "/auth/logout");
  clearAuthToken();
  location.reload();
}

const DOC_TYPE_LABEL = {
  faktura_vydana: "Faktura vydaná", faktura_prijata: "Faktura přijatá",
  pokladni_prijem: "Pokladní příjem", pokladni_vydej: "Pokladní výdej",
  bankovni_pohyb: "Bankovní pohyb", interni_doklad: "Interní doklad",
};
const ACCOUNT_TYPE_LABEL = {
  rozvahovy_aktivni: "Rozvahový (aktivní)", rozvahovy_pasivni: "Rozvahový (pasivní)",
  vysledkovy_naklad: "Výsledkový (náklad)", vysledkovy_vynos: "Výsledkový (výnos)",
  zaverkovy: "Závěrkový", podrozvahovy: "Podrozvahový",
};

function accountOptions(selectedId) {
  return STATE.accounts.map((a) =>
    `<option value="${a.id}" ${String(a.id) === String(selectedId) ? "selected" : ""}>${esc(a.account_number)} — ${esc(a.name)}</option>`
  ).join("");
}
function periodOptions(selectedId) {
  return STATE.periods.map((p) =>
    `<option value="${p.id}" ${String(p.id) === String(selectedId) ? "selected" : ""}>${p.fiscal_year} (${p.status})</option>`
  ).join("");
}
function currentOpenPeriod() {
  return STATE.periods.find((p) => p.status === "otevrene") || STATE.periods[0];
}

// ---------------------------------------------------------------------
// Navigace
// ---------------------------------------------------------------------

// Sada SVG ikon (styl Lucide, stroke 1.75) — nahrazuje dřívější unicode
// glyfy. Vektorové ikony jsou konzistentní napříč platformami a laditelné
// přes CSS (viz doporučení UI/UX rešerše: žádné emoji/glyfy jako ikony).
const ICONS = {
  dashboard: '<path d="M3 3h8v8H3z"/><path d="M13 3h8v5h-8z"/><path d="M13 12h8v9h-8z"/><path d="M3 15h8v6H3z"/>',
  documents: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/>',
  journal: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/><path d="M8 5v14"/>',
  ledger: '<path d="M3 3v18h18"/><path d="M7 15l3-3 3 2 4-5"/>',
  accounts: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/><path d="M9 3v18"/>',
  templates: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  contacts: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  projects: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v9"/><path d="M19 10v9"/><path d="M9 10v9"/><path d="M15 10v9"/><path d="M3 21h18"/>',
  assets: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  reports: '<path d="M9 17V9"/><path d="M13 17V5"/><path d="M17 17v-6"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  vat: '<path d="M19 5L5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
  inventory: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  auditlog: '<path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
};
function navIcon(id) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ""}</svg>`;
}

const NAV = [
  { group: "Přehled", items: [
    { id: "dashboard", label: "Dashboard", icon: "◆", title: "Dashboard" },
  ]},
  { group: "Účetnictví", items: [
    { id: "documents", label: "Doklady", icon: "▤", title: "Doklady" },
    { id: "journal", label: "Účetní deník", icon: "≣", title: "Účetní deník" },
    { id: "ledger", label: "Hlavní kniha", icon: "▥", title: "Hlavní kniha" },
    { id: "accounts", label: "Účtový rozvrh", icon: "#", title: "Účtový rozvrh" },
    { id: "templates", label: "Předkontace", icon: "⎘", title: "Předkontace (šablony zaúčtování)" },
  ]},
  { group: "Evidence", items: [
    { id: "contacts", label: "Kontakty", icon: "◐", title: "Kontakty" },
    { id: "projects", label: "Projekty / zakázky", icon: "◈", title: "Projekty a zakázky" },
    { id: "bank", label: "Banka a pokladna", icon: "$", title: "Banka a pokladna" },
    { id: "assets", label: "Majetek", icon: "▦", title: "Dlouhodobý majetek" },
  ]},
  { group: "Výstupy", items: [
    { id: "reports", label: "Výkazy", icon: "▧", title: "Účetní výkazy" },
    { id: "vat", label: "DPH", icon: "%", title: "Modul DPH" },
    { id: "inventory", label: "Inventarizace", icon: "✓", title: "Inventarizace a uzávěrka" },
  ]},
  { group: "Správa", items: [
    { id: "auditlog", label: "Audit log", icon: "⌘", title: "Audit log" },
    { id: "settings", label: "Nastavení", icon: "⚙", title: "Nastavení účetní jednotky" },
    { id: "help", label: "Nápověda", icon: "?", title: "Nápověda a návod k použití" },
  ]},
];

function renderNav(active) {
  const nav = document.getElementById("nav");
  nav.innerHTML = NAV.map((g) => `
    <div class="nav-group-label">${g.group}</div>
    ${g.items.map((it) => `
      <div class="nav-item ${it.id === active ? "active" : ""}" data-nav="${it.id}">
        <span class="nav-icon">${navIcon(it.id)}</span><span>${it.label}</span>
      </div>`).join("")}
  `).join("");
}

const VIEWS = {
  dashboard: renderDashboard,
  documents: renderDocuments,
  journal: renderJournal,
  ledger: renderLedger,
  accounts: renderAccounts,
  templates: renderTemplates,
  contacts: renderContacts,
  projects: renderProjects,
  bank: renderBank,
  assets: renderAssets,
  reports: renderReports,
  vat: renderVat,
  inventory: renderInventory,
  auditlog: renderAuditLog,
  settings: renderSettings,
  help: renderHelp,
};
const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items).map((i) => [i.id, i.title]));

async function router() {
  const id = (location.hash.slice(1) || "dashboard").split("?")[0];
  const view = VIEWS[id] ? id : "dashboard";
  renderNav(view);
  document.getElementById("pageTitle").textContent = TITLES[view];
  document.getElementById("topbarActions").innerHTML = "";
  document.getElementById("view").innerHTML = `<div class="empty-state">Načítám…</div>`;
  try {
    await VIEWS[view]();
  } catch (err) {
    document.getElementById("view").innerHTML = `<div class="panel"><h2>Chyba</h2><p>${esc(err.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------
// Bootstrapping — načtení jednotky, uživatele, DPH badge
// ---------------------------------------------------------------------
async function bootstrap() {
  const units = await api("GET", "/units");
  STATE.unit = units[0];
  STATE.user = STATE.authUser;
  STATE.accounts = await api("GET", `/accounts?unit=${STATE.unit.id}`);
  STATE.periods = await api("GET", `/periods?unit=${STATE.unit.id}`);
  updateVatBadge();
  const whoAmI = document.getElementById("whoAmI");
  if (whoAmI) whoAmI.innerHTML = `${esc(STATE.user.full_name)} <a href="#" data-action="logout" style="color:var(--text-faint)">(odhlásit)</a>`;
}

function updateVatBadge() {
  const badge = document.getElementById("vatBadge");
  if (STATE.unit.is_vat_payer) {
    badge.textContent = "DPH: Plátce od " + fmtDate(STATE.unit.vat_payer_since);
    badge.classList.add("on");
  } else {
    badge.textContent = "DPH: Neplátce";
    badge.classList.remove("on");
  }
}

async function refreshCoreState() {
  STATE.accounts = await api("GET", `/accounts?unit=${STATE.unit.id}`);
  STATE.periods = await api("GET", `/periods?unit=${STATE.unit.id}`);
}

// =====================================================================
// DASHBOARD
// =====================================================================
async function renderDashboard() {
  const unit = STATE.unit.id;
  const [obrat, pohledavky, docs, log] = await Promise.all([
    api("GET", `/reports/obrat-dph?unit=${unit}`),
    api("GET", `/reports/pohledavky-zavazky?unit=${unit}`),
    api("GET", `/documents?unit=${unit}&status=koncept`),
    api("GET", `/audit-log?unit=${unit}&limit=8`),
  ]);
  const overdue = pohledavky.filter((p) => p.dni_po_splatnosti > 0);

  document.getElementById("view").innerHTML = `
    <div class="kpi-grid">
      <div class="kpi ${obrat.blizi_se_limitu_dph ? "bad" : ""}">
        <div class="label">Obrat za 12 měsíců</div>
        <div class="value">${fmtMoney(obrat.obrat_12m)}</div>
        <div class="sub">${obrat.blizi_se_limitu_dph ? "Limit 2 mil. Kč pro DPH dosažen!" : `Zbývá ${fmtMoney(obrat.zbyva_do_limitu)} do limitu DPH`}</div>
      </div>
      <div class="kpi ${docs.length ? "warn" : "good"}">
        <div class="label">Doklady v konceptu</div>
        <div class="value">${docs.length}</div>
        <div class="sub">čekají na schválení a zaúčtování</div>
      </div>
      <div class="kpi ${overdue.length ? "bad" : "good"}">
        <div class="label">Po splatnosti</div>
        <div class="value">${overdue.length}</div>
        <div class="sub">z ${pohledavky.length} otevřených pohledávek/závazků</div>
      </div>
      <div class="kpi">
        <div class="label">Účetní jednotka</div>
        <div class="value" style="font-size:16px">${esc(STATE.unit.name)}</div>
        <div class="sub">${STATE.unit.unit_category} · ${STATE.unit.accounting_mode.replace("_"," ")}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h2>Otevřené pohledávky a závazky</h2>
        ${tableOrEmpty(pohledavky.slice(0, 8), [
          ["Doklad", (r) => `${DOC_TYPE_LABEL[r.doc_type]} ${esc(r.doc_number)}`],
          ["Protistrana", (r) => esc(r.protistrana || "—")],
          ["Splatnost", (r) => fmtDate(r.due_date)],
          ["Částka", (r) => fmtMoney(r.total_amount), "num"],
          ["Po splatnosti", (r) => r.dni_po_splatnosti > 0 ? `${r.dni_po_splatnosti} dní` : "ne", "num"],
        ])}
      </div>
      <div class="panel">
        <h2>Poslední aktivita (audit log)</h2>
        ${tableOrEmpty(log, [
          ["Kdy", (r) => fmtDateTime(r.occurred_at)],
          ["Akce", (r) => esc(r.action)],
          ["Tabulka", (r) => esc(r.entity_table)],
          ["ID", (r) => r.entity_id ?? "—"],
        ])}
      </div>
    </div>
  `;
}

function tableOrEmpty(rows, columns) {
  if (!rows.length) return `<div class="empty-state">Žádná data.</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr>${columns.map((c) => `<th class="${c[2] || ""}">${c[0]}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="${c[2] || ""}">${c[1](r)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

// =====================================================================
// DOKLADY
// =====================================================================
let docFilter = { status: "", docType: "" };

async function renderDocuments() {
  const unit = STATE.unit.id;
  const qs = new URLSearchParams({ unit });
  if (docFilter.status) qs.set("status", docFilter.status);
  if (docFilter.docType) qs.set("docType", docFilter.docType);
  const docs = await api("GET", `/documents?${qs}`);
  const [contacts, projects, templates] = await Promise.all([
    api("GET", `/contacts?unit=${unit}`),
    api("GET", `/projects?unit=${unit}`),
    api("GET", `/templates?unit=${unit}`),
  ]);
  STATE._contacts = contacts;
  STATE._projects = projects;
  STATE._templates = templates;

  document.getElementById("topbarActions").innerHTML = `<button data-action="new-document">+ Nový doklad</button>`;

  document.getElementById("view").innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <select id="fType"><option value="">Všechny typy</option>${Object.entries(DOC_TYPE_LABEL).map(([k,v]) => `<option value="${k}" ${docFilter.docType===k?"selected":""}>${v}</option>`).join("")}</select>
        <select id="fStatus"><option value="">Všechny stavy</option>${["koncept","schvaleny","zauctovany","stornovany"].map((s) => `<option value="${s}" ${docFilter.status===s?"selected":""}>${s}</option>`).join("")}</select>
        <div class="spacer"></div>
        <span class="text-dim">${docs.length} dokladů</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Číslo</th><th>Typ</th><th>Popis</th><th>Kontakt</th><th>Vyhotoveno</th><th class="num">Částka</th><th>Stav</th><th></th></tr></thead>
        <tbody>${docs.length ? docs.map((d) => `
          <tr>
            <td class="mono">${esc(d.doc_number)}</td>
            <td>${DOC_TYPE_LABEL[d.doc_type]}</td>
            <td>${esc(d.description)}</td>
            <td>${esc(contacts.find((c) => c.id === d.contact_id)?.name || "—")}</td>
            <td>${fmtDate(d.issue_date)}</td>
            <td class="num">${fmtMoney(d.total_amount)}</td>
            <td><span class="badge ${d.status}">${d.status}</span></td>
            <td>
              <button class="small secondary" data-action="doc-detail" data-id="${d.id}">Detail / QR</button>
              ${d.status === "koncept" ? `<button class="small" data-action="approve-doc" data-id="${d.id}">Schválit</button>` : ""}
              ${(d.status === "schvaleny" || d.status === "koncept") ? `<button class="small" data-action="post-doc" data-id="${d.id}">Zaúčtovat</button>` : ""}
              ${d.status !== "stornovany" ? `<button class="small danger" data-action="storno-doc" data-id="${d.id}">Storno</button>` : ""}
            </td>
          </tr>`).join("") : `<tr><td colspan="8" class="empty-state">Žádné doklady neodpovídají filtru.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;

  document.getElementById("fType").onchange = (e) => { docFilter.docType = e.target.value; renderDocuments(); };
  document.getElementById("fStatus").onchange = (e) => { docFilter.status = e.target.value; renderDocuments(); };
}

function documentFormModal() {
  const period = currentOpenPeriod();
  showModal(`
    <h2>Nový doklad</h2>
    <form data-form="create-document">
      <div class="form-grid">
        <div><label>Typ dokladu</label>
          <select name="doc_type">${Object.entries(DOC_TYPE_LABEL).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        </div>
        <div><label>Kontakt</label>
          <select name="contact_id"><option value="">—</option>${STATE._contacts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        </div>
        <div><label>Projekt/zakázka</label>
          <select name="project_id"><option value="">—</option>${(STATE._projects||[]).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>
        </div>
        <div><label>Účetní období</label><select name="period_id">${periodOptions(period?.id)}</select></div>
        <div><label>Datum vyhotovení</label><input type="date" name="issue_date" value="${todayISO()}" required /></div>
        <div><label>DUZP (datum uskutečnění)</label><input type="date" name="taxable_supply_date" /></div>
        <div><label>Splatnost</label><input type="date" name="due_date" /></div>
        <div><label>Variabilní symbol</label><input type="text" name="variable_symbol" /></div>
        <div><label>Celková částka (Kč)</label><input type="number" step="0.01" name="total_amount" required /></div>
      </div>
      <label>Popis / obsah účetního případu</label>
      <textarea name="description" rows="2" required></textarea>

      <label style="margin-top:16px"><input type="checkbox" name="is_vat_document" style="width:auto;display:inline-block;margin-right:6px" /> Daňový doklad (DPH pole)</label>
      <div class="form-grid">
        <div><label>Základ daně</label><input type="number" step="0.01" name="vat_base_amount" /></div>
        <div><label>Sazba DPH (%)</label><input type="number" step="0.01" name="vat_rate" value="21" /></div>
        <div><label>Výše DPH</label><input type="number" step="0.01" name="vat_amount" /></div>
        <div><label>DIČ protistrany</label><input type="text" name="counterparty_dic" /></div>
      </div>

      <div class="form-actions">
        <button type="submit">Vytvořit koncept</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

async function handleCreateDocument(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.accounting_unit_id = STATE.unit.id;
  body.responsible_user_id = STATE.user.id;
  body.is_vat_document = fd.get("is_vat_document") === "on";
  body.total_amount = Number(body.total_amount);
  ["vat_base_amount", "vat_rate", "vat_amount"].forEach((k) => { if (body[k]) body[k] = Number(body[k]); });
  await api("POST", "/documents", body);
  toast("Doklad byl vytvořen jako koncept.");
  closeModal();
  renderDocuments();
}

// Detail dokladu + QR platba (SPD). Tlačítko "Tisk" otevře systémový dialog tisku.
async function showDocumentDetail(id) {
  const doc = await api("GET", `/documents/${id}`);
  const contact = STATE._contacts?.find((c) => c.id === doc.contact_id);
  showModal(`
    <h2>${DOC_TYPE_LABEL[doc.doc_type]} ${esc(doc.doc_number)}</h2>
    <div class="two-col" style="gap:24px">
      <div>
        <table>
          <tr><td class="text-dim">Stav</td><td><span class="badge ${doc.status}">${doc.status}</span></td></tr>
          <tr><td class="text-dim">Kontakt</td><td>${esc(contact?.name || "—")}</td></tr>
          <tr><td class="text-dim">Vyhotoveno</td><td>${fmtDate(doc.issue_date)}</td></tr>
          <tr><td class="text-dim">DUZP</td><td>${fmtDate(doc.taxable_supply_date)}</td></tr>
          <tr><td class="text-dim">Splatnost</td><td>${fmtDate(doc.due_date)}</td></tr>
          <tr><td class="text-dim">Variabilní symbol</td><td class="mono">${esc(doc.variable_symbol || "—")}</td></tr>
          <tr><td class="text-dim">Popis</td><td>${esc(doc.description)}</td></tr>
          <tr><td class="text-dim">Celkem</td><td><strong>${fmtMoney(doc.total_amount)}</strong></td></tr>
          ${doc.is_vat_document ? `<tr><td class="text-dim">Základ / DPH</td><td>${fmtMoney(doc.vat_base_amount)} / ${fmtMoney(doc.vat_amount)} (${doc.vat_rate}%)</td></tr>` : ""}
        </table>
      </div>
      <div id="qrBox" style="text-align:center">
        <div class="text-dim" style="font-size:12px;margin-bottom:6px">QR platba</div>
        <div id="qrTarget"><button class="secondary small" data-action="load-qr" data-id="${doc.id}">Zobrazit QR platbu</button></div>
      </div>
    </div>
    <div style="margin-top:18px">
      <div class="text-dim" style="font-size:12px;margin-bottom:6px">Přílohy (PDF, CSV)</div>
      <form data-form="upload-attachment" data-doc-id="${doc.id}" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input type="file" name="file" accept=".pdf,.csv,application/pdf,text/csv,application/vnd.ms-excel" required />
        <button type="submit" class="secondary small">Nahrát</button>
      </form>
      <div id="attachmentsList">Načítám…</div>
    </div>
    <div class="form-actions">
      <button class="secondary" onclick="window.print()">Tisk</button>
      <button class="secondary" data-action="close-modal">Zavřít</button>
    </div>
  `);
  loadDocumentAttachments(doc.id);
}

async function loadDocumentAttachments(docId) {
  const target = document.getElementById("attachmentsList");
  if (!target) return;
  try {
    const attachments = await api("GET", `/documents/${docId}/attachments`);
    target.innerHTML = attachments.length
      ? `<ul style="margin:0;padding-left:18px">${attachments.map((a) => `
          <li><a href="${API}/documents/attachments/${a.id}/download">${esc(a.file_name)}</a>
            <span class="text-dim" style="font-size:11px">(${(a.size_bytes / 1024).toFixed(0)} kB, ${fmtDate(a.uploaded_at)})</span></li>`).join("")}</ul>`
      : `<span class="text-dim" style="font-size:12px">Zatím žádné přílohy.</span>`;
  } catch (err) {
    target.innerHTML = `<span class="text-dim" style="font-size:12px">${esc(err.message)}</span>`;
  }
}

async function handleUploadAttachment(form) {
  const docId = form.dataset.docId;
  const fd = new FormData(form);
  const headers = {};
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/documents/${docId}/attachments`, { method: "POST", headers, body: fd });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  form.reset();
  toast("Příloha byla nahrána.");
  loadDocumentAttachments(docId);
}

async function loadDocumentQr(id) {
  const target = document.getElementById("qrTarget");
  target.innerHTML = `<span class="text-dim">Generuji…</span>`;
  try {
    const { svg, spayd } = await api("GET", `/documents/${id}/qr`);
    target.innerHTML = `<div style="background:#fff;padding:10px;border-radius:8px;display:inline-block">${svg}</div>
      <div class="text-dim mono" style="font-size:9px;margin-top:6px;max-width:220px;word-break:break-all">${esc(spayd)}</div>`;
  } catch (err) {
    target.innerHTML = `<span class="text-dim" style="font-size:12px">${esc(err.message)}</span>`;
  }
}

// Zaúčtování dokladu podle předkontace (jedním kliknutím). Nabídne šablony
// odpovídající typu dokladu (nebo všechny) a po výběru vytvoří vyrovnaný zápis.
async function postDocumentModal(id) {
  const doc = await api("GET", `/documents/${id}`);
  const templates = STATE._templates || (await api("GET", `/templates?unit=${STATE.unit.id}`));
  const relevant = templates.filter((t) => !t.doc_type || t.doc_type === doc.doc_type);
  const list = relevant.length ? relevant : templates;
  showModal(`
    <h2>Zaúčtovat doklad ${esc(doc.doc_number)}</h2>
    <p class="text-dim">Vyberte předkontaci — účetní zápis se vytvoří automaticky z částek dokladu (celkem ${fmtMoney(doc.total_amount)}).</p>
    <form data-form="post-document" data-doc-id="${doc.id}">
      <label>Předkontace</label>
      <select name="template_id" required>
        ${list.map((t) => `<option value="${t.id}">${esc(t.name)} — ${t.lines.map((l) => l.account_number + " " + l.side).join(", ")}</option>`).join("")}
      </select>
      <p class="text-dim" style="font-size:12px;margin-top:8px">Chybí vhodná šablona? Vytvořte ji v sekci <strong>Předkontace</strong>, nebo použijte ruční zápis v Účetním deníku.</p>
      <div class="form-actions">
        <button type="submit">Zaúčtovat</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

async function handlePostDocument(form) {
  const docId = form.dataset.docId;
  const templateId = new FormData(form).get("template_id");
  await api("POST", `/documents/${docId}/post`, { template_id: templateId, created_by: STATE.user.id });
  toast("Doklad byl zaúčtován podle předkontace.");
  closeModal();
  renderDocuments();
}

// =====================================================================
// PŘEDKONTACE (šablony zaúčtování)
// =====================================================================
async function renderTemplates() {
  const unit = STATE.unit.id;
  const [templates] = await Promise.all([api("GET", `/templates?unit=${unit}`)]);
  await refreshCoreState();
  document.getElementById("topbarActions").innerHTML = `<button data-action="new-template">+ Nová předkontace</button>`;

  const srcLabel = { celkem: "celková částka", zaklad: "základ DPH", dph: "výše DPH" };
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <p class="text-dim" style="margin-top:0">Šablony pro rychlé a konzistentní zaúčtování opakujících se případů (pronájmy, honoráře, vstupenky). Při zaúčtování dokladu stačí vybrat předkontaci — zápis se vytvoří automaticky. Inspirováno předkontacemi v Pohodě a Money S3.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Název</th><th>Typ dokladu</th><th>Zaúčtování</th><th></th></tr></thead>
        <tbody>${templates.length ? templates.map((t) => `
          <tr>
            <td>${esc(t.name)}${t.description ? `<div class="text-dim" style="font-size:11px">${esc(t.description)}</div>` : ""}</td>
            <td>${t.doc_type ? DOC_TYPE_LABEL[t.doc_type] : "—"}</td>
            <td class="mono" style="font-size:12px">${t.lines.map((l) => `${l.side} ${l.account_number} (${srcLabel[l.amount_source]})`).join(" · ")}</td>
            <td><button class="small danger" data-action="delete-template" data-id="${t.id}">Smazat</button></td>
          </tr>`).join("") : `<tr><td colspan="4" class="empty-state">Zatím žádné předkontace.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
}

let tplLineCount = 0;
function templateFormModal() {
  tplLineCount = 0;
  showModal(`
    <h2>Nová předkontace</h2>
    <form data-form="create-template">
      <div class="form-grid">
        <div><label>Název</label><input type="text" name="name" required placeholder="např. Přijatá faktura — pronájem" /></div>
        <div><label>Typ dokladu (volitelné)</label>
          <select name="doc_type"><option value="">Všechny typy</option>${Object.entries(DOC_TYPE_LABEL).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        </div>
      </div>
      <label>Popis</label><input type="text" name="description" />
      <label style="margin-top:14px">Řádky (MD musí = D podle zvolených částek)</label>
      <div id="tplLines"></div>
      <button type="button" class="secondary small" data-action="add-template-line" style="margin-top:8px">+ Přidat řádek</button>
      <div class="form-actions">
        <button type="submit">Vytvořit</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
  addTemplateLineRow(); addTemplateLineRow();
}

function addTemplateLineRow() {
  const wrap = document.getElementById("tplLines");
  const row = document.createElement("div");
  row.className = "form-grid";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <div><select class="tpl-account">${accountOptions()}</select></div>
    <div><select class="tpl-side"><option value="MD">MD (Má dáti)</option><option value="D">D (Dal)</option></select></div>
    <div><select class="tpl-source"><option value="celkem">celková částka</option><option value="zaklad">základ DPH</option><option value="dph">výše DPH</option></select></div>
  `;
  wrap.appendChild(row);
}

async function handleCreateTemplate(form) {
  const fd = new FormData(form);
  const lines = [...document.querySelectorAll("#tplLines > div")].map((row) => ({
    account_id: row.querySelector(".tpl-account").value,
    side: row.querySelector(".tpl-side").value,
    amount_source: row.querySelector(".tpl-source").value,
  }));
  await api("POST", "/templates", {
    accounting_unit_id: STATE.unit.id,
    name: fd.get("name"),
    doc_type: fd.get("doc_type") || null,
    description: fd.get("description"),
    lines,
  });
  toast("Předkontace byla vytvořena.");
  closeModal();
  renderTemplates();
}

// =====================================================================
// ÚČETNÍ DENÍK
// =====================================================================
async function renderJournal() {
  const unit = STATE.unit.id;
  const postings = await api("GET", `/postings?unit=${unit}`);
  document.getElementById("topbarActions").innerHTML = `<button data-action="new-posting">+ Ruční zápis</button>`;
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <p class="text-dim" style="margin-top:0">Chronologický, needitovatelný seznam všech účetních zápisů (§ 33a zákona o účetnictví). Opravu lze provést pouze stornovacím zápisem.</p>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">Č.</th><th>Datum</th><th>Popis</th><th></th></tr></thead>
        <tbody>${postings.length ? postings.map((p) => `
          <tr>
            <td class="num mono">${p.posting_number}</td>
            <td>${fmtDate(p.posting_date)}</td>
            <td>${esc(p.description)}${p.storno_of_posting_id ? ` <span class="badge stornovany">storno #${p.storno_of_posting_id}</span>` : ""}</td>
            <td>
              <button class="small secondary" data-action="view-posting" data-id="${p.id}">Detail</button>
              ${!p.storno_of_posting_id ? `<button class="small danger" data-action="storno-posting" data-id="${p.id}">Storno</button>` : ""}
            </td>
          </tr>`).join("") : `<tr><td colspan="4" class="empty-state">Zatím žádné účetní zápisy.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
}

async function showPostingDetail(id) {
  const p = await api("GET", `/postings/${id}`);
  showModal(`
    <h2>Účetní zápis č. ${p.posting_number}</h2>
    <p class="text-dim">${fmtDate(p.posting_date)} — ${esc(p.description)}</p>
    <table>
      <thead><tr><th>Účet</th><th>MD</th><th>D</th></tr></thead>
      <tbody>${p.lines.map((l) => `
        <tr><td>${esc(l.account_number)} — ${esc(l.account_name)}</td>
        <td class="num">${l.side === "MD" ? fmtMoney(l.amount) : ""}</td>
        <td class="num">${l.side === "D" ? fmtMoney(l.amount) : ""}</td></tr>`).join("")}
      </tbody>
    </table>
    <div class="form-actions"><button class="secondary" data-action="close-modal">Zavřít</button></div>
  `);
}

function postingFormModal() {
  const period = currentOpenPeriod();
  showModal(`
    <h2>Nový účetní zápis</h2>
    <form data-form="create-posting">
      <div class="form-grid">
        <div><label>Účetní období</label><select name="period_id">${periodOptions(period?.id)}</select></div>
        <div><label>Datum zaúčtování</label><input type="date" name="posting_date" value="${todayISO()}" required /></div>
      </div>
      <label>Popis účetního případu</label><input type="text" name="description" required />
      <label style="margin-top:14px">Řádky zápisu (MD musí = D)</label>
      <div id="postingLines" class="line-items-table"></div>
      <button type="button" class="secondary small" data-action="add-posting-line" style="margin-top:8px">+ Přidat řádek</button>
      <div class="form-actions">
        <button type="submit">Zaúčtovat</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
  addPostingLineRow(); addPostingLineRow();
}

function addPostingLineRow() {
  const wrap = document.getElementById("postingLines");
  const row = document.createElement("div");
  row.className = "form-grid";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <div><select class="pl-account">${accountOptions()}</select></div>
    <div><select class="pl-side"><option value="MD">MD (Má dáti)</option><option value="D">D (Dal)</option></select></div>
    <div><input type="number" step="0.01" class="pl-amount" placeholder="Částka" /></div>
  `;
  wrap.appendChild(row);
}

async function handleCreatePosting(form) {
  const fd = new FormData(form);
  const lines = [...document.querySelectorAll("#postingLines > div")].map((row) => ({
    account_id: row.querySelector(".pl-account").value,
    side: row.querySelector(".pl-side").value,
    amount: Number(row.querySelector(".pl-amount").value),
  })).filter((l) => l.amount > 0);

  await api("POST", "/postings", {
    accounting_unit_id: STATE.unit.id,
    period_id: fd.get("period_id"),
    posting_date: fd.get("posting_date"),
    description: fd.get("description"),
    created_by: STATE.user.id,
    lines,
  });
  toast("Účetní zápis byl zaúčtován.");
  closeModal();
  renderJournal();
}

// =====================================================================
// HLAVNÍ KNIHA
// =====================================================================
async function renderLedger() {
  const unit = STATE.unit.id;
  const asOf = document.getElementById("ledgerAsOf")?.value || todayISO();
  const rows = await api("GET", `/reports/hlavni-kniha?unit=${unit}&asOf=${asOf}`);

  const grouped = {};
  for (const r of rows) {
    grouped[r.account_number] = grouped[r.account_number] || { name: r.account_name, rows: [] };
    grouped[r.account_number].rows.push(r);
  }

  document.getElementById("topbarActions").innerHTML = `
    <a class="btn secondary" style="text-decoration:none;display:inline-block" href="${API}/export/hlavni-kniha?unit=${unit}&asOf=${asOf}" target="_blank">Export CSV</a>`;

  document.getElementById("view").innerHTML = `
    <div class="panel">
      <div class="toolbar"><label style="margin:0">Ke dni</label><input type="date" id="ledgerAsOf" value="${asOf}" style="width:auto" /></div>
    </div>
    ${Object.keys(grouped).length ? Object.entries(grouped).map(([num, g]) => `
      <div class="panel">
        <h2>${num} — ${esc(g.name)}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Datum</th><th class="num">Č. zápisu</th><th>Popis</th><th class="num">MD</th><th class="num">D</th><th class="num">Zůstatek</th></tr></thead>
          <tbody>${g.rows.map((r) => `
            <tr><td>${fmtDate(r.posting_date)}</td><td class="num mono">${r.posting_number}</td><td>${esc(r.description)}</td>
              <td class="num">${r.md_amount ? fmtMoney(r.md_amount) : ""}</td>
              <td class="num">${r.d_amount ? fmtMoney(r.d_amount) : ""}</td>
              <td class="num mono">${fmtMoney(r.running_balance)}</td></tr>`).join("")}
          </tbody>
        </table></div>
      </div>
    `).join("") : `<div class="panel"><div class="empty-state">Žádné zaúčtované pohyby k tomuto datu.</div></div>`}
  `;
  document.getElementById("ledgerAsOf").onchange = renderLedger;
}

// =====================================================================
// ÚČTOVÝ ROZVRH
// =====================================================================
async function renderAccounts() {
  await refreshCoreState();
  document.getElementById("topbarActions").innerHTML = `<button data-action="new-account">+ Nový účet</button>`;
  const sorted = [...STATE.accounts].sort((a, b) => a.account_number.localeCompare(b.account_number));
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <p class="text-dim" style="margin-top:0">Konfigurace syntetických a analytických účtů podle směrné účtové osnovy (příloha č. 4 vyhl. 500/2002 Sb.).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Číslo</th><th>Název</th><th>Třída</th><th>Typ</th><th>Nadřazený účet</th></tr></thead>
        <tbody>${sorted.map((a) => `
          <tr><td class="mono">${esc(a.account_number)}</td><td>${esc(a.name)}</td><td class="num">${a.account_class}</td>
            <td>${ACCOUNT_TYPE_LABEL[a.account_type]}</td>
            <td>${a.parent_account_id ? esc(STATE.accounts.find((x) => x.id === a.parent_account_id)?.account_number || "") : "—"}</td></tr>`).join("")}
        </tbody>
      </table></div>
    </div>
  `;
}

function accountFormModal() {
  showModal(`
    <h2>Nový účet</h2>
    <form data-form="create-account">
      <div class="form-grid">
        <div><label>Číslo účtu</label><input type="text" name="account_number" required /></div>
        <div><label>Třída (0–9)</label><input type="number" name="account_class" min="0" max="9" required /></div>
      </div>
      <label>Název</label><input type="text" name="name" required />
      <label>Typ účtu</label>
      <select name="account_type">${Object.entries(ACCOUNT_TYPE_LABEL).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <label>Nadřazený účet (analytika, volitelné)</label>
      <select name="parent_account_id"><option value="">—</option>${accountOptions()}</select>
      <div class="form-actions">
        <button type="submit">Vytvořit</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

async function handleCreateAccount(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.accounting_unit_id = STATE.unit.id;
  body.account_class = Number(body.account_class);
  body.parent_account_id = body.parent_account_id || null;
  await api("POST", "/accounts", body);
  toast("Účet byl přidán do rozvrhu.");
  closeModal();
  renderAccounts();
}

// =====================================================================
// KONTAKTY
// =====================================================================
const CONTACT_TYPE_LABEL = { odberatel: "Odběratel", dodavatel: "Dodavatel", umelec: "Umělec", zamestnanec: "Zaměstnanec", jiny: "Jiný" };

async function renderContacts() {
  const unit = STATE.unit.id;
  const contacts = await api("GET", `/contacts?unit=${unit}`);
  STATE._contacts = contacts;
  document.getElementById("topbarActions").innerHTML = `<button data-action="new-contact">+ Nový kontakt</button>`;
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <input type="text" id="aresSearch" placeholder="Hledat firmu v ARES podle názvu…" style="max-width:340px" />
        <button class="secondary" data-action="ares-search">Hledat v ARES</button>
        <div class="spacer"></div>
        <span class="text-dim">${contacts.length} kontaktů</span>
      </div>
      <div id="aresResults"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Název</th><th>Typ</th><th>IČO</th><th>DIČ</th><th>Plátce DPH</th><th>Bankovní spojení</th><th></th></tr></thead>
        <tbody>${contacts.length ? contacts.map((c) => `
          <tr><td>${esc(c.name)}</td><td>${CONTACT_TYPE_LABEL[c.contact_type]}</td><td class="mono">${esc(c.ico || "—")}</td>
            <td class="mono">${esc(c.dic || "—")}</td><td>${c.is_vat_payer ? "ano" : "ne"}</td><td class="mono">${esc(c.bank_account || "—")}</td>
            <td><button class="small danger" data-action="delete-contact" data-id="${c.id}">Smazat</button></td></tr>`).join("")
          : `<tr><td colspan="7" class="empty-state">Zatím žádné kontakty.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
}

function contactFormModal(prefill = {}) {
  showModal(`
    <h2>Nový kontakt</h2>
    <form data-form="create-contact">
      <label>IČO — automatické doplnění z ARES</label>
      <div style="display:flex;gap:8px">
        <input type="text" name="ico" value="${esc(prefill.ico || "")}" placeholder="8 číslic" />
        <button type="button" class="secondary" data-action="ares-fill" style="white-space:nowrap">Načíst z ARES</button>
      </div>
      <label style="margin-top:12px">Název / jméno</label><input type="text" name="name" value="${esc(prefill.name || "")}" required />
      <div class="form-grid">
        <div><label>Typ</label><select name="contact_type">${Object.entries(CONTACT_TYPE_LABEL).map(([k,v]) => `<option value="${k}" ${prefill.contact_type===k?"selected":""}>${v}</option>`).join("")}</select></div>
        <div><label>DIČ</label><input type="text" name="dic" value="${esc(prefill.dic || "")}" /></div>
        <div><label>Bankovní spojení</label><input type="text" name="bank_account" /></div>
        <div><label>IBAN (pro QR platbu)</label><input type="text" name="iban" placeholder="CZ..." /></div>
      </div>
      <label>Adresa</label><input type="text" name="address" value="${esc(prefill.address || "")}" />
      <label style="margin-top:12px"><input type="checkbox" name="is_vat_payer" ${prefill.is_vat_payer ? "checked" : ""} style="width:auto;display:inline-block;margin-right:6px" /> Plátce DPH</label>
      <div class="form-actions">
        <button type="submit">Vytvořit</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

// Doplnění polí kontaktu z ARES podle zadaného IČO
async function aresFillContact() {
  const form = document.querySelector('[data-form="create-contact"]');
  const ico = form.querySelector('[name="ico"]').value.trim();
  if (!ico) return toast("Zadejte IČO.", "error");
  try {
    const data = await api("GET", `/ares/${ico}`);
    form.querySelector('[name="name"]').value = data.name || "";
    if (data.dic) form.querySelector('[name="dic"]').value = data.dic;
    if (data.address) form.querySelector('[name="address"]').value = data.address;
    form.querySelector('[name="is_vat_payer"]').checked = !!data.is_vat_payer;
    toast("Údaje z ARES byly doplněny.");
  } catch (err) { toast(err.message, "error"); }
}

// Fulltextové hledání firmy v ARES podle názvu
async function aresSearch() {
  const query = document.getElementById("aresSearch").value.trim();
  const box = document.getElementById("aresResults");
  if (query.length < 3) return toast("Zadejte alespoň 3 znaky.", "error");
  box.innerHTML = `<div class="text-dim" style="padding:8px">Hledám v ARES…</div>`;
  try {
    const results = await api("GET", `/ares/search/${encodeURIComponent(query)}`);
    if (!results.length) { box.innerHTML = `<div class="empty-state">Nic nenalezeno.</div>`; return; }
    box.innerHTML = `<div class="panel" style="margin-bottom:14px"><h2>Výsledky z ARES</h2>
      <div class="table-wrap"><table><thead><tr><th>Název</th><th>IČO</th><th>Adresa</th><th></th></tr></thead>
      <tbody>${results.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(r.ico)}</td><td>${esc(r.address || "—")}</td>
        <td><button class="small" data-action="ares-pick" data-ico="${esc(r.ico)}">+ Přidat kontakt</button></td></tr>`).join("")}</tbody></table></div></div>`;
  } catch (err) { box.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; }
}

async function aresPickAndOpen(ico) {
  try {
    const data = await api("GET", `/ares/${ico}`);
    contactFormModal({ ico: data.ico, name: data.name, dic: data.dic, address: data.address, is_vat_payer: data.is_vat_payer, contact_type: "dodavatel" });
  } catch (err) { toast(err.message, "error"); }
}

async function handleCreateContact(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.accounting_unit_id = STATE.unit.id;
  body.is_vat_payer = fd.get("is_vat_payer") === "on";
  await api("POST", "/contacts", body);
  toast("Kontakt byl vytvořen.");
  closeModal();
  renderContacts();
}

// =====================================================================
// PROJEKTY / ZAKÁZKY
// =====================================================================
async function renderProjects() {
  const unit = STATE.unit.id;
  const projects = await api("GET", `/projects?unit=${unit}`);
  STATE._projects = projects;
  document.getElementById("topbarActions").innerHTML = `<button data-action="new-project">+ Nový projekt</button>`;
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <p class="text-dim" style="margin-top:0">Analytické sledování nákladů a výnosů po jednotlivých akcích.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Kód</th><th>Název</th><th>Začátek</th><th class="num">Rozpočet</th><th class="num">Náklady</th><th class="num">Výnosy</th><th class="num">Výsledek</th><th></th></tr></thead>
        <tbody>${projects.length ? projects.map((p) => `
          <tr><td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td><td>${fmtDate(p.start_date)}</td>
            <td class="num">${fmtMoney(p.budget)}</td><td class="num">${fmtMoney(p.naklady)}</td><td class="num">${fmtMoney(p.vynosy)}</td>
            <td class="num" style="color:${p.vysledek >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoney(p.vysledek)}</td>
            <td><button class="secondary" data-action="delete-project" data-id="${p.id}" title="Smazat projekt">Smazat</button></td></tr>`).join("")
          : `<tr><td colspan="8" class="empty-state">Zatím žádné projekty.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
}

function projectFormModal() {
  showModal(`
    <h2>Nový projekt / zakázka</h2>
    <form data-form="create-project">
      <div class="form-grid">
        <div><label>Kód</label><input type="text" name="code" required /></div>
        <div><label>Název</label><input type="text" name="name" required /></div>
        <div><label>Rozpočet (Kč)</label><input type="number" step="0.01" name="budget" /></div>
        <div><label>Začátek</label><input type="date" name="start_date" /></div>
        <div><label>Konec</label><input type="date" name="end_date" /></div>
      </div>
      <div class="form-actions">
        <button type="submit">Vytvořit</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

async function handleCreateProject(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.accounting_unit_id = STATE.unit.id;
  if (body.budget) body.budget = Number(body.budget);
  await api("POST", "/projects", body);
  toast("Projekt byl vytvořen.");
  closeModal();
  renderProjects();
}

// =====================================================================
// BANKA A POKLADNA
// =====================================================================
async function renderBank() {
  const unit = STATE.unit.id;
  const lines = await api("GET", `/bank?unit=${unit}`);
  const docs = await api("GET", `/documents?unit=${unit}`);
  document.getElementById("topbarActions").innerHTML = `
    <button class="secondary" data-action="import-bank">Importovat výpis (CSV/XML)</button>
    <button data-action="new-bank-line">+ Zadat pohyb</button>`;
  const unmatched = lines.filter((l) => !l.matched_document_id).length;
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <p class="text-dim" style="margin:0;flex:1">Bankovní a hotovostní pohyby s párováním na doklady. Importuj výpis z banky (CSV nebo camt.053 XML) a spáruj řádky s doklady.</p>
        ${unmatched ? `<button class="small secondary" data-action="suggest-matches">Navrhnout párování (${unmatched})</button>` : ""}
      </div>
      <div id="matchSuggestions"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Datum</th><th>Účet</th><th class="num">Částka</th><th>Protistrana</th><th>VS</th><th>Spárováno</th><th></th></tr></thead>
        <tbody>${lines.length ? lines.map((l) => `
          <tr><td>${fmtDate(l.statement_date)}</td><td>${esc(l.bank_account)}</td>
            <td class="num" style="color:${l.amount >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoney(l.amount)}</td>
            <td>${esc(l.counterparty_name || "—")}</td><td class="mono">${esc(l.variable_symbol || "—")}</td>
            <td>${l.matched_document_id ? `<span class="badge zauctovany">ano</span>` : `<span class="badge koncept">ne</span>`}</td>
            <td>${!l.matched_document_id ? `<select class="small" data-match-id="${l.id}" style="width:auto;display:inline-block">
                <option value="">Spárovat s dokladem…</option>${docs.map((d) => `<option value="${d.id}">${esc(d.doc_number)} (${fmtMoney(d.total_amount)})</option>`).join("")}
              </select>` : "—"}</td></tr>`).join("")
          : `<tr><td colspan="7" class="empty-state">Zatím žádné bankovní/pokladní pohyby.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
  document.querySelectorAll("[data-match-id]").forEach((sel) => {
    sel.onchange = async (e) => {
      if (!e.target.value) return;
      await api("POST", `/bank/${sel.dataset.matchId}/match`, { document_id: e.target.value });
      toast("Pohyb byl spárován s dokladem.");
      renderBank();
    };
  });
}

function bankLineFormModal() {
  showModal(`
    <h2>Zadat bankovní/pokladní pohyb</h2>
    <form data-form="create-bank-line">
      <div class="form-grid">
        <div><label>Bankovní účet / pokladna</label><input type="text" name="bank_account" placeholder="např. 221 nebo 211-pokladna" required /></div>
        <div><label>Datum</label><input type="date" name="statement_date" value="${todayISO()}" required /></div>
        <div><label>Částka (kladné=příjem, záporné=výdej)</label><input type="number" step="0.01" name="amount" required /></div>
        <div><label>Variabilní symbol</label><input type="text" name="variable_symbol" /></div>
      </div>
      <label>Protistrana</label><input type="text" name="counterparty_name" />
      <div class="form-actions">
        <button type="submit">Uložit</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

async function handleCreateBankLine(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  await api("POST", "/bank/import", {
    accounting_unit_id: STATE.unit.id,
    bank_account: body.bank_account,
    lines: [{ statement_date: body.statement_date, amount: Number(body.amount), counterparty_name: body.counterparty_name, variable_symbol: body.variable_symbol }],
  });
  toast("Pohyb byl zaznamenán.");
  closeModal();
  renderBank();
}

// ---------------------------------------------------------------------
// IMPORT BANKOVNÍHO VÝPISU (CSV / camt.053 XML)
// Parsuje se celé v prohlížeči (FileReader) a nahrává hromadně přes
// /bank/import. Podporuje standard ISO 20022 camt.053 (většina českých
// bank) i libovolný CSV s mapováním sloupců.
// ---------------------------------------------------------------------
let importParsedLines = [];

function bankImportModal() {
  showModal(`
    <h2>Import bankovního výpisu</h2>
    <p class="text-dim">Nahraj výpis z internetového bankovnictví. Podporováno: <strong>CSV</strong> (oddělovač ; nebo ,) a <strong>camt.053 XML</strong> (ISO 20022 — KB, ČSOB, Fio, Air Bank, Raiffeisenbank…).</p>
    <div class="form-grid">
      <div><label>Účet v účtovém rozvrhu</label><input type="text" id="impAccount" value="221" /></div>
      <div><label>Soubor výpisu</label><input type="file" id="impFile" accept=".csv,.xml,.txt" /></div>
    </div>
    <div id="impArea"></div>
  `);
  importParsedLines = [];
  document.getElementById("impFile").addEventListener("change", handleImportFile);
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    try {
      if (/^\s*<\?xml|<Document/i.test(text)) {
        importParsedLines = parseCamt053(text);
        renderImportPreview("camt.053 XML");
      } else {
        parseCsvWithMapping(text);
      }
    } catch (err) {
      document.getElementById("impArea").innerHTML = `<div class="empty-state">Soubor se nepodařilo načíst: ${esc(err.message)}</div>`;
    }
  };
  reader.readAsText(file, "utf-8");
}

// --- camt.053 (ISO 20022) ---
function parseCamt053(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Neplatné XML.");
  const txt = (node, sel) => { const el = node.querySelector(sel); return el ? el.textContent.trim() : ""; };
  const entries = [...doc.querySelectorAll("Ntry")];
  if (!entries.length) throw new Error("V souboru nejsou žádné položky (Ntry) — je to camt.053?");
  return entries.map((ntry) => {
    const sign = txt(ntry, "CdtDbtInd") === "DBIT" ? -1 : 1;
    const amount = sign * Number(txt(ntry, "Amt").replace(",", "."));
    const date = txt(ntry, "BookgDt Dt") || txt(ntry, "ValDt Dt");
    const msg = txt(ntry, "RmtInf Ustrd");
    // Protistrana: u příjmu dlužník (Dbtr), u výdaje věřitel (Cdtr)
    const party = sign > 0 ? txt(ntry, "RltdPties Dbtr Nm") : txt(ntry, "RltdPties Cdtr Nm");
    // VS bývá v proprietárním referenčním poli nebo ve zprávě
    let vs = "";
    ntry.querySelectorAll("Refs Prtry, CdtrRefInf Ref").forEach((r) => {
      const m = r.textContent.match(/(\d{4,10})/); if (m && !vs) vs = m[1]; // nejdelší číselný běh (VS bývá 4–10 číslic)
    });
    if (!vs) { const m = msg.match(/VS[:\s]?(\d{1,10})/i); if (m) vs = m[1]; }
    return { statement_date: date, amount, counterparty_name: party || null, variable_symbol: vs || null };
  }).filter((l) => l.statement_date && !isNaN(l.amount));
}

// --- CSV s mapováním sloupců ---
function parseCsvWithMapping(text) {
  const delimiter = (text.match(/;/g) || []).length >= (text.match(/,/g) || []).length ? ";" : ",";
  const rows = text.split(/\r?\n/).filter((r) => r.trim()).map((r) => r.split(delimiter).map((c) => c.replace(/^"|"$/g, "").trim()));
  if (rows.length < 2) throw new Error("CSV nemá dostatek řádků.");
  const header = rows[0];
  const guess = (patterns) => header.findIndex((h) => patterns.some((p) => h.toLowerCase().includes(p)));
  const cols = {
    date: guess(["datum", "date", "zaúčtování", "zauctovani"]),
    amount: guess(["částka", "castka", "amount", "objem"]),
    vs: guess(["vs", "variabiln", "symbol"]),
    party: guess(["protistrana", "název", "nazev", "protiúčet", "counterparty", "name", "zpráva pro", "zprava"]),
    msg: guess(["zpráva", "zprava", "message", "poznámka", "poznamka", "popis"]),
  };
  const sel = (id, chosen) => `<select id="${id}"><option value="-1">—</option>${header.map((h, i) => `<option value="${i}" ${i === chosen ? "selected" : ""}>${esc(h)}</option>`).join("")}</select>`;
  document.getElementById("impArea").innerHTML = `
    <p class="text-dim" style="margin-top:16px">Zkontroluj přiřazení sloupců (CSV, oddělovač „${delimiter}"):</p>
    <div class="form-grid">
      <div><label>Datum</label>${sel("mapDate", cols.date)}</div>
      <div><label>Částka</label>${sel("mapAmount", cols.amount)}</div>
      <div><label>Variabilní symbol</label>${sel("mapVs", cols.vs)}</div>
      <div><label>Protistrana</label>${sel("mapParty", cols.party)}</div>
      <div><label>Zpráva/popis</label>${sel("mapMsg", cols.msg)}</div>
    </div>
    <div class="form-actions"><button type="button" data-action="csv-parse">Načíst řádky</button></div>
    <div id="impPreview"></div>`;
  window._csvRows = rows.slice(1);
}

function csvParseRows() {
  const idx = (id) => Number(document.getElementById(id).value);
  const di = idx("mapDate"), ai = idx("mapAmount"), vi = idx("mapVs"), pi = idx("mapParty"), mi = idx("mapMsg");
  if (di < 0 || ai < 0) return toast("Vyber alespoň sloupec Datum a Částka.", "error");
  importParsedLines = (window._csvRows || []).map((r) => {
    let raw = (r[ai] || "").replace(/\s/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".");
    const amount = Number(raw);
    let date = (r[di] || "").trim();
    const m = date.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/); // dd.mm.yyyy → yyyy-mm-dd
    if (m) date = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return { statement_date: date, amount, counterparty_name: pi >= 0 ? (r[pi] || null) : (mi >= 0 ? r[mi] : null), variable_symbol: vi >= 0 ? (r[vi] || null) : null };
  }).filter((l) => l.statement_date && !isNaN(l.amount));
  renderImportPreview("CSV", "impPreview");
}

function renderImportPreview(fmt, targetId = "impArea") {
  if (!importParsedLines.length) {
    document.getElementById(targetId).innerHTML = `<div class="empty-state">Nenačetl se žádný použitelný řádek.</div>`;
    return;
  }
  const preview = importParsedLines.slice(0, 8);
  document.getElementById(targetId).innerHTML = `
    <p class="text-dim" style="margin-top:16px">Rozpoznáno <strong>${importParsedLines.length}</strong> pohybů (${fmt}). Náhled prvních ${preview.length}:</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Datum</th><th class="num">Částka</th><th>Protistrana</th><th>VS</th></tr></thead>
      <tbody>${preview.map((l) => `<tr><td>${fmtDate(l.statement_date)}</td>
        <td class="num" style="color:${l.amount >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(l.amount)}</td>
        <td>${esc(l.counterparty_name || "—")}</td><td class="mono">${esc(l.variable_symbol || "—")}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="form-actions">
      <button type="button" data-action="confirm-import">Importovat ${importParsedLines.length} pohybů</button>
      <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
    </div>`;
}

async function confirmBankImport() {
  const account = document.getElementById("impAccount").value || "221";
  await api("POST", "/bank/import", { accounting_unit_id: STATE.unit.id, bank_account: account, lines: importParsedLines });
  toast(`Naimportováno ${importParsedLines.length} pohybů.`);
  closeModal();
  renderBank();
}

async function suggestMatches() {
  const box = document.getElementById("matchSuggestions");
  box.innerHTML = `<div class="text-dim" style="padding:8px">Hledám shody podle VS a částky…</div>`;
  const suggestions = await api("GET", `/bank/suggest-matches?unit=${STATE.unit.id}`);
  if (!suggestions.length) { box.innerHTML = `<div class="panel" style="margin-bottom:14px"><div class="empty-state">Systém nenašel žádné automatické shody. Spáruj řádky ručně v tabulce níže.</div></div>`; return; }
  box.innerHTML = `<div class="panel" style="margin-bottom:14px"><h2>Navržené párování (${suggestions.length})</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Datum</th><th class="num">Částka</th><th>→ Doklad</th><th class="num">Částka dokladu</th><th></th></tr></thead>
      <tbody>${suggestions.map((s) => `<tr>
        <td>${fmtDate(s.bank_line.statement_date)}</td>
        <td class="num">${fmtMoney(s.bank_line.amount)}</td>
        <td class="mono">${esc(s.suggested_document.doc_number)}</td>
        <td class="num">${fmtMoney(s.suggested_document.total_amount)}</td>
        <td><button class="small" data-action="confirm-match" data-bank="${s.bank_line.id}" data-doc="${s.suggested_document.id}">Spárovat</button></td>
      </tr>`).join("")}</tbody>
    </table></div></div>`;
}

// =====================================================================
// MAJETEK
// =====================================================================
async function renderAssets() {
  const unit = STATE.unit.id;
  const assets = await api("GET", `/assets?unit=${unit}`);
  document.getElementById("topbarActions").innerHTML = `<button data-action="new-asset">+ Nová karta majetku</button>`;
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <div class="table-wrap"><table>
        <thead><tr><th>Název</th><th>Pořízeno</th><th class="num">Pořizovací cena</th><th class="num">Oprávky</th><th class="num">Zůstatková cena</th><th></th></tr></thead>
        <tbody>${assets.length ? assets.map((a) => `
          <tr><td>${esc(a.name)}</td><td>${fmtDate(a.acquisition_date)}</td>
            <td class="num">${fmtMoney(a.acquisition_cost)}</td><td class="num">${fmtMoney(a.accumulated_depreciation)}</td>
            <td class="num">${fmtMoney(a.net_book_value)}</td>
            <td><button class="small" data-action="depreciate-asset" data-id="${a.id}" ${a.net_book_value <= a.residual_value ? "disabled" : ""}>Zaúčtovat odpis</button></td></tr>`).join("")
          : `<tr><td colspan="6" class="empty-state">Zatím žádný evidovaný majetek.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
}

function assetFormModal() {
  showModal(`
    <h2>Nová karta dlouhodobého majetku</h2>
    <form data-form="create-asset">
      <label>Název</label><input type="text" name="name" required />
      <div class="form-grid">
        <div><label>Pořizovací cena (Kč)</label><input type="number" step="0.01" name="acquisition_cost" required /></div>
        <div><label>Datum pořízení</label><input type="date" name="acquisition_date" value="${todayISO()}" required /></div>
        <div><label>Doba odepisování (měsíců)</label><input type="number" name="useful_life_months" value="60" required /></div>
        <div><label>Zůstatková (likvidační) hodnota</label><input type="number" step="0.01" name="residual_value" value="0" /></div>
        <div><label>Účet majetku</label><select name="account_id">${accountOptions()}</select></div>
        <div><label>Účet oprávek</label><select name="depreciation_account_id">${accountOptions()}</select></div>
      </div>
      <div class="form-actions">
        <button type="submit">Vytvořit</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

async function handleCreateAsset(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.accounting_unit_id = STATE.unit.id;
  ["acquisition_cost", "useful_life_months", "residual_value"].forEach((k) => body[k] = Number(body[k] || 0));
  await api("POST", "/assets", body);
  toast("Majetková karta byla vytvořena.");
  closeModal();
  renderAssets();
}

async function handleDepreciateAsset(id) {
  const period = currentOpenPeriod();
  if (!period) return toast("Není otevřené účetní období.", "error");
  try {
    await api("POST", `/assets/${id}/depreciate`, { period_id: period.id, entry_date: todayISO(), created_by: STATE.user.id });
    toast("Odpis byl zaúčtován.");
    renderAssets();
  } catch (err) { toast(err.message, "error"); }
}

// =====================================================================
// VÝKAZY
// =====================================================================
async function renderReports() {
  const unit = STATE.unit.id;
  const asOf = document.getElementById("repAsOf")?.value || todayISO();
  const period = document.getElementById("repPeriod")?.value || currentOpenPeriod()?.id;

  const [rozvaha, vysledovka] = await Promise.all([
    api("GET", `/reports/rozvaha?unit=${unit}&asOf=${asOf}`),
    period ? api("GET", `/reports/vysledovka?unit=${unit}&period=${period}`) : Promise.resolve(null),
  ]);

  document.getElementById("view").innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <label style="margin:0">Rozvaha ke dni</label><input type="date" id="repAsOf" value="${asOf}" style="width:auto" />
        <label style="margin:0">Výsledovka za období</label><select id="repPeriod" style="width:auto">${periodOptions(period)}</select>
        <div class="spacer"></div>
        <a class="btn secondary" style="text-decoration:none" href="${API}/export/rozvaha?unit=${unit}&asOf=${asOf}" target="_blank">Export rozvaha CSV</a>
        <a class="btn secondary" style="text-decoration:none" href="${API}/export/vysledovka?unit=${unit}&period=${period||''}" target="_blank">Export výsledovka CSV</a>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h2>Rozvaha (zjednodušený rozsah)</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Strana</th><th>Účet</th><th>Název</th><th class="num">Zůstatek</th></tr></thead>
          <tbody>${rozvaha.polozky.map((p) => `<tr><td>${p.strana}</td><td class="mono">${esc(p.account_number)}</td><td>${esc(p.account_name)}</td><td class="num">${fmtMoney(p.zustatek)}</td></tr>`).join("")}</tbody>
          <tfoot><tr><td colspan="3"><strong>AKTIVA / PASIVA CELKEM</strong></td><td class="num"><strong>${fmtMoney(rozvaha.kontrola.aktiva_celkem)} / ${fmtMoney(rozvaha.kontrola.pasiva_celkem)}</strong></td></tr></tfoot>
        </table></div>
        <p style="margin-top:12px;color:${Math.abs(rozvaha.kontrola.rozdil) < 0.01 ? 'var(--green)' : 'var(--red)'}">
          ${Math.abs(rozvaha.kontrola.rozdil) < 0.01 ? "✓ Rozvaha je vyrovnaná (AKTIVA = PASIVA)." : `⚠ Rozdíl AKTIVA-PASIVA: ${fmtMoney(rozvaha.kontrola.rozdil)}`}
        </p>
      </div>
      <div class="panel">
        <h2>Výsledovka (zjednodušený rozsah)</h2>
        ${vysledovka ? `
          <div class="table-wrap"><table>
            <thead><tr><th>Druh</th><th>Účet</th><th>Název</th><th class="num">Částka</th></tr></thead>
            <tbody>${vysledovka.polozky.map((p) => `<tr><td>${p.druh}</td><td class="mono">${esc(p.account_number)}</td><td>${esc(p.account_name)}</td><td class="num">${fmtMoney(p.castka)}</td></tr>`).join("")}</tbody>
          </table></div>
          <p style="margin-top:12px;font-weight:600;color:${vysledovka.vysledek_hospodareni >= 0 ? 'var(--green)' : 'var(--red)'}">
            Výsledek hospodaření: ${fmtMoney(vysledovka.vysledek_hospodareni)}
          </p>
        ` : `<div class="empty-state">Nejprve vyberte účetní období.</div>`}
      </div>
    </div>
  `;
  document.getElementById("repAsOf").onchange = renderReports;
  document.getElementById("repPeriod").onchange = renderReports;
}

// =====================================================================
// DPH
// =====================================================================
async function renderVat() {
  const unit = STATE.unit.id;
  const obrat = await api("GET", `/reports/obrat-dph?unit=${unit}`);
  const ledger = STATE.unit.is_vat_payer ? await api("GET", `/vat/ledger?unit=${unit}`) : [];

  document.getElementById("view").innerHTML = `
    <div class="panel">
      <h2>Připravenost na DPH (kap. 3.2 brief)</h2>
      <p>Systém je od začátku připraven na registraci k DPH — daňová pole existují na každém dokladu, i když se dnes nevyplňují.</p>
      <div class="kpi-grid">
        <div class="kpi ${obrat.blizi_se_limitu_dph ? "bad" : ""}">
          <div class="label">Obrat za 12 měsíců</div>
          <div class="value">${fmtMoney(obrat.obrat_12m)}</div>
          <div class="sub">Zákonný limit: 2 000 000 Kč (§ 6 ZDPH)</div>
        </div>
        <div class="kpi">
          <div class="label">Stav plátcovství</div>
          <div class="value" style="font-size:18px">${STATE.unit.is_vat_payer ? "Plátce DPH" : "Neplátce"}</div>
          <div class="sub">${STATE.unit.is_vat_payer ? "od " + fmtDate(STATE.unit.vat_payer_since) : "aktivujte při registraci na FÚ"}</div>
        </div>
      </div>
      <form data-form="toggle-vat" class="form-grid" style="align-items:end">
        <div><label>Plátce DPH</label><select name="is_vat_payer"><option value="false" ${!STATE.unit.is_vat_payer?"selected":""}>Ne</option><option value="true" ${STATE.unit.is_vat_payer?"selected":""}>Ano</option></select></div>
        <div><label>Platnost od</label><input type="date" name="vat_payer_since" value="${STATE.unit.vat_payer_since || todayISO()}" /></div>
        <div><button type="submit">Uložit</button></div>
      </form>
    </div>

    ${STATE.unit.is_vat_payer ? `
    <div class="panel">
      <h2>Evidence pro účely DPH (§ 100 ZDPH)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Doklad</th><th>Směr</th><th>DUZP</th><th class="num">Základ</th><th class="num">DPH</th><th>DIČ protistrany</th><th>Nad limit KH</th></tr></thead>
        <tbody>${ledger.length ? ledger.map((v) => `
          <tr><td class="mono">${esc(v.doc_number)}</td><td>${v.direction}</td><td>${fmtDate(v.duzp)}</td>
            <td class="num">${fmtMoney(v.vat_base)}</td><td class="num">${fmtMoney(v.vat_amount)}</td>
            <td class="mono">${esc(v.counterparty_dic || "—")}</td>
            <td>${v.requires_individual_kh ? '<span class="badge schvaleny">ano (>10 000 Kč)</span>' : "ne"}</td></tr>`).join("")
          : `<tr><td colspan="7" class="empty-state">Zatím žádné doklady v evidenci DPH.</td></tr>`}
        </tbody>
      </table></div>
    </div>` : `<div class="panel"><div class="empty-state">Modul DPH se aktivuje po nastavení plátcovství výše.</div></div>`}
  `;
}

async function handleToggleVat(form) {
  const fd = new FormData(form);
  await api("PATCH", `/units/${STATE.unit.id}`, {
    is_vat_payer: fd.get("is_vat_payer") === "true",
    vat_payer_since: fd.get("vat_payer_since"),
  });
  const units = await api("GET", "/units");
  STATE.unit = units.find((u) => u.id === STATE.unit.id);
  updateVatBadge();
  toast("Nastavení DPH bylo uloženo.");
  renderVat();
}

// =====================================================================
// INVENTARIZACE
// =====================================================================
async function renderInventory() {
  const unit = STATE.unit.id;
  const checks = await api("GET", `/inventory?unit=${unit}`);
  document.getElementById("topbarActions").innerHTML = `<button data-action="new-inventory">+ Vygenerovat soupis</button>`;
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <p class="text-dim" style="margin-top:0">Inventurní soupis k rozvahovému dni (§ 29–30 ZoÚ) — porovnání účetního a fyzického stavu.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Ke dni</th><th>Vytvořeno</th><th>Poznámka</th><th></th></tr></thead>
        <tbody>${checks.length ? checks.map((c) => `
          <tr><td>${fmtDate(c.as_of_date)}</td><td>${fmtDateTime(c.created_at)}</td><td>${esc(c.note || "—")}</td>
            <td><button class="small secondary" data-action="view-inventory" data-id="${c.id}">Detail</button></td></tr>`).join("")
          : `<tr><td colspan="4" class="empty-state">Zatím žádné inventarizace.</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="panel">
      <h2>Uzávěrka účetního období</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Rok</th><th>Od</th><th>Do</th><th>Stav</th><th></th></tr></thead>
        <tbody>${STATE.periods.map((p) => `
          <tr><td>${p.fiscal_year}</td><td>${fmtDate(p.start_date)}</td><td>${fmtDate(p.end_date)}</td>
            <td><span class="badge ${p.status}">${p.status}</span></td>
            <td>${p.status === "otevrene" ? `<button class="small danger" data-action="close-period" data-id="${p.id}">Uzavřít období</button>` : "—"}</td></tr>`).join("")}
        </tbody>
      </table></div>
    </div>
  `;
}

function inventoryFormModal() {
  const period = currentOpenPeriod();
  showModal(`
    <h2>Vygenerovat inventurní soupis</h2>
    <form data-form="create-inventory">
      <div class="form-grid">
        <div><label>Účetní období</label><select name="period_id">${periodOptions(period?.id)}</select></div>
        <div><label>Rozvahový den</label><input type="date" name="as_of_date" value="${todayISO()}" required /></div>
      </div>
      <label>Poznámka</label><input type="text" name="note" />
      <div class="form-actions">
        <button type="submit">Vygenerovat</button>
        <button type="button" class="secondary" data-action="close-modal">Zrušit</button>
      </div>
    </form>
  `);
}

async function handleCreateInventory(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.accounting_unit_id = STATE.unit.id;
  body.created_by = STATE.user.id;
  await api("POST", "/inventory/generate", body);
  toast("Inventurní soupis byl vygenerován.");
  closeModal();
  renderInventory();
}

async function showInventoryDetail(id) {
  const inv = await api("GET", `/inventory/${id}`);
  showModal(`
    <h2>Inventurní soupis ke dni ${fmtDate(inv.as_of_date)}</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Účet</th><th class="num">Účetní stav</th><th class="num">Fyzický stav</th><th class="num">Rozdíl</th></tr></thead>
      <tbody>${inv.lines.map((l) => `
        <tr><td>${esc(l.account_number)} — ${esc(l.account_name)}</td>
          <td class="num">${fmtMoney(l.book_balance)}</td>
          <td class="num"><input type="number" step="0.01" class="inv-physical" data-line-id="${l.id}" value="${l.physical_balance ?? ""}" style="width:110px" /></td>
          <td class="num">${l.difference !== null && l.difference !== undefined ? fmtMoney(l.difference) : "—"}</td></tr>`).join("")}
      </tbody>
    </table></div>
    <div class="form-actions">
      <button data-action="save-inventory-lines" data-id="${id}">Uložit fyzický stav</button>
      <button type="button" class="secondary" data-action="close-modal">Zavřít</button>
    </div>
  `);
}

async function saveInventoryLines(checkId) {
  const inputs = [...document.querySelectorAll(".inv-physical")];
  for (const inp of inputs) {
    if (inp.value === "") continue;
    await api("PUT", `/inventory/${checkId}/lines/${inp.dataset.lineId}`, { physical_balance: Number(inp.value) });
  }
  toast("Fyzický stav byl uložen.");
  closeModal();
  renderInventory();
}

async function handleClosePeriod(id) {
  if (!confirm("Uzavřít účetní období? Po uzavření nepůjde zapisovat doklady ani účetní zápisy s datem v tomto období.")) return;
  try {
    await api("POST", `/periods/${id}/close`, { closed_by: STATE.user.id });
    toast("Účetní období bylo uzavřeno.");
    STATE.periods = await api("GET", `/periods?unit=${STATE.unit.id}`);
    renderInventory();
  } catch (err) { toast(err.message, "error"); }
}

// =====================================================================
// AUDIT LOG
// =====================================================================
async function renderAuditLog() {
  const unit = STATE.unit.id;
  const rows = await api("GET", `/audit-log?unit=${unit}&limit=300`);
  document.getElementById("topbarActions").innerHTML = `<a class="btn secondary" style="text-decoration:none" href="${API}/export/audit-log?unit=${unit}" target="_blank">Export CSV</a>`;
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <p class="text-dim" style="margin-top:0">Nezměnitelný chronologický záznam všech úkonů v systému (§ 33 odst. 8–9 ZoÚ) — nelze editovat ani mazat, ani administrátorským účtem.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Kdy</th><th>Akce</th><th>Tabulka</th><th>ID</th><th>Detail</th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `
          <tr><td>${fmtDateTime(r.occurred_at)}</td><td><span class="badge schvaleny">${esc(r.action)}</span></td>
            <td class="mono">${esc(r.entity_table)}</td><td class="mono">${r.entity_id ?? "—"}</td>
            <td class="mono" style="white-space:normal;max-width:400px">${r.after_data ? esc(JSON.stringify(r.after_data)) : ""}</td></tr>`).join("")
          : `<tr><td colspan="5" class="empty-state">Zatím žádné záznamy.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
}

// =====================================================================
// NASTAVENÍ
// =====================================================================
async function renderSettings() {
  const users = await api("GET", `/users?unit=${STATE.unit.id}`);
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <h2>Účetní jednotka</h2>
      <form data-form="update-unit" class="form-grid">
        <div><label>Název</label><input type="text" name="name" value="${esc(STATE.unit.name)}" /></div>
        <div><label>DIČ</label><input type="text" name="dic" value="${esc(STATE.unit.dic || "")}" /></div>
        <div><label>Kategorie účetní jednotky</label>
          <select name="unit_category">${["mikro","mala","stredni","velka"].map((c) => `<option value="${c}" ${STATE.unit.unit_category===c?"selected":""}>${c}</option>`).join("")}</select>
        </div>
        <div><label>Účetní režim</label>
          <select name="accounting_mode">
            <option value="podvojne_ucetnictvi" ${STATE.unit.accounting_mode==="podvojne_ucetnictvi"?"selected":""}>Podvojné účetnictví</option>
            <option value="danova_evidence" ${STATE.unit.accounting_mode==="danova_evidence"?"selected":""}>Daňová evidence (§ 7b ZDP)</option>
          </select>
        </div>
        <div><label>IBAN (pro QR platbu na vydaných fakturách)</label><input type="text" name="iban" value="${esc(STATE.unit.iban || "")}" placeholder="CZ..." /></div>
        <div><label>Číslo účtu</label><input type="text" name="bank_account" value="${esc(STATE.unit.bank_account || "")}" placeholder="123456789/0100" /></div>
        <div style="grid-column:1/-1"><button type="submit">Uložit</button></div>
      </form>
    </div>
    <div class="panel">
      <h2>Uživatelé a role</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Jméno</th><th>E-mail</th><th>Role</th><th>Aktivní</th></tr></thead>
        <tbody>${users.map((u) => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.active ? "ano" : "ne"}</td></tr>`).join("")}</tbody>
      </table></div>
      <form data-form="add-user" class="form-grid" style="margin-top:14px;align-items:end">
        <div><label>Jméno</label><input type="text" name="full_name" required /></div>
        <div><label>E-mail</label><input type="email" name="email" required /></div>
        <div><label>Role</label><select name="role"><option value="zadavatel">Zadavatel</option><option value="schvalovatel">Schvalovatel</option><option value="ucetni">Účetní</option><option value="ctenar">Čtenář</option><option value="admin">Admin</option></select></div>
        <div><button type="submit">Přidat</button></div>
      </form>
      <p class="text-dim" style="font-size:11.5px;margin-top:8px">Takto přidaný uživatel se poprvé přihlásí přes "Nastavit heslo" na přihlašovací obrazovce. Pro sdílený přístup kolegy raději použijte pozvánku níže.</p>
    </div>
    <div class="panel">
      <h2>Pozvat kolegu / společníka (sdílený přístup k firmě)</h2>
      <p class="text-dim" style="margin-top:0">Kolega dostane odkaz s pozvánkou, kterým si nastaví heslo a získá přístup ke stejné firmě.</p>
      <form data-form="invite-colleague" class="form-grid" style="align-items:end">
        <div><label>E-mail kolegy</label><input type="email" name="email" required /></div>
        <div><label>Role</label><select name="role"><option value="zadavatel">Zadavatel</option><option value="schvalovatel">Schvalovatel</option><option value="ucetni">Účetní</option><option value="ctenar">Čtenář</option><option value="admin">Admin</option></select></div>
        <div><button type="submit">Vytvořit pozvánku</button></div>
      </form>
      <div id="inviteResult" style="margin-top:12px"></div>
    </div>
  `;
}

async function handleUpdateUnit(form) {
  const fd = new FormData(form);
  await api("PATCH", `/units/${STATE.unit.id}`, Object.fromEntries(fd.entries()));
  const units = await api("GET", "/units");
  STATE.unit = units.find((u) => u.id === STATE.unit.id);
  toast("Nastavení bylo uloženo.");
  renderSettings();
}

async function handleAddUser(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.accounting_unit_id = STATE.unit.id;
  await api("POST", "/users", body);
  toast("Uživatel byl přidán.");
  renderSettings();
}

async function handleInviteColleague(form) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  const { invite_url } = await api("POST", "/auth/invite", body);
  const fullUrl = `${location.origin}${location.pathname}${invite_url}`;
  document.getElementById("inviteResult").innerHTML =
    `<div class="text-dim" style="font-size:12.5px">Pozvánka vytvořena — pošlete kolegovi tento odkaz:</div>
     <input type="text" readonly value="${esc(fullUrl)}" onclick="this.select()" style="margin-top:4px" />`;
  form.reset();
}

// =====================================================================
// NÁPOVĚDA / NÁVOD K POUŽITÍ
// =====================================================================
function renderHelp() {
  document.getElementById("topbarActions").innerHTML = "";
  document.getElementById("view").innerHTML = `
    <div class="panel">
      <h2>Jak systém funguje — v kostce</h2>
      <p>Tento program je <strong>nezávislý účetní systém</strong> pro Globaal Elevate Production s.r.o. Vede podvojné účetnictví podle českého práva (zákon č. 563/1991 Sb.) a je připravený i na DPH. Data se ukládají lokálně na tento počítač a nikam se neodesílají (výjimkou je nepovinné vyhledávání firem v registru ARES).</p>
      <p class="text-dim">Základní myšlenka podvojného účetnictví: každý účetní případ se zapíše na dvě strany — <strong>Má dáti (MD)</strong> a <strong>Dal (D)</strong> — a součet obou stran musí být vždy stejný. Systém to hlídá za vás.</p>
    </div>

    <div class="panel">
      <h2>Doporučený pracovní postup</h2>
      <ol style="line-height:1.9;padding-left:20px">
        <li><strong>Založte kontakt</strong> (Kontakty → Nový kontakt). Stačí zadat IČO a kliknout „Načíst z ARES“ — název, adresa i DIČ se doplní samy.</li>
        <li><strong>Vytvořte doklad</strong> (Doklady → Nový doklad) — např. přijatou fakturu za pronájem. Doklad vznikne jako <span class="badge koncept">koncept</span>.</li>
        <li><strong>Schvalte doklad</strong> (tlačítko „Schválit“). Tím oddělíte roli toho, kdo doklad zadal, od toho, kdo ho schválil (§ 11 ZoÚ).</li>
        <li><strong>Zaúčtujte doklad</strong> (tlačítko „Zaúčtovat“) — vyberete <strong>předkontaci</strong> a účetní zápis se vytvoří automaticky. Doklad přejde do stavu <span class="badge zauctovany">zaúčtovaný</span>.</li>
        <li><strong>Spárujte platbu</strong> (Banka a pokladna) — když přijde/odejde peníz, spárujete ho s dokladem.</li>
        <li><strong>Na konci roku</strong> vygenerujete výkazy (Výkazy), provedete inventarizaci a uzavřete období (Inventarizace).</li>
      </ol>
    </div>

    <div class="two-col">
      <div class="panel">
        <h2>Jak udělat účetní zápis (deník)</h2>
        <p>Existují dvě cesty:</p>
        <p><strong>A) Automaticky z dokladu (doporučeno):</strong> u dokladu klikněte „Zaúčtovat“ a vyberte předkontaci. Např. přijatá faktura za pronájem → předkontace „518 / 321“ udělá zápis <em>MD 518 (náklad) / D 321 (závazek)</em>.</p>
        <p><strong>B) Ručně:</strong> Účetní deník → „Ruční zápis“. Přidáte řádky, u každého vyberete účet, stranu (MD/D) a částku. Součet MD musí být roven součtu D, jinak systém zápis odmítne.</p>
        <p class="text-dim">Příklad — přijatá faktura 15 000 Kč za pronájem klubu:<br>• řádek 1: účet <strong>518</strong>, strana <strong>MD</strong>, 15 000<br>• řádek 2: účet <strong>321</strong>, strana <strong>D</strong>, 15 000</p>
      </div>
      <div class="panel">
        <h2>Předkontace (šablony)</h2>
        <p>Předkontace je uložený „recept“ na zaúčtování opakujícího se případu. Vytvoříte ji jednou (Předkontace → Nová předkontace) a pak ji používáte na jedno kliknutí.</p>
        <p>U každého řádku šablony určíte účet, stranu a <strong>ze které částky dokladu</strong> se naplní:</p>
        <ul style="line-height:1.8">
          <li><strong>celková částka</strong> — celý doklad (běžné případy)</li>
          <li><strong>základ DPH</strong> — jen základ (u plátce DPH)</li>
          <li><strong>výše DPH</strong> — jen daň (účet 343)</li>
        </ul>
        <p class="text-dim">V systému je několik startovních předkontací připraveno (pronájem, tržby, honoráře, úhrady).</p>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h2>Opravy a storno</h2>
        <p>Zaúčtovaný zápis <strong>nelze smazat ani přepsat</strong> — to zakazuje zákon (§ 33a, § 35 ZoÚ) a systém to technicky brání. Oprava se dělá <strong>stornem</strong>: v Účetním deníku u zápisu kliknete „Storno“, zadáte důvod, a vytvoří se nový protichůdný zápis, který původní neutralizuje. Oba zápisy zůstávají viditelné. Vše se navíc zaznamená do <strong>Audit logu</strong>.</p>
      </div>
      <div class="panel">
        <h2>DPH (i když nejste plátce)</h2>
        <p>Firma zatím není plátce DPH, ale systém je připraven. Na Dashboardu i v sekci DPH vidíte <strong>obrat za 12 měsíců</strong> a kolik zbývá do limitu 2 mil. Kč. Až se stanete plátcem, přepnete to v sekci DPH — teprve pak se DPH pole na dokladech aktivně používají a systém začne hlídat náležitosti daňových dokladů a kontrolní hlášení (doklady nad 10 000 Kč).</p>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h2>QR platba na faktuře</h2>
        <p>U každého dokladu (Doklady → Detail / QR) lze zobrazit <strong>QR platbu</strong> ve standardu české bankovní asociace (SPD). Zákazník ji naskenuje v mobilním bankovnictví a platba se předvyplní. Pro vydané faktury nejdřív doplňte svůj <strong>IBAN v Nastavení</strong>; pro přijaté faktury IBAN dodavatele u kontaktu.</p>
      </div>
      <div class="panel">
        <h2>Import bankovního výpisu (dohnání účetnictví)</h2>
        <p>V sekci <strong>Banka a pokladna → Importovat výpis</strong> nahrajete výpis z internetového bankovnictví ve formátu <strong>CSV</strong> nebo <strong>camt.053 XML</strong> (ISO 20022 — podporuje KB, ČSOB, Fio, Air Bank, Raiffeisenbank a další). Řádky se nahrají hromadně, u CSV si jen zkontrolujete přiřazení sloupců. Pak tlačítkem <strong>Navrhnout párování</strong> systém sám navrhne spárování plateb s doklady podle variabilního symbolu a částky — ideální pro zpětné doplnění více měsíců najednou.</p>
      </div>
      <div class="panel">
        <h2>Výkazy a roční uzávěrka</h2>
        <p><strong>Výkazy</strong> — rozvaha (majetek vs. zdroje) a výsledovka (náklady vs. výnosy) ve zjednodušeném rozsahu pro mikro účetní jednotku. Systém kontroluje, že aktiva = pasiva.</p>
        <p><strong>Inventarizace</strong> — k rozvahovému dni vygenerujete inventurní soupis, doplníte fyzicky zjištěné stavy, a nakonec <strong>uzavřete období</strong>. Po uzavření už do něj nelze zapisovat (§ 29–30 ZoÚ).</p>
      </div>
    </div>

    <div class="panel">
      <h2>Význam základních účtů (startovní rozvrh)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Účet</th><th>Název</th><th>K čemu slouží</th></tr></thead>
        <tbody>
          <tr><td class="mono">211</td><td>Pokladna</td><td>Hotovost (honoráře DJ, zvukařům)</td></tr>
          <tr><td class="mono">221</td><td>Bankovní účet</td><td>Veškeré bankovní transakce</td></tr>
          <tr><td class="mono">311</td><td>Odběratelé</td><td>Pohledávky — kdo dluží nám (vstupenky, sponzoring)</td></tr>
          <tr><td class="mono">321</td><td>Dodavatelé</td><td>Závazky — komu dlužíme (pronájmy, technika)</td></tr>
          <tr><td class="mono">343</td><td>DPH</td><td>Zúčtování daně (aktivní až po registraci)</td></tr>
          <tr><td class="mono">518</td><td>Ostatní služby</td><td>Pronájmy, technika, právní/účetní služby</td></tr>
          <tr><td class="mono">602</td><td>Tržby ze služeb</td><td>Vstupenky, sponzoring, produkční služby</td></tr>
        </tbody>
      </table></div>
      <p class="text-dim" style="margin-top:12px">Účty 5xx jsou <strong>náklady</strong> (co utrácíme), účty 6xx jsou <strong>výnosy</strong> (co vyděláváme). Rozdíl výnosů a nákladů = výsledek hospodaření.</p>
    </div>

    <div class="panel">
      <h2>Kde jsou uložená data</h2>
      <p>Databáze je jeden soubor <span class="mono">ucetnictvi.sqlite</span> ve složce <span class="mono">%APPDATA%\\globaal-elevate-ucetnictvi</span>. Přežívá aktualizace i přeinstalaci aplikace. Doporučujeme pravidelnou zálohu (kopii souboru) — zákonná archivační lhůta je 5–10 let. Data lze také kdykoliv vyexportovat do CSV (Výkazy, Audit log, atd.) pro předání účetní nebo auditorovi.</p>
    </div>
  `;
}

// =====================================================================
// MODAL helpers
// =====================================================================
function showModal(html) {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "modalBackdrop";
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
}
function closeModal() {
  document.getElementById("modalBackdrop")?.remove();
}

// =====================================================================
// EVENT DELEGATION
// =====================================================================
document.addEventListener("click", async (e) => {
  const navItem = e.target.closest("[data-nav]");
  if (navItem) { location.hash = "#" + navItem.dataset.nav; return; }

  const action = e.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  const id = e.target.closest("[data-id]")?.dataset.id;

  try {
    switch (action) {
      case "new-document": documentFormModal(); break;
      case "new-posting": postingFormModal(); break;
      case "new-account": accountFormModal(); break;
      case "new-contact": contactFormModal(); break;
      case "new-project": projectFormModal(); break;
      case "new-bank-line": bankLineFormModal(); break;
      case "import-bank": bankImportModal(); break;
      case "csv-parse": csvParseRows(); break;
      case "confirm-import": await confirmBankImport(); break;
      case "suggest-matches": await suggestMatches(); break;
      case "confirm-match": {
        const el = e.target.closest("[data-bank]");
        await api("POST", `/bank/${el.dataset.bank}/match`, { document_id: el.dataset.doc });
        toast("Pohyb spárován."); renderBank(); break;
      }
      case "new-asset": assetFormModal(); break;
      case "new-inventory": inventoryFormModal(); break;
      case "new-template": templateFormModal(); break;
      case "close-modal": closeModal(); break;
      case "auth-tab": AUTH_TAB = e.target.closest("[data-tab]").dataset.tab; renderAuthScreen(); break;
      case "logout": e.preventDefault(); await handleLogout(); break;
      case "add-posting-line": addPostingLineRow(); break;
      case "add-template-line": addTemplateLineRow(); break;

      case "ares-fill": await aresFillContact(); break;
      case "ares-search": await aresSearch(); break;
      case "ares-pick": await aresPickAndOpen(e.target.closest("[data-ico]").dataset.ico); break;
      case "doc-detail": await showDocumentDetail(id); break;
      case "load-qr": await loadDocumentQr(id); break;
      case "delete-template": {
        if (!confirm("Smazat předkontaci?")) break;
        await api("DELETE", `/templates/${id}`); toast("Předkontace smazána."); renderTemplates(); break;
      }
      case "delete-project": {
        if (!confirm("Smazat projekt? Tuto akci nelze vzít zpět.")) break;
        try {
          await api("DELETE", `/projects/${id}`);
          toast("Projekt byl smazán.");
        } catch (err) {
          if (confirm(err.message + "\n\nDeaktivovat projekt místo trvalého smazání?")) {
            await api("PUT", `/projects/${id}`, { active: false });
            toast("Projekt byl deaktivován.");
          }
        }
        renderProjects();
        break;
      }

      case "approve-doc": await api("POST", `/documents/${id}/approve`, { approved_by: STATE.user.id }); toast("Doklad schválen."); renderDocuments(); break;
      case "storno-doc": {
        const reason = prompt("Důvod storna dokladu:");
        if (reason === null) break;
        await api("POST", `/documents/${id}/storno`, { reason, user_id: STATE.user.id });
        toast("Doklad byl stornován."); renderDocuments(); break;
      }
      case "post-doc": await postDocumentModal(id); break;
      case "view-posting": showPostingDetail(id); break;
      case "storno-posting": {
        const reason = prompt("Důvod storna zápisu:");
        if (reason === null) break;
        await api("POST", `/postings/${id}/storno`, { reason, created_by: STATE.user.id });
        toast("Zápis byl stornován."); renderJournal(); break;
      }
      case "delete-contact": {
        if (!confirm("Smazat kontakt?")) break;
        await api("DELETE", `/contacts/${id}`); toast("Kontakt smazán."); renderContacts(); break;
      }
      case "depreciate-asset": await handleDepreciateAsset(id); break;
      case "view-inventory": showInventoryDetail(id); break;
      case "save-inventory-lines": saveInventoryLines(id); break;
      case "close-period": handleClosePeriod(id); break;
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

document.addEventListener("submit", async (e) => {
  const formType = e.target.dataset.form;
  if (!formType) return;
  e.preventDefault();
  try {
    switch (formType) {
      case "create-document": await handleCreateDocument(e.target); break;
      case "create-posting": await handleCreatePosting(e.target); break;
      case "create-account": await handleCreateAccount(e.target); break;
      case "create-contact": await handleCreateContact(e.target); break;
      case "create-template": await handleCreateTemplate(e.target); break;
      case "post-document": await handlePostDocument(e.target); break;
      case "create-project": await handleCreateProject(e.target); break;
      case "create-bank-line": await handleCreateBankLine(e.target); break;
      case "create-asset": await handleCreateAsset(e.target); break;
      case "create-inventory": await handleCreateInventory(e.target); break;
      case "toggle-vat": await handleToggleVat(e.target); break;
      case "update-unit": await handleUpdateUnit(e.target); break;
      case "add-user": await handleAddUser(e.target); break;
      case "upload-attachment": await handleUploadAttachment(e.target); break;
      case "auth-login": await handleAuthLogin(e.target); break;
      case "auth-set-password": await handleAuthSetPassword(e.target); break;
      case "auth-register-company": await handleAuthRegisterCompany(e.target); break;
      case "auth-bankid-start": await handleAuthBankidStart(e.target); break;
      case "auth-bankid-callback": await handleAuthBankidCallback(e.target); break;
      case "accept-invite": await handleAcceptInvite(e.target); break;
      case "invite-colleague": await handleInviteColleague(e.target); break;
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

window.addEventListener("error", (e) => console.error("Neošetřená chyba:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => console.error("Neošetřené odmítnutí promise:", e.reason));

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", checkAuthAndStart);

async function checkAuthAndStart() {
  const inviteMatch = location.hash.match(/^#accept-invite=(.+)$/);
  if (inviteMatch) return renderAcceptInviteScreen(inviteMatch[1]);

  // Návrat z reálného BankID OIDC přihlášení (viz server/routes/auth.js handleBankidOidcCallback).
  const bankidLoginMatch = location.hash.match(/^#bankid-login=(.+)$/);
  if (bankidLoginMatch) {
    setAuthToken(bankidLoginMatch[1]);
    location.hash = "";
  }
  const bankidErrorMatch = location.hash.match(/^#bankid-error=(.+)$/);
  if (bankidErrorMatch) {
    location.hash = "";
    AUTH_TAB = "bankid";
    renderAuthScreen();
    const errBox = document.getElementById("authError");
    if (errBox) errBox.textContent = decodeURIComponent(bankidErrorMatch[1]);
    return;
  }

  let user;
  try {
    ({ user } = await api("GET", "/auth/me"));
  } catch (err) {
    renderAuthScreen();
    return;
  }
  STATE.authUser = user;
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  try {
    await bootstrap();
    router();
  } catch (err) {
    console.error("Chyba při startu aplikace:", err);
    document.getElementById("view").innerHTML = `<div class="panel"><h2>Chyba při startu</h2><p>${esc(err.message)}</p></div>`;
  }
}
