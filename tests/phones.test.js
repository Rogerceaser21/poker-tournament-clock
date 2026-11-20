/* Poker Tournament Clock — phones test: a fake iPad (host) + 3 fake phones, live over WebRTC.
 *
 *   1. serve the folder:   python3 -m http.server 8791      (from the repo root)
 *   2. run:                NODE_PATH=<a node_modules with playwright> node tests/phones.test.js
 *
 * Needs internet (the free PeerJS server introduces the devices). Prints a results table; exits 1 on any failure.
 */
const { webkit, chromium } = require('playwright');
const BASE = process.env.CLOCK_BASE || 'http://localhost:8791/';
const HOST_BROWSER = process.env.HOST_BROWSER === 'chromium' ? chromium : webkit;
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ROOM = 't' + Math.random().toString(36).slice(2, 8);
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250){ const end = Date.now() + ms; let last; while (Date.now() < end){ try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await wait(step); } return false; }

const rows = []; let failed = 0;
async function check(name, fn){
  let ok = false, detail = '';
  try { const r = await fn(); ok = r === true; if (!ok) detail = typeof r === 'string' ? r : JSON.stringify(r); } catch (e) { detail = e.message.split('\n')[0]; }
  if (!ok) failed++; rows.push((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '\n        ' + detail : '')); console.log(rows[rows.length - 1]);
}

