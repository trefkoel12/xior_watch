// ============================================================
//  Xior Groningen availability watcher  —  VERSION v3
//  If the log does not start with "=== xior check.mjs v3 ===",
//  GitHub is still running an older copy of this file.
// ============================================================
//
// Phase 1 (every run): load each page patiently, decide sold-out vs open.
// Phase 2 (only on change): look deeper, then message you on Telegram.
// Everything is time-boxed so a single stuck step can never hang the run.

import { chromium } from 'playwright';
import fs from 'node:fs';

const VERSION = 'v3';
console.log(`=== xior check.mjs ${VERSION} ===`);

const TARGETS = [
  { id:'eendrachtskade',   label:'Eendrachtskade — TOP TARGET (Comfy studio, from €615 base)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/eendrachtskade-student-accommodation/' },
  { id:'zernike-tower',    label:'Zernike Tower (from €690 base)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-student-accommodation/' },
  { id:'oosterhamrikkade', label:'Oosterhamrikkade (from €866 base)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/oosterhamrikkade-student-accommodation/' },
  { id:'zernike-short',    label:'Zernike Tower Short Stay (6-month, ~€1,370 all-in)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-short-stay/' },
  { id:'overview',         label:'Xior Groningen overview (release banners)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/' },
  { id:'social-hub',       label:'The Social Hub Groningen (student booking)',
    url:'https://www.thesocialhub.co/book-student-room/?hotelId=GRO01' },
];

// Wording that means "nothing bookable right now".
const SOLD_OUT = /(fully booked|full for now|volgeboekt|no rooms available|geen kamers beschikbaar|bookings open soon|currently unavailable)/i;
// Wording that proves the real page (not Cloudflare's holding screen) has rendered.
const READY = /(check availability|fully booked|full for now|volgeboekt|geen kamers|book now|bookings open|student stay|room type|see you in|get notified)/i;

const STATE_FILE = 'state.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const NTFY     = process.env.NTFY_TOPIC;

console.log(`telegram configured: ${TG_TOKEN ? 'token yes' : 'TOKEN MISSING'} / ${TG_CHAT ? 'chat id yes' : 'CHAT ID MISSING'}`);

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } };

// Never let one step stall the whole run.
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
]);

function signal(text) {
  return {
    soldOut: SOLD_OUT.test(text),
    prices: [...text.matchAll(/€\s?\d[\d.,]*/g)].map(m=>m[0].replace(/\s/g,'')).slice(0,40).join('|'),
    dates:  [...text.matchAll(/\b\d{1,2}[-/ ](?:[A-Za-z]{3,9}|\d{1,2})[-/ ]\d{2,4}\b/g)].map(m=>m[0]).slice(0,20).join('|'),
  };
}

async function sendText(title, body) {
  console.log(`notify: ${title}`);
  if (!TG_TOKEN && !TG_CHAT && !NTFY) { console.warn('!! No notification channel configured — nothing will be sent.'); return; }
  if (NTFY) {
    try {
      const r = await fetch(`https://ntfy.sh/${NTFY}`, { method:'POST', headers:{ Title:title, Priority:'urgent' }, body, signal: AbortSignal.timeout(15000) });
      console.log('  ntfy status', r.status);
    } catch (e) { console.error('  ntfy failed:', e.message); }
  }
  if (TG_TOKEN && TG_CHAT) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ chat_id: TG_CHAT, text: `${title}\n\n${body}`.slice(0,4000) }),
        signal: AbortSignal.timeout(15000),
      });
      console.log('  telegram status', r.status, r.ok ? '(sent)' : `(FAILED: ${(await r.text()).slice(0,200)})`);
    } catch (e) { console.error('  telegram failed:', e.message); }
  }
}

async function sendPhoto(png, caption) {
  if (!(TG_TOKEN && TG_CHAT) || !png) return;
  try {
    const form = new FormData();
    form.append('chat_id', TG_CHAT);
    form.append('caption', caption.slice(0,1000));
    form.append('photo', new Blob([png], { type:'image/png' }), 'availability.png');
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method:'POST', body: form, signal: AbortSignal.timeout(30000) });
    console.log('  telegram photo status', r.status);
  } catch (e) { console.error('  telegram photo failed:', e.message); }
}

// Load a page and wait until the REAL content appears. Cloudflare serves a
// 13-character "Just a moment" screen first; reading that as "no rooms" would
// be wrong, so an unresolved page is reported as a failure instead.
async function loadReady(page, url, attempts = 2, polls = 7) {
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    try { await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 }); } catch (e) { console.log(`  goto issue: ${e.message.slice(0,60)}`); }
    for (let n = 0; n < polls; n++) {
      await page.waitForTimeout(3000);
      last = await page.evaluate(() => document.body ? document.body.innerText : '').catch(()=> '');
      if (last.length > 800 && READY.test(last)) return last.replace(/\s+/g,' ').trim();
    }
    console.log(`  attempt ${i}: only ${last.length} chars ("${last.slice(0,30).replace(/\s+/g,' ')}")`);
  }
  throw new Error(`no real content (last ${last.length} chars: "${last.slice(0,40).replace(/\s+/g,' ')}")`);
}

// Best-effort look inside the booking widget. Strictly optional: if any of it
// fails we still send the alert with the plain property link.
async function deepCapture(ctx, t) {
  const res = { rows: [], deepest: t.url, shot: null, note: '' };
  const page = await ctx.newPage();
  try {
    await loadReady(page, t.url);
    for (const rx of [/check availability/i, /book now/i, /start booking/i]) {
      const btn = page.getByRole('button', { name: rx }).first();
      if (await btn.count().catch(()=>0)) { await btn.click({ timeout:6000 }).catch(()=>{}); await page.waitForTimeout(3000); }
    }
    if (page.url() !== t.url) res.deepest = page.url();
    const text = await page.evaluate(() => document.body.innerText).catch(()=> '');
    res.rows = text.split('\n').map(l=>l.trim()).filter(l => l.length>3 && l.length<160 && /€\s?\d/.test(l)).slice(0,25);
    const href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(a => /book|reserve|boek/i.test(a.textContent||'') && a.href && !a.href.endsWith('#'));
      return a ? a.href : null;
    }).catch(()=> null);
    if (href) res.deepest = href;
    res.shot = await page.screenshot({ fullPage:false, timeout:20000 }).catch(()=> null);
    if (!res.rows.length) res.note = 'Could not read a unit table automatically — open the link and look.';
  } catch (e) {
    res.note = `Deep look failed (${e.message.slice(0,100)}). Use the property link.`;
  } finally { await page.close().catch(()=>{}); }
  return res;
}

const prev = readState();
const next = {};
const changed = [];
let failures = 0;
let browser;

try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent:UA, viewport:{width:1440,height:900}, locale:'en-GB' });

  console.log('--- phase 1: checking pages ---');
  for (const t of TARGETS) {
    const page = await ctx.newPage();
    try {
