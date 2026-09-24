// ============================================================
//  Xior Groningen availability watcher  —  VERSION v12
// ============================================================
//
//  What changed in v12, and why:
//    Xior's booking pop-up is a thin wrapper around one WordPress endpoint,
//    admin-ajax.php?action=yardi_room_availability. It answers with a JSON
//    object that includes `availability_by_room` — a count of bookable units
//    per room type — and the server does NOT enforce the Cloudflare Turnstile
//    token the pop-up sends. So instead of fingerprinting page text (which
//    fired every time Xior touched the layout), v12 asks that endpoint
//    directly and alerts only when a count goes from 0 to more than 0.
//
//    Gone: fingerprints, wording-change alerts, screenshots, and the
//    "deepest step reached" crawl. One page load per run to pick up
//    Cloudflare cookies, then one small request per building.
//
//  Answering "is a room available?" is now a number, not an interpretation.

import { chromium } from 'playwright';
import fs from 'node:fs';

const VERSION = 'v12';
console.log(`=== xior check.mjs ${VERSION} ===`);

// One page load on this origin warms the Cloudflare cookies for everything
// below. It is not a target; nothing is read from it.
const WARMUP_URL = 'https://www.xiorstudenthousing.eu/netherlands/groningen/';

// Xior Groningen buildings. Parameters read from each building's page on
// 24 Sep 2026. `semester` is the Yardi academic-term id the widget submits;
// note Short Stay uses a different one. `priority` room types get their own
// alert even when another type was already open.
const XIOR = [
  { id:'eendrachtskade', label:'Eendrachtskade — TOP TARGET', pageId:1121, semester:3281,
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/eendrachtskade-student-accommodation/',
    rooms:{ 29888:'Comfy (from €615)', 32266:'Deluxe (from €800)' }, priority:[29888] },
  { id:'zernike-tower', label:'Zernike Tower', pageId:1119, semester:3281,
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-student-accommodation/',
    rooms:{ 29907:'Comfy (from €690)', 32267:'Deluxe' }, priority:[29907] },
  { id:'oosterhamrikkade', label:'Oosterhamrikkade', pageId:1120, semester:3281,
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/oosterhamrikkade-student-accommodation/',
    rooms:{ 29894:'Comfy (from €866)' }, priority:[29894] },
  { id:'zernike-short', label:'Zernike Tower Short Stay (6-month)', pageId:1118, semester:18429,
    url:'https://www.xiorstudenthousing.eu/netherlands/groningen/zernike-tower-short-stay/',
    rooms:{ 32268:'Comfy', 32269:'Deluxe' }, priority:[] },
];

// The Social Hub is a different site with no such endpoint. It is judged on
// its own wording, and only a flip from "sold out" to "not sold out" alerts.
const SOCIAL_HUB = {
  id:'social-hub', label:'The Social Hub Groningen',
  url:'https://www.thesocialhub.co/book-student-room/?hotelId=GRO01',
};
const SH_SOLD_OUT = /(fully booked|sold out|no rooms available|bookings open soon|open soon|currently unavailable|notified when)/i;

const STATE_FILE = 'state.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const NTFY     = process.env.NTFY_TOPIC;
console.log(`telegram configured: ${TG_TOKEN ? 'token yes' : 'TOKEN MISSING'} / ${TG_CHAT ? 'chat id yes' : 'CHAT ID MISSING'}`);

