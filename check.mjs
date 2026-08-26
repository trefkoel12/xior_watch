// ============================================================
//  Xior Groningen availability watcher  —  VERSION v10
//  Log must start with "=== xior check.mjs v10 ===".
// ============================================================
//
//  How it decides:
//   - Loads the overview page first to pick up cookies (beats the 403).
//   - Opens the "Check availability" pop-up, and reads INSIDE the booking
//     widget's iframe, which is where the real answer lives.
//   - Only claims rooms are open on positive proof (a unit table), never on
//     the mere absence of the words "fully booked".
//   - On the 1st of the month it re-checks every minute for the whole run.

import { chromium } from 'playwright';
import fs from 'node:fs';

const VERSION = 'v10';
console.log(`=== xior check.mjs ${VERSION} ===`);

// Order matters: 'overview' is loaded first purely to warm up cookies.
const TARGETS = [
  { id:'overview',         label:'Xior Groningen overview (release banners)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/' },
  { click:true, id:'eendrachtskade',   label:'Eendrachtskade — TOP TARGET (Comfy studio, from €615 base)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/eendrachtskade-student-accommodation/' },
  { click:true, id:'zernike-tower',    label:'Zernike Tower (from €690 base)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-student-accommodation/' },
  { click:true, id:'oosterhamrikkade', label:'Oosterhamrikkade (from €866 base)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/oosterhamrikkade-student-accommodation/' },
  { click:true, id:'zernike-short',    label:'Zernike Tower Short Stay (6-month, ~€1,370 all-in)',
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-short-stay/' },
  { id:'social-hub',       label:'The Social Hub Groningen (student booking)',
    url:'https://www.thesocialhub.co/book-student-room/?hotelId=GRO01' },
];

const SOLD_OUT = /(fully booked|full for now|volgeboekt|no rooms available|geen kamers beschikbaar|bookings open soon|currently unavailable|notified when a room becomes available)/i;
// Positive proof that actual units are listed. These words only appear in the
// unit table itself (Room number | m2 | Contract start date | Basic rent),
// never on a page that is merely offering a "check availability" button.
const WIDGET   = /(contract start|room number|basic rent|kamernummer|beschikbare kamers)/i;
// A page is only trustworthy once one of these appears.
const READY    = new RegExp(`(${SOLD_OUT.source})|(${WIDGET.source})|(check availability|student stay|bookings open)`, 'i');

// Wording that hints at a future release — worth telling you about early.
const ANNOUNCE = /(early '2[67]|coming soon|opens? on|open soon|available from|januar|februar|jan 202[67]|feb 202[67]|202[67])/gi;

const STATE_FILE = 'state.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const NTFY     = process.env.NTFY_TOPIC;

console.log(`telegram configured: ${TG_TOKEN ? 'token yes' : 'TOKEN MISSING'} / ${TG_CHAT ? 'chat id yes' : 'CHAT ID MISSING'}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Xior does not put "fully booked" anywhere we can read on three of the
// pages, so instead of interpreting wording we fingerprint the room-offer
// section itself. Rooms appearing MUST change it, so a changed fingerprint
// is the signal — no wording required.
function offerSlice(text) {
  const i = text.search(/stays that suit your needs/i);
  if (i < 0) return null;                     // no room-offer section: don't fingerprint
  const raw = text.slice(i, i + 4000).toLowerCase();
  return raw.replace(/[^a-z0-9€ ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function fingerprint(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } };
const saveState = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
]);

function signal(text, staticText) {
  const soldOut = SOLD_OUT.test(text);
  const slice = offerSlice(staticText || text);
  return {
    soldOut,
    offer: slice ? fingerprint(slice) : null,
    offerLen: slice ? slice.length : 0,
    open: WIDGET.test(text) && !soldOut,   // positive proof, not absence of bad news
    announce: [...new Set((text.match(ANNOUNCE) || []).map(x => x.toLowerCase()))].sort().join('|'),
    prices: [...text.matchAll(/€\s?\d[\d.,]*/g)].map(m=>m[0].replace(/\s/g,'')).slice(0,40).join('|'),
    dates:  [...text.matchAll(/\b\d{1,2}[-/ ](?:[A-Za-z]{3,9}|\d{1,2})[-/ ]\d{2,4}\b/g)].map(m=>m[0]).slice(0,20).join('|'),
  };
}

async function sendText(title, body) {
  console.log(`notify: ${title}`);
  if (!TG_TOKEN && !TG_CHAT && !NTFY) { console.warn('!! No notification channel configured.'); return; }
  if (NTFY) {
    try { const r = await fetch(`https://ntfy.sh/${NTFY}`, { method:'POST', headers:{ Title:title, Priority:'urgent' }, body, signal: AbortSignal.timeout(15000) }); console.log('  ntfy status', r.status); }
    catch (e) { console.error('  ntfy failed:', e.message); }
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

// Xior sits behind Cloudflare: expect "403 Forbidden" or a short holding page
// before the real content. Retry patiently rather than believing the first reply.
async function loadReady(page, url, attempts = 4, polls = 6) {
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    try { await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 }); }
    catch (e) { console.log(`  goto issue: ${e.message.slice(0,60)}`); }
    for (let n = 0; n < polls; n++) {
      await sleep(2500);
      last = await page.evaluate(() => document.body ? document.body.innerText : '').catch(()=> '');
      if (last.length > 800 && READY.test(last)) return last.replace(/\s+/g,' ').trim();
    }
    console.log(`  attempt ${i}: only ${last.length} chars ("${last.slice(0,30).replace(/\s+/g,' ')}")`);
    if (i < attempts) await sleep(5000 * i);   // back off before trying again
  }
  throw new Error(`no real content (last ${last.length} chars: "${last.slice(0,40).replace(/\s+/g,' ')}")`);
}

