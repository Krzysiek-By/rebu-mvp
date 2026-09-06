const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const dns = require('dns').promises;

function safeCode(err) {
  return String(err?.code || err?.responseCode || err?.name || 'UNKNOWN').slice(0, 80);
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'email-connect', version: '13.54' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, message: 'Methode nicht erlaubt.' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const appPassword = String(req.body?.appPassword || '');

  if (!email || !/^[^\s@]+@gmx\.(de|net|com)$/i.test(email) || !appPassword) {
    return res.status(400).json({ ok: false, stage: 'input', message: 'E-Mail-Adresse oder Anwendungspasswort fehlt.' });
  }

  try {
    await Promise.all([
      dns.lookup('imap.gmx.net'),
      dns.lookup('mail.gmx.net')
    ]);
  } catch (err) {
    return res.status(502).json({
      ok: false,
      stage: 'dns',
      code: safeCode(err),
      message: 'Der Sekretarz-Server kann die GMX-Server derzeit nicht auflösen.'
    });
  }

  let imap;
  try {
    imap = new ImapFlow({
      host: 'imap.gmx.net',
      port: 993,
      secure: true,
      auth: { user: email, pass: appPassword },
      logger: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 12000,
      tls: { minVersion: 'TLSv1.2' }
    });
    await imap.connect();
    await imap.logout();
  } catch (err) {
    try { if (imap?.usable) await imap.logout(); } catch (_) {}
    return res.status(502).json({
      ok: false,
      stage: 'imap',
      code: safeCode(err),
      message: 'IMAP-Verbindung fehlgeschlagen. GMX-Zugriff und Anwendungspasswort sind eingerichtet; jetzt prüfen wir den technischen Serverfehler.'
    });
  }

  try {
    const smtp = nodemailer.createTransport({
      host: 'mail.gmx.net',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: email, pass: appPassword },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 12000,
      tls: { minVersion: 'TLSv1.2' }
    });
    await smtp.verify();
  } catch (err) {
    return res.status(502).json({
      ok: false,
      stage: 'smtp',
      code: safeCode(err),
      message: 'IMAP funktioniert, aber SMTP konnte nicht bestätigt werden.'
    });
  }

  return res.status(200).json({ ok: true, imap: true, smtp: true, version: '13.54' });
};
