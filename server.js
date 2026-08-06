'use strict';

const express    = require('express');
const cron       = require('node-cron');
const fetch      = require('node-fetch');
const xml2js     = require('xml2js');
const fs         = require('fs');
const path       = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const DATA_DIR   = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const FORM_KEY   = 'b244862f0ddf93bb7931b59b904ba312';
const EMAIL_TO   = 'isb.faruk.bas@gmail.com';

// ── ensure data/ folder exists ──────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));          // serves index.html

// ── helper: read state ──────────────────────────────────────
function readState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { list: [], sigs: [], todayCount: 0, day: '' };
}

// ── helper: write state ─────────────────────────────────────
function writeState(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── helper: send email via FormSubmit ───────────────────────
async function sendEmail(subject, message) {
  const res = await fetch(`https://formsubmit.co/ajax/${FORM_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _subject: subject, email: EMAIL_TO, message })
  });
  return res.json();
}

// ════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ════════════════════════════════════════════════════════════

// GET /api/rate  — TCMB gerçek USD/TRY kuru
app.get('/api/rate', async (_req, res) => {
  try {
    const r   = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml',
                            { headers: { 'User-Agent': 'TradePulseTR/1.0' }, timeout: 8000 });
    const xml = await r.text();
    const parsed = await xml2js.parseStringPromise(xml);
    const currencies = parsed.Tarih_Date.Currency;
    const usd  = currencies.find(c => c.$.CurrencyCode === 'USD');
    const rate = parseFloat(usd.ForexSelling[0]);
    console.log(`[TCMB] USD/TRY: ${rate}`);
    res.json({ rate, source: 'TCMB', date: new Date().toISOString() });
  } catch (e) {
    console.warn('[TCMB] Fallback rate used:', e.message);
    res.json({ rate: 38.50, source: 'fallback', date: new Date().toISOString() });
  }
});

// GET /api/state  — Kaydedilmiş durumu yükle
app.get('/api/state', (_req, res) => {
  res.json(readState());
});

// POST /api/state  — Durumu kaydet
app.post('/api/state', (req, res) => {
  try {
    writeState(req.body);
    res.json({ ok: true, saved: (req.body.list || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email  — Manuel rapor maili gönder
app.post('/api/email', async (req, res) => {
  try {
    const { subject, message } = req.body;
    const data = await sendEmail(subject, message);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ping  — Render uyku önleyici / sağlık kontrolü
app.get('/api/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ════════════════════════════════════════════════════════════
//  CRON JOBS
// ════════════════════════════════════════════════════════════

// Her gün 09:00 İstanbul saatiyle günlük rapor maili
cron.schedule('0 9 * * *', async () => {
  console.log('[CRON] 09:00 günlük rapor tetiklendi.');
  const state = readState();
  const list  = state.list || [];

  const top5 = list
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5)
    .map((p, i) =>
      `${i + 1}. ${p.title}\n` +
      `   Net Kâr : ₺${(p.netProfit || 0).toLocaleString('tr-TR')}\n` +
      `   Kâr Marjı: %${p.margin || 0}\n` +
      `   YZ Skoru : ${p.score || 0}/100 ${p.label || ''}`
    ).join('\n\n');

  const body =
    `Sayın Faruk Baş,\n\n` +
    `TradePulse TR Yapay Zekâ Sistemi — Sabah 09:00 Otomatik Günlük Raporu\n` +
    `Tarih: ${new Date().toLocaleDateString('tr-TR')}\n\n` +
    `🏆 TOP 5 ŞAMPİYON ÜRÜN:\n\n${top5 || 'Henüz tarama tamamlanmadı.'}\n\n` +
    `Toplam Veritabanı: ${list.length} ürün\n` +
    `Bugün Taranan: ${state.todayCount || 0}/100\n\n` +
    `Detaylı analiz için sisteme giriş yapın.\n\nTradePulse TR YZ Sistemi`;

  try {
    await sendEmail(
      `🏆 TradePulse TR — Sabah 09:00 Günlük YZ Raporu (${new Date().toLocaleDateString('tr-TR')})`,
      body
    );
    console.log('[CRON] Günlük rapor e-postası gönderildi →', EMAIL_TO);
  } catch (e) {
    console.error('[CRON] E-posta hatası:', e.message);
  }
}, { timezone: 'Europe/Istanbul' });

// Her 10 dakikada bir /api/ping çekerek Render'ın uyumasını engelle
cron.schedule('*/10 * * * *', async () => {
  try {
    await fetch(`http://localhost:${PORT}/api/ping`);
    console.log('[KEEP-ALIVE] ping OK');
  } catch (_) {}
});

// ════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 TradePulse TR sunucu başladı → http://localhost:${PORT}`);
  console.log(`   Veri dosyası : ${STATE_FILE}`);
  console.log(`   Cron 09:00   : Günlük rapor maili AKTIF\n`);
});