// How many consecutive runs a building may be unreadable before you are told.
// At one run every ~30 minutes this is roughly three hours.
const BLIND_AFTER = 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms, what) {
  let t;
  const killer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms/1000}s`)), ms); });
  return Promise.race([promise, killer]).finally(() => clearTimeout(t));
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

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
        body: JSON.stringify({ chat_id: TG_CHAT, text: `${title}\n\n${body}`.slice(0,4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000),
      });
      console.log('  telegram status', r.status, r.ok ? '(sent)' : `(FAILED: ${(await r.text()).slice(0,200)})`);
    } catch (e) { console.error('  telegram failed:', e.message); }
  }
}

// Load a page and wait until it is real content, not a Cloudflare holding
// page ("403 Forbidden" is 13 chars; "Performing security check" ~1.3k).
async function loadReady(page, url, looksReal, attempts = 4, polls = 6) {
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    try { await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 }); }
    catch (e) { console.log(`  goto issue: ${e.message.slice(0,60)}`); }
    for (let n = 0; n < polls; n++) {
      await sleep(2500);
      last = await page.evaluate(() => document.body ? document.body.innerText : '').catch(()=> '');
      if (last.length > 800 && looksReal.test(last)) return last.replace(/\s+/g,' ').trim();
    }
    console.log(`  attempt ${i}: only ${last.length} chars ("${last.slice(0,30).replace(/\s+/g,' ')}")`);
    if (i < attempts) await sleep(5000 * i);
  }
  throw new Error(`no real content (last ${last.length} chars: "${last.slice(0,40).replace(/\s+/g,' ')}")`);
}
async function dismissBanners(page) {
  for (const rx of [/reject all/i, /^accept/i, /accept all/i, /akkoord/i, /^agree/i, /allow all/i]) {
    const b = page.getByRole('button', { name: rx }).first();
    if (await b.count().catch(()=>0)) { await b.click({ timeout:3000 }).catch(()=>{}); await sleep(500); break; }
  }
}

// ---------- the actual availability question ----------------------------
//
// Runs inside the page so the request carries the site's own cookies. Returns
// the parsed JSON, or throws if the answer is not JSON (a Cloudflare page).
async function askXior(page, prop, roomTypeId) {
  return page.evaluate(async ({ pageId, semester, roomTypeId }) => {
    const body = new URLSearchParams({
      action: 'yardi_room_availability', 'cf-turnstile-response': '',
      property_page_id: String(pageId), room_type_id: String(roomTypeId), semester_id: String(semester),
    });
    const r = await fetch('/wp-admin/admin-ajax.php', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body,
    });
    const text = await r.text();
    try { return { status: r.status, json: JSON.parse(text) }; }
    catch { return { status: r.status, json: null, head: text.slice(0, 120) }; }
  }, { pageId: prop.pageId, semester: prop.semester, roomTypeId });
}

// Reduce one building to: known? which room types have units? unit details.
async function checkXior(page, prop) {
  const roomIds = Object.keys(prop.rooms);
  const first = await askXior(page, prop, roomIds[0]);
  const d = first.json && first.json.data;
  if (!first.json || first.json.success !== true || !d || typeof d.availability_by_room !== 'object') {
    const why = first.json ? `success=${first.json.success}` : `non-JSON (${first.status}: "${first.head || ''}")`;
    throw new Error(`endpoint gave no usable answer — ${why}`);
  }
  // Yardi replies 204 when there is simply nothing to list; anything else
  // unexpected means "don't trust the zeros".
  const code = d.availability_response && d.availability_response.errorCode;
  if (code !== undefined && code !== null && code !== 200 && code !== 204) {
    throw new Error(`Yardi errorCode ${code} (${d.availability_response.errorMessage || ''})`);
  }

  const byRoom = {};
  for (const id of roomIds) byRoom[id] = Number(d.availability_by_room[id] ?? 0) || 0;
  const openTypes = roomIds.filter(id => byRoom[id] > 0);

  // Unit details come back only for the room type we asked about, so ask
  // again for each open type we did not already ask for.
  const units = [];
  const collect = (arr, id) => { for (const u of (arr || [])) units.push({
    type: prop.rooms[id], name: u.apartmentName || u.floorplanName || '?', sqm: u.sqM || u.sqm || '',
    date: u.availableDate || 'now', rent: u.minimumRent || '', apply: u.applyOnlineURL || '',
  }); };
  if (openTypes.includes(roomIds[0])) collect(d.units, roomIds[0]);
  for (const id of openTypes) {
    if (id === roomIds[0]) continue;
    const more = await askXior(page, prop, id).catch(() => null);
    collect(more && more.json && more.json.data && more.json.data.units, id);
  }
  return { byRoom, openTypes, units };
}

function describeUnits(units) {
  return units.slice(0, 12).map(u => {
    const bits = [`${u.type}: ${u.name}`];
    if (u.sqm)  bits.push(`${u.sqm} m²`);
    if (u.date) bits.push(`from ${u.date}`);
    if (u.rent) bits.push(`€${u.rent}`);
    const line = `• ${bits.join(' · ')}`;
    return u.apply ? `${line}\n  ${u.apply}` : line;
  }).join('\n');
}

// ---------- one pass over everything ---------------------------------------
async function onePass(ctx, prev) {
  const next = {};
  const page = await ctx.newPage();
  let warmed = false;
  try {
    console.log('warming cookies on the Groningen overview...');
    await withTimeout(loadReady(page, WARMUP_URL, /xior|groningen|student/i), 150000, 'warm-up');
    await dismissBanners(page);
    warmed = true;
  } catch (e) {
    console.error(`warm-up failed: ${e.message.slice(0,140)}`);
  }

  for (const prop of XIOR) {
    const old = prev[prop.id] || {};
    try {
      if (!warmed) throw new Error('warm-up failed, skipping');
      const res = await withTimeout(checkXior(page, prop), 60000, `query ${prop.id}`);
      const available = res.openTypes.length > 0;
      next[prop.id] = {
        ok: true, available, byRoom: res.byRoom, openTypes: res.openTypes,
        units: res.units, unknownStreak: 0, checked: new Date().toISOString(),
      };
      const counts = Object.entries(res.byRoom).map(([id, n]) => `${prop.rooms[id].split(' ')[0]}=${n}`).join(' ');
      console.log(`${available ? 'AVAILABLE ' : 'none      '} ${prop.id}  [${counts}]`);

      const wasAvailable = old.ok && old.available;
      const oldOpen = new Set(old.openTypes || []);
      const newPriority = prop.priority.filter(id => res.openTypes.includes(String(id)) && !oldOpen.has(String(id)));

      if (available && !wasAvailable) {
        await sendText(`ROOMS AVAILABLE — ${prop.label}`,
          [`Xior is first-come-first-served — move now.`, '', describeUnits(res.units) || '(unit list not returned — open the page and click Check availability)', '', `Property page: ${prop.url}`].join('\n'));
      } else if (available && newPriority.length) {
        await sendText(`Comfy now available — ${prop.label}`,
          [describeUnits(res.units.filter(u => newPriority.some(id => u.type === prop.rooms[id]))), '', `Property page: ${prop.url}`].join('\n'));
      } else if (!available && wasAvailable) {
        await sendText(`Full again — ${prop.label}`, 'All room types show zero units. Watching continues.');
      }
    } catch (e) {
      const streak = (old.unknownStreak || 0) + 1;
      next[prop.id] = { ...old, ok: false, unknownStreak: streak, error: String(e.message).slice(0,200), checked: new Date().toISOString() };
      console.error(`UNKNOWN   ${prop.id}: ${e.message.slice(0,140)} (streak ${streak})`);
      if (streak === BLIND_AFTER) {
        await sendText(`Can't read ${prop.label}`, `The availability endpoint has not given a usable answer for ${streak} runs in a row. Silence about this building is NOT "no rooms" until this clears.\n\nLast error: ${e.message.slice(0,160)}`);
      }
    }
  }

  // The Social Hub, judged on wording alone.
  {
    const old = prev[SOCIAL_HUB.id] || {};
    try {
      const text = await withTimeout(loadReady(page, SOCIAL_HUB.url, /social hub|student|room|book/i), 150000, 'social hub');
      const soldOut = SH_SOLD_OUT.test(text);
      next[SOCIAL_HUB.id] = { ok: true, soldOut, unknownStreak: 0, checked: new Date().toISOString() };
      console.log(`${soldOut ? 'soldout   ' : 'NOT SOLD OUT'} social-hub`);
      if (!soldOut && old.ok && old.soldOut) {
        await sendText(`Wording changed — ${SOCIAL_HUB.label}`, `The page no longer says it is sold out. Go and look.\n\n${SOCIAL_HUB.url}`);
      }
    } catch (e) {
      const streak = (old.unknownStreak || 0) + 1;
      next[SOCIAL_HUB.id] = { ...old, ok: false, unknownStreak: streak, error: String(e.message).slice(0,200), checked: new Date().toISOString() };
      console.error(`UNKNOWN   social-hub: ${e.message.slice(0,140)}`);
    }
  }

  await page.close().catch(()=>{});
  const failures = Object.values(next).filter(v => !v.ok).length;
  return { next, failures };
}