// A cookie bar or the "view this page in Français" prompt can sit on top of
// the page and eat the click that opens the availability widget.
async function dismissBanners(page) {
  for (const rx of [/^accept/i, /accept all/i, /akkoord/i, /^agree/i, /allow all/i, /continue in english/i, /^stay/i]) {
    const b = page.getByRole('button', { name: rx }).first();
    if (await b.count().catch(()=>0)) { await b.click({ timeout:3000 }).catch(()=>{}); await sleep(700); }
  }
}

// The booking widget renders inside an iframe, so the main document's text
// does not contain it. Gather text from every frame on the page.
async function allText(page) {
  const parts = [];
  for (const f of page.frames()) {
    const t = await f.evaluate(() => document.body ? document.body.innerText : '').catch(()=> '');
    if (t && t.trim()) parts.push(t);
  }
  return parts.join(' \n ').replace(/\s+/g,' ').trim();
}

// Xior hides the real answer behind the "Check availability" button: the page
// itself always shows that button, and only the pop-up says either "fully
// booked" or lists bookable units. So we open it, exactly as a person would.
async function readTarget(page, t) {
  const apiTexts = [], apiUrls = [];
  page.on('response', async (r) => {
    try {
      const u = r.url();
      if (!/avail|unit|room|lease|rentcafe|yardi|booking/i.test(u)) return;
      if (!/json|javascript|text/i.test(r.headers()['content-type'] || '')) return;
      const b = await r.text();
      if (b && b.length > 20 && b.length < 300000) { apiUrls.push(u.replace(/^https?:\/\//,'').slice(0,70)); apiTexts.push(b.slice(0,6000)); }
    } catch {}
  });
  const staticText = await loadReady(page, t.url);
  let text = staticText;
  if (!t.click) return { text, staticText };
  await dismissBanners(page);
  const cands = page.getByRole('button', { name: /check availability/i })
                    .or(page.getByRole('link', { name: /check availability/i }));
  const n = await cands.count().catch(()=>0);
  console.log(`  ${t.id}: ${n} "check availability" control(s)`);

  for (let k = 0; k < Math.min(n, 4); k++) {
    await cands.nth(k).click({ timeout:8000 }).catch(()=>{});
    for (let i = 0; i < 6; i++) {
      await sleep(2500);
      const after = await allText(page);
      if (after) text = (text + ' ' + after).replace(/\s+/g,' ').trim();
      if (SOLD_OUT.test(text) || WIDGET.test(text)) break;
    }
    if (SOLD_OUT.test(text) || WIDGET.test(text)) { console.log(`  answered after control #${k+1}`); break; }
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(800);
  }

  if (apiTexts.length) {
    console.log(`  captured ${apiTexts.length} data response(s): ${apiUrls.slice(0,4).join(' | ').slice(0,240)}`);
    text = (text + ' ' + apiTexts.join(' ')).replace(/\s+/g,' ').trim();
  }
  return { text, staticText };
}

async function deepCapture(ctx, t) {
  const res = { rows: [], deepest: t.url, shot: null, note: '' };
  const page = await ctx.newPage();
  try {
    await loadReady(page, t.url);
    for (const rx of [/check availability/i, /book now/i, /start booking/i]) {
      const btn = page.getByRole('button', { name: rx }).first();
      if (await btn.count().catch(()=>0)) { await btn.click({ timeout:6000 }).catch(()=>{}); await sleep(3000); }
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

async function onePass(ctx, prev, pass, passes) {
  console.log(`--- pass ${pass}/${passes}: checking pages ---`);
  const next = {};
  const changed = [];
  let failures = 0;

  for (const t of TARGETS) {
    const page = await ctx.newPage();
    try {
      const { text, staticText } = await withTimeout(readTarget(page, t), 180000, `load ${t.id}`);
      const sig = signal(text, staticText);
      next[t.id] = { ...sig, ok:true, checked:new Date().toISOString() };
      const old = prev[t.id];
      if (sig.open && (!old?.ok || !old.open))                       changed.push({ t, kind:'OPEN' });
      else if (old?.ok && sig.offer && old.offer && old.offer !== sig.offer)          changed.push({ t, kind:'OFFER' });
      else if (old?.ok && old.announce !== undefined && old.announce !== sig.announce) changed.push({ t, kind:'EDIT' });
      console.log(`${sig.open ? 'OPEN!!!  ' : sig.soldOut ? 'soldout  ' : 'unclear  '} ${t.id}`);
      if (!sig.open && !sig.soldOut) {
        const named = new RegExp(t.id.split('-')[0], 'i').test(text);
        const i = text.search(/availab|fully|booked|kamer|room type|comfy|deluxe/i);
        console.log(`  ...offer fingerprint=${sig.offer || 'n/a'} (${sig.offerLen} chars), name found=${named}`);
      }
    } catch (e) {
      failures++;
      next[t.id] = { ...(prev[t.id]||{}), ok:false, error:String(e.message).slice(0,200), checked:new Date().toISOString() };
      console.error(`FAILED ${t.id}: ${e.message.slice(0,140)}`);
    } finally { await page.close().catch(()=>{}); }
  }

  console.log(`--- ${changed.length} change(s) to report ---`);
  for (const c of changed) {
    const urgent = c.kind === 'OPEN' || c.kind === 'OFFER';
    let deep = null;
    if (urgent) {
      console.log(`  deep look at ${c.t.id}...`);
      deep = await withTimeout(deepCapture(ctx, c.t), 120000, `deep ${c.t.id}`)
        .catch(e => ({ rows:[], deepest:c.t.url, shot:null, note:`Deep look timed out (${e.message.slice(0,60)}).` }));
    }
    const head = c.kind === 'OPEN'  ? `ROOMS OPEN — ${c.t.label}`
               : c.kind === 'OFFER' ? `ROOM LISTING CHANGED — ${c.t.label}`
               :                      `Page changed — ${c.t.label}`;
    const lines = [
      c.kind === 'OPEN'  ? 'Units are listed. Xior is first-come-first-served — move now.'
    : c.kind === 'OFFER' ? 'The room section changed, which is how a new release shows up. Open it and click Check availability.'
    :                      'Wording about upcoming releases changed.',
      '', `Property page: ${c.t.url}`,
    ];
    if (deep) {
      if (deep.deepest && deep.deepest !== c.t.url) lines.push(`Deepest step reached: ${deep.deepest}`);
      if (deep.rows.length) lines.push('', 'Seen on the page:', ...deep.rows.map(r => `• ${r}`));
      if (deep.note) lines.push('', deep.note);
      lines.push('', 'Then: €75 fee immediately → 5 days for contract + first month + 2-month deposit (~€3,300).');
    }
    await sendText(head, lines.join('\n'));
    if (deep?.shot) await sendPhoto(deep.shot, `${head}\n${deep.deepest}`);
  }
  return { next, failures };
}

// Xior reportedly batch-releases around the 1st of the month. GitHub cannot
// schedule tighter than every 5 minutes, so on that day we stay in one run
// and re-check every minute instead.
const isReleaseDay = new Date().getUTCDate() === 1;
const PASSES = isReleaseDay ? 5 : 1;
if (isReleaseDay) console.log('release day (1st): repeating the check every 60s within this run');

let state = readState();
let lastFailures = 0;
let browser;

try {
  browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width:1440, height:900 },
    locale: 'en-GB',
    extraHTTPHeaders: { 'Accept-Language':'en-GB,en;q=0.9,nl;q=0.8', 'Upgrade-Insecure-Requests':'1' },
  });

  for (let p = 1; p <= PASSES; p++) {
    if (p > 1) { console.log('--- waiting 60s ---'); await sleep(60000); }
    const { next, failures } = await onePass(ctx, state, p, PASSES);
    state = next;
    lastFailures = failures;
    saveState(state);
  }
} catch (e) {
  console.error('RUN ERROR:', e.message);
} finally {
  if (browser) await browser.close().catch(()=>{});
}

saveState(state);
if (lastFailures === TARGETS.length) {
  await sendText('Xior watcher is blind', 'Every page failed to load. Silence from now on would NOT mean "no rooms" — check the GitHub Actions log.');
}
console.log(`done — ${lastFailures} failure(s) on final pass`);
process.exit(0);
