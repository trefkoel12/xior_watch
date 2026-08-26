// Xior Groningen availability watcher — two-phase.
//
// Phase 1 (every run, cheap): load each page, read text, look for the
//   "fully booked" wording. One page load per target, no interaction.
// Phase 2 (only when phase 1 sees a change): walk INTO the booking widget,
//   read the unit table, capture the deepest reachable URL, screenshot it,
//   and send all of that to your phone.
//
// Phase 2 is deliberately rare: it keeps normal runs light and keeps our
// footprint on Xior's site minimal (they actively block booking bots).

import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGETS = [
  { id: 'eendrachtskade',    label: 'Eendrachtskade — TOP TARGET (Comfy studio, from €615 base)',
    url: 'https://www.xiorstudenthousing.eu/netherlands/groningen/eendrachtskade-student-accommodation/' },
  { id: 'zernike-tower',     label: 'Zernike Tower (from €690 base)',
    url: 'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-student-accommodation/' },
  { id: 'oosterhamrikkade',  label: 'Oosterhamrikkade (from €866 base)',
    url: 'https://www.xiorstudenthousing.eu/netherlands/groningen/oosterhamrikkade-student-accommodation/' },
  { id: 'zernike-short',     label: 'Zernike Tower Short Stay (6-month, ~€1,370 all-in)',
    url: 'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-short-stay/' },
  { id: 'overview',          label: 'Xior Groningen overview (release banners)',
    url: 'https://www.xiorstudenthousing.eu/netherlands/groningen/' },
  { id: 'social-hub',        label: 'The Social Hub Groningen (student booking)',
    url: 'https://www.thesocialhub.co/book-student-room/?hotelId=GRO01' },
];

const SOLD_OUT = /(fully booked|full for now|volgeboekt|no rooms available|geen kamers beschikbaar|bookings open soon|currently unavailable)/i;
const STATE_FILE = 'state.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const NTFY     = process.env.NTFY_TOPIC;

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } };

function signal(text) {
  return {
    soldOut: SOLD_OUT.test(text),
    prices: [...text.matchAll(/€\s?\d[\d.,]*/g)].map(m=>m[0].replace(/\s/g,'')).slice(0,40).join('|'),
    dates:  [...text.matchAll(/\b\d{1,2}[-/ ](?:[A-Za-z]{3,9}|\d{1,2})[-/ ]\d{2,4}\b/g)].map(m=>m[0]).slice(0,20).join('|'),
  };
}

async function sendText(title, body) {
  const jobs = [];
  if (NTFY) jobs.push(fetch(`https://ntfy.sh/${NTFY}`, {
    method:'POST', headers:{ Title:title, Priority:'urgent', Tags:'house,rotating_light' }, body,
  }).catch(e=>console.error('ntfy:', e.message)));
  if (TG_TOKEN && TG_CHAT) jobs.push(fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ chat_id: TG_CHAT, text: `${title}\n\n${body}`.slice(0,4000) }),
  }).catch(e=>console.error('telegram:', e.message)));
  if (!jobs.length) console.warn('No notification channel configured.');
  await Promise.all(jobs);
}

async function sendPhoto(png, caption) {
  if (!(TG_TOKEN && TG_CHAT)) return;
  try {
    const form = new FormData();
    form.append('chat_id', TG_CHAT);
    form.append('caption', caption.slice(0,1000));
    form.append('photo', new Blob([png], { type:'image/png' }), 'availability.png');
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method:'POST', body: form });
  } catch (e) { console.error('telegram photo:', e.message); }
}

// Phase 2 — walk as deep into the booking funnel as we can WITHOUT submitting
// anything, and report the furthest URL reached plus what we saw there.
async function deepCapture(ctx, t) {
  const page = await ctx.newPage();
  const res = { rows: [], deepest: t.url, shot: null, note: '' };
  try {
    await page.goto(t.url, { waitUntil:'domcontentloaded', timeout:60000 });
    await page.waitForTimeout(4000);

    // Any new tab the widget opens becomes our deepest reachable point.
    ctx.on('page', async p => { try { await p.waitForLoadState('domcontentloaded', {timeout:15000}); res.deepest = p.url(); } catch {} });

    // Step into the availability widget.
    for (const rx of [/check availability/i, /availability/i, /book now/i, /start booking/i, /select/i]) {
      const btn = page.getByRole('button', { name: rx }).or(page.getByRole('link', { name: rx })).first();
      if (await btn.count().catch(()=>0)) {
        await btn.click({ timeout: 8000 }).catch(()=>{});
        await page.waitForTimeout(3500);
      }
    }

    if (page.url() !== t.url) res.deepest = page.url();

    // Pull anything that looks like a unit row: has a € figure or a date.
    const text = await page.evaluate(() => document.body.innerText);
    res.rows = text.split('\n').map(l=>l.trim())
      .filter(l => l.length > 3 && l.length < 160 && /€\s?\d/.test(l))
      .slice(0, 25);

    // Any explicit booking link on the page is the best deep link we can offer.
    const href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')]
        .find(a => /book|reserve|boek/i.test(a.textContent || '') && a.href && !a.href.endsWith('#'));
      return a ? a.href : null;
    });
    if (href) res.deepest = href;

    res.shot = await page.screenshot({ fullPage: false }).catch(()=>null);
    if (!res.rows.length) res.note = 'Could not read a unit table automatically — open the link and check manually.';
  } catch (e) {
    res.note = `Deep capture failed (${e.message.slice(0,120)}). Use the property link.`;
  } finally {
    await page.close().catch(()=>{});
  }
  return res;
}

const prev = readState();
const next = {};
const changed = [];
let failures = 0;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport:{ width:1440, height:900 }, locale:'en-GB' });

// ---- Phase 1: cheap check ----
for (const t of TARGETS) {
  const page = await ctx.newPage();
  try {
    await page.goto(t.url, { waitUntil:'domcontentloaded', timeout:60000 });
    await page.waitForTimeout(4500);
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g,' ').trim();
    if (text.length < 200) throw new Error(`short page (${text.length} chars) — likely blocked`);

    const sig = signal(text);
    next[t.id] = { ...sig, ok:true, checked:new Date().toISOString() };
    const old = prev[t.id];

    if (old?.ok && old.soldOut && !sig.soldOut)      changed.push({ t, kind:'OPEN' });
    else if (!old && !sig.soldOut)                    changed.push({ t, kind:'OPEN' });
    else if (old?.ok && (old.prices !== sig.prices || old.dates !== sig.dates))
                                                      changed.push({ t, kind:'EDIT' });
    console.log(`${sig.soldOut ? 'soldout  ' : 'OPEN?    '} ${t.id}`);
  } catch (e) {
    failures++;
    next[t.id] = { ...(prev[t.id]||{}), ok:false, error:String(e.message).slice(0,200), checked:new Date().toISOString() };
    console.error(`FAILED ${t.id}: ${e.message}`);
  } finally { await page.close().catch(()=>{}); }
}