(async () => {
  /* ---- the iPad ---- */
  const hb = await HOST_BROWSER.launch(HOST_BROWSER === chromium ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } : {});
  const hctx = await hb.newContext({ viewport: { width: 1180, height: 820 }, userAgent: HOST_BROWSER === webkit ? IPAD_UA : undefined });
  const host = await hctx.newPage(); const hostErr = []; host.on('pageerror', e => hostErr.push(e.message));
  await host.addInitScript((room) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.clear();
    localStorage.setItem('poker_clock_state_v1', JSON.stringify({ v: 1, levels: [[1, 2], [2, 4], [5, 10]].map(([sb, bb], i) => ({ id: 'L' + (i + 1), sb, bb, mins: 20 })),
      names: ['Ann', 'Bob', 'Cat', 'Dan'], buyins: [500, 500, 500, 500], photos: [null, null, null, null], chips: [700, 700, 700, 700], startStack: 700 }));
    localStorage.setItem('poker_phones_v1', JSON.stringify({ room, enabled: true, allowChips: true })); }, ROOM);
  await host.addInitScript(() => { window.__sfx = []; const o = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ if (!this.muted && this.src && this.src.includes('/sounds/')) window.__sfx.push(this.src); return o.apply(this, arguments); }; });
  await host.goto(BASE + 'Poker%20Tournament%20Clock.html');

  await check('iPad goes live as host (room ' + ROOM + ')', async () =>
    !!(await until(() => host.evaluate(() => phones.peer && phones.peer.open), 20000)) || await host.evaluate(() => phones.status));
  await host.click('#phonesBtn'); await wait(800);
  await check('Phones panel shows the QR code + room code', async () => {
    const r = await host.evaluate(() => ({ qr: !!document.querySelector('#phQr svg'), room: phRoom.textContent, url: phUrl.textContent }));
    return (r.qr && r.room === ROOM.toUpperCase() && r.url.endsWith('join.html?room=' + ROOM)) || r; });
  await host.keyboard.press('Escape');

  /* ---- 3 phones ---- */
  /* headless browsers on one Mac can't resolve each other's hidden (mDNS) local addresses — real devices on
     the same Wi-Fi do this through Bonjour. Showing the phones' real local IPs lets the test connect the same way. */
  const pb = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }); const phones = []; const phoneErr = [];
  for (const [i, name] of ['Ann', 'Bob', 'Cat'].entries()){
    const ctx = await pb.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await ctx.newPage(); p.on('pageerror', e => phoneErr.push(name + ': ' + e.message));
    await p.goto(BASE + 'join.html?room=' + ROOM);
    phones.push({ name, ctx, p });
  }
  await check('3 phones connect and see the name picker', async () => {
    const r = await Promise.all(phones.map(ph => until(() => ph.p.evaluate(() => live && !document.getElementById('picker').classList.contains('hide')), 20000)));
    return r.every(Boolean) || r; });
  for (const ph of phones) await ph.p.click(`[data-pick="${ph.name}"]`);
  await check('iPad lists all 3 players as connected', async () =>
    !!(await until(() => host.evaluate(() => phones.players().length === 3), 8000)) || await host.evaluate(() => phones.players()));

  /* ---- live clock on the phones ---- */
  const phoneView = p => p.evaluate(() => ({ lv: document.getElementById('lv').textContent, time: document.getElementById('time').textContent, blinds: document.getElementById('blinds').textContent, paused: document.getElementById('time').classList.contains('paused') }));
  const secs = t => { const m = /^(\d+):(\d\d)$/.exec(t); return m ? +m[1] * 60 + +m[2] : (/^\d+$/.test(t) ? +t : NaN); };
  await host.click('#startBtn'); await wait(300);
  await check('Start on iPad → every phone shows Level 1, blinds 1 / 2, same time (±2 s)', async () => {
    const ok = await until(async () => { const hs = await host.evaluate(() => Math.round((clock.deadline - performance.now()) / 1000));
      const v = await Promise.all(phones.map(ph => phoneView(ph.p)));
      return v.every(x => x.lv.startsWith('Level 1') && x.blinds.includes('1 / 2') && Math.abs(secs(x.time) - hs) <= 2) && v; }, 6000);
    return !!ok || await Promise.all(phones.map(ph => phoneView(ph.p))); });
  await wait(700);                                   /* a slide change takes 0.45 s; taps during it are ignored */
  await host.click('#nextBtn');
  await check('⏭ on iPad → phones show "Next up · Level 2" within 2 s', async () =>
    !!(await until(async () => (await Promise.all(phones.map(ph => phoneView(ph.p)))).every(x => x.lv.startsWith('Next up · Level 2')), 2500)) || await phoneView(phones[0].p));
  await check('…then Level 2, blinds 2 / 4', async () =>
    !!(await until(async () => (await Promise.all(phones.map(ph => phoneView(ph.p)))).every(x => x.lv.startsWith('Level 2') && x.blinds.includes('2 / 4')), 9000)) || await phoneView(phones[0].p));
  await host.keyboard.press('Space');
  await check('Pause on iPad → phones show paused + frozen time', async () => {
    const a = await until(() => phoneView(phones[1].p).then(v => v.paused && v), 2500); await wait(2000); const b = await phoneView(phones[1].p);
    return (a && b.paused && a.time === b.time) || { a, b }; });
  await host.keyboard.press('Space');

  /* ---- emojis ---- */
  await phones[1].p.click('[data-e="🔥"]');
  await check('Bob taps 🔥 → floats up on the iPad with "Bob"', async () =>
    !!(await until(() => host.evaluate(() => [...document.querySelectorAll('#emojiLayer .emoji-fly')].some(f => f.textContent.includes('🔥') && f.textContent.includes('Bob'))), 3000)));
  await check('…and Ann\'s phone sees it too', async () =>
    !!(await until(() => phones[0].p.evaluate(() => [...document.querySelectorAll('.fly')].some(f => f.textContent.includes('🔥'))), 3000)));
  await check('…and the iPad plays its sound (🔥 → wow)', async () =>
    !!(await until(() => host.evaluate(() => (window.__sfx || []).some(x => x.endsWith('sounds/wow.m4a'))), 3000)) || await host.evaluate(() => window.__sfx));
  await check('All 8 emoji sounds load on the iPad (real audio, right length)', async () => {
    const r = await host.evaluate(() => Promise.all(Object.entries(EMOJI_SOUNDS).map(([e, n]) => new Promise(ok => {
      const a = new Audio('sounds/' + n + '.m4a'); a.preload = 'auto';
      a.addEventListener('loadedmetadata', () => ok([e, n, +a.duration.toFixed(2)])); a.addEventListener('error', () => ok([e, n, 'ERROR'])); setTimeout(() => ok([e, n, 'TIMEOUT']), 8000); }))));
    return r.every(x => typeof x[2] === 'number' && x[2] > 0.3 && x[2] < 5) || r; });
  await host.evaluate(() => { emojiSfx.on = false; window.__sfx = []; }); await wait(1300);
  await phones[1].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '🤯' }); }); await wait(900);
  await check('Emoji sounds switched off → no sound', async () => (await host.evaluate(() => window.__sfx.length)) === 0 || await host.evaluate(() => window.__sfx));
  await host.evaluate(() => { emojiSfx.on = true; }); await wait(1300);
  await phones[1].p.click('[data-e="😂"]'); await phones[1].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '💀' }); });
  await check('Emoji spam is limited (max 1 per 1.2 s per player)', async () => {
    await wait(600); const n = await host.evaluate(() => [...document.querySelectorAll('#emojiLayer .emoji-fly')].filter(f => f.textContent.includes('Bob')).length);
    return n <= 3 || 'Bob emojis on screen: ' + n; });

  /* ---- own chips ---- */
  await phones[2].p.click('[data-step="500"]');
  await check('Cat taps +500 → iPad shows 1,200 for Cat + "Undo" toast', async () => {
    const r = await until(() => host.evaluate(() => bank.chips[2] === 1200 && [...document.querySelectorAll('#toastLayer .toast')].some(t => t.textContent.includes('Cat')) && true), 4000);
    return !!r || await host.evaluate(() => ({ chips: bank.chips[2], toasts: [...document.querySelectorAll('#toastLayer .toast')].map(t => t.textContent) })); });
  await check('…every phone shows Cat on 1,200', async () =>
    !!(await until(async () => (await Promise.all(phones.map(ph => ph.p.evaluate(() => state.players[2].chips)))).every(c => c === 1200), 4000)));
  await host.click('#toastLayer .toast button');
  await check('Undo on iPad → Cat back to 700 everywhere', async () =>
    !!(await until(async () => (await host.evaluate(() => bank.chips[2])) === 700 && (await Promise.all(phones.map(ph => ph.p.evaluate(() => state.players[2].chips)))).every(c => c === 700), 4000)));
  await host.evaluate(() => { phones.allowChips = false; phones.push(true); });
  await check('Chip changes switched off → phone buttons greyed out', async () =>
    !!(await until(() => phones[2].p.evaluate(() => document.querySelector('[data-step="500"]').disabled || document.getElementById('chipCtl').classList.contains('hide')), 3000)));
  await phones[2].p.evaluate(() => send({ t: 'chips', name: 'Cat', value: 99999 })); await wait(800);
  await check('…and a forced change from a phone is ignored', async () => (await host.evaluate(() => bank.chips[2])) === 700);
  await host.evaluate(() => { phones.allowChips = true; phones.push(true); });
  await phones[0].p.evaluate(() => send({ t: 'chips', name: 'Bob', value: 5 })); await wait(800);
  await check('A phone can\'t change someone else\'s chips', async () => (await host.evaluate(() => bank.chips[1])) === 700);

  /* ---- reconnecting ---- */
  const hostLevel = () => host.evaluate(() => { const s = presentation.slides[presentation.current]; return (s.querySelector('.lv') || s.querySelector('.trans-level') || {}).textContent; });
  const liveAgain = (p, ms = 20000) => until(() => p.evaluate(() => live && document.getElementById('pill').classList.contains('live')), ms);
  /* phone locked: the link dies silently (no close event) — the watchdog must notice */
  await phones[0].p.evaluate(() => { const c = conn; conn = null; try { c.peerConnection.close(); } catch (e) {} conn = c; c.removeAllListeners && c.removeAllListeners(); lastMsg = Date.now() - 13000; });
  await check('Phone locked (link dies silently) → reconnects by itself, same name, current level', async () => {
    const ok = await liveAgain(phones[0].p);
    const v = await phoneView(phones[0].p), picker = await phones[0].p.evaluate(() => !document.getElementById('picker').classList.contains('hide')), hl = await hostLevel();
    return (ok && !picker && v.lv.startsWith(hl.split(' of')[0].trim())) || { ok, picker, v, hl }; });
  /* phone unlocked after a while: visibility comes back */
  await phones[1].p.evaluate(() => { lastMsg = Date.now() - 7000; document.dispatchEvent(new Event('visibilitychange')); });
  await check('Phone unlocked → checks at once and is live again', async () => !!(await liveAgain(phones[1].p, 8000)));
  /* no Wi-Fi for a bit */
  await phones[2].ctx.setOffline(true); await phones[2].p.evaluate(() => { const c = conn; c.removeAllListeners && c.removeAllListeners(); try { c.peerConnection.close(); } catch (e) {} lastMsg = Date.now() - 13000; });
  await check('Phone loses Wi-Fi → shows "Reconnecting…"', async () =>
    !!(await until(() => phones[2].p.evaluate(() => !document.getElementById('pill').classList.contains('live')), 8000)));
  await phones[2].ctx.setOffline(false); await phones[2].p.evaluate(() => window.dispatchEvent(new Event('online')));
  await check('…Wi-Fi back → live again by itself', async () => !!(await liveAgain(phones[2].p, 25000)));
  /* refresh / closed tab */
  await phones[1].p.reload();
  await check('Phone page refreshed → live again, no name picker', async () => {
    const ok = await liveAgain(phones[1].p); const picker = await phones[1].p.evaluate(() => !document.getElementById('picker').classList.contains('hide'));
    return (ok && !picker) || { ok, picker }; });
  await phones[0].p.close(); phones[0].p = await phones[0].ctx.newPage(); await phones[0].p.goto(BASE + 'join.html?room=' + ROOM);
  await check('Tab closed and link opened again → remembers the name', async () => {
    const ok = await liveAgain(phones[0].p); const r = await phones[0].p.evaluate(() => ({ picker: !document.getElementById('picker').classList.contains('hide'), me: document.getElementById('meName').textContent }));
    return (ok && !r.picker && r.me === 'Ann') || { ok, ...r }; });
  /* the iPad reloads */
  await host.reload();
  await check('iPad reloads → phones notice the clock is gone', async () =>
    !!(await until(async () => (await Promise.all(phones.map(ph => ph.p.evaluate(() => !document.getElementById('pill').classList.contains('live'))))).some(Boolean), 15000)));
  await check('…iPad back → every phone reconnects by itself (same room)', async () => {
    const r = await Promise.all(phones.map(ph => liveAgain(ph.p, 40000)));
    return r.every(Boolean) || r; });
  await check('…and the iPad lists all 3 again', async () =>
    !!(await until(() => host.evaluate(() => phones.players().length === 3), 10000)) || await host.evaluate(() => phones.players()));

  await check('No page errors (iPad + phones)', async () => (!hostErr.length && !phoneErr.length) || { hostErr, phoneErr });

  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  await hb.close(); await pb.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
