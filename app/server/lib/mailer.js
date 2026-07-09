// =====================================================================
// mailer.js — odesílání e-mailů přes SMTP (nodemailer). Konfigurace čistě
// přes env proměnné (stejný princip jako BankID) — bez nich odešle
// jasnou chybu, žádné tiché mock chování u reálné komunikace se zákazníky.
// =====================================================================
const nodemailer = require("nodemailer");

let transporter = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) {
    throw new Error("Odesílání e-mailů není nakonfigurováno — chybí SMTP_HOST/SMTP_USER/SMTP_PASS (viz .env.example).");
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendInvoiceEmail({ to, subject, text, pdfBuffer, fileName }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await getTransporter().sendMail({
    from, to, subject, text,
    attachments: [{ filename: fileName, content: pdfBuffer, contentType: "application/pdf" }],
  });
}

module.exports = { isConfigured, sendInvoiceEmail };