// ---------- release-day cadence -------------------------------------------
// Xior reportedly batch-releases around the 1st of the month. GitHub cannot
// schedule tighter than every 5 minutes, so on the DUTCH 1st we stay in one
// run and re-check every minute instead.
const nlToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
const isReleaseDay = nlToday.endsWith('-01');
const PASSES = isReleaseDay ? 5 : 1;
console.log(`date in Groningen: ${nlToday}${isReleaseDay ? '  <-- RELEASE DAY' : ''}`);

let state = readState();
let lastFailures = 0;
let browser;
try {
  browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width:1440, height:900 }, locale: 'en-GB',
    extraHTTPHeaders: { 'Accept-Language':'en-GB,en;q=0.9,nl;q=0.8', 'Upgrade-Insecure-Requests':'1' },
  });
  for (let p = 1; p <= PASSES; p++) {
    if (p > 1) { console.log('--- waiting 60s ---'); await sleep(60000); }
    console.log(`--- pass ${p}/${PASSES} ---`);
    const { next, failures } = await onePass(ctx, state);
    state = next; lastFailures = failures;
    saveState(state);
  }
} catch (e) {
  console.error('RUN ERROR:', e.message);
} finally {
  if (browser) await browser.close().catch(()=>{});
}

saveState(state);
const total = XIOR.length + 1;
if (lastFailures === total) {
  await sendText('Xior watcher is blind', 'Nothing could be read this run. Silence from now on would NOT mean "no rooms" — check the GitHub Actions log.');
}
console.log(`done — ${lastFailures} of ${total} unreadable on final pass`);
process.exit(0);
