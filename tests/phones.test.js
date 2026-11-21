/* Poker Tournament Clock — phones test: a fake iPad (host) + 3 fake phones, live over WebRTC.
 *
 *   run (it serves the repo itself on :8791):                NODE_PATH=<a node_modules with playwright> node tests/phones.test.js
 *   the PREVIEW copy (preview/ clock + preview/join.html):     PREVIEW=1 NODE_PATH=… node tests/phones.test.js
 *
 * Needs internet (the free PeerJS server introduces the devices). Prints a results table; exits 1 on any failure.
 */
const { webkit, chromium } = require('playwright');
const BASE = process.env.CLOCK_BASE || (process.env.PREVIEW === '1' ? 'http://localhost:8791/preview/' : 'http://localhost:8791/');
const PV = process.env.PREVIEW === '1';
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
  const srv = /^http:\/\/localhost:8791\//.test(BASE) ? await require('./serve').start() : null;   /* self-serve the repo (also for preview/) */
  /* ---- the iPad ---- */
  const hb = await HOST_BROWSER.launch(HOST_BROWSER === chromium ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } : {});
  const hctx = await hb.newContext({ viewport: { width: 1180, height: 820 }, userAgent: HOST_BROWSER === webkit ? IPAD_UA : undefined });
  const host = await hctx.newPage(); const hostErr = []; host.on('pageerror', e => hostErr.push(e.message));
  const spCalls = []; let spPlaying = true, spTitle = 'Song', spArtist = 'A';
  await hctx.route('https://api.spotify.com/v1/**', r => { const path = r.request().url().split('/v1')[1], m = r.request().method();
    if (/\/me\/player\/(pause|play)/.test(path)){ spCalls.push({ c: m + ' ' + path.split('?')[0], at: Date.now() }); spPlaying = path.includes('/play'); return r.fulfill({ status: 204, body: '' }); }
    if (path === '/me') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"display_name":"Host"}' });
    if (path.startsWith('/me/player?')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ is_playing: spPlaying, progress_ms: 1000,
      device: { id: 'ipad', type: 'Tablet', volume_percent: 70, supports_volume: false }, item: { id: spTitle === 'Song' ? 't' : 't2', name: spTitle, duration_ms: 200000, artists: [{ name: spArtist }], album: { images: [{ url: 'x' }] } } }) });
    return r.fulfill({ status: 204, body: '' }); });
  await host.addInitScript(([room, pv]) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.clear();
    localStorage.setItem('poker_clock_state_v1', JSON.stringify({ v: 1, levels: [[1, 2], [2, 4], [5, 10]].concat(pv ? [[10, 20], [20, 40], [50, 100], [100, 200]] : []).map(([sb, bb], i) => ({ id: 'L' + (i + 1), sb, bb, mins: 20 })),
      names: ['Ann', 'Bob', 'Cat', 'Dan'], buyins: [500, 500, 500, 500], photos: [null, null, null, null], chips: [700, 700, 700, 700], startStack: 700 }));
    localStorage.setItem('poker_phones_v1', JSON.stringify({ room, enabled: true, allowChips: true }));
    localStorage.setItem('poker_spotify_auth_v1', JSON.stringify({ access: 'AT', refresh: 'RT', exp: Date.now() + 3e6 })); }, [ROOM, PV]);   /* PREVIEW: 7 levels, room for the Next-up walk */
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
  await wait(1400);   /* past the 1.2 s per-player limit */
  await phones[1].p.click('[data-e="🔥"]');
  await check('…same phone, same emoji again after 1.2 s → the iPad plays the sound a 2nd time (two plays recorded)', async () => {
    await until(() => host.evaluate(() => (window.__sfx || []).filter(x => x.endsWith('sounds/wow.m4a')).length >= 2), 3000);
    const n = await host.evaluate(() => (window.__sfx || []).filter(x => x.endsWith('sounds/wow.m4a')).length);
    return n === 2 || 'wow plays recorded: ' + n; });
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

  if (PV){
    /* ---- PREVIEW: ten emojis, 5 × 2 grid, new card order ---- */
    await wait(1300);
    await phones[0].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '💵', name: myName() }); });
    await phones[2].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '❓', name: myName() }); });
    await check('PREVIEW: 💵 (Ann) and ❓ (Cat) from phones → fly up on the iPad and play pay-that-man / what-happened', async () => {
      const ok = await until(() => host.evaluate(() => { const f = [...document.querySelectorAll('#emojiLayer .emoji-fly')].map(x => x.textContent), s = window.__sfx || [];
        return f.some(t => t.includes('💵') && t.includes('Ann')) && f.some(t => t.includes('❓') && t.includes('Cat')) && s.some(x => x.endsWith('sounds/pay-that-man.m4a')) && s.some(x => x.endsWith('sounds/what-happened.m4a')); }), 4000);
      return !!ok || await host.evaluate(() => ({ fly: [...document.querySelectorAll('#emojiLayer .emoji-fly')].map(x => x.textContent), sfx: window.__sfx })); });
    await check('PREVIEW: phone shows the twelve emojis in order 😂 🔥 🤡 💀 / 🤯 📖 👏 😭 / 💰 💵 ❓ 💣', async () => {
      const r = await phones[0].p.evaluate(() => [...document.querySelectorAll('#emojis button')].map(b => b.dataset.e).join(' '));
      return r === '😂 🔥 🤡 💀 🤯 📖 👏 😭 💰 💵 ❓ 💣' || r; });
    const grid = () => phones[0].p.evaluate(() => { const bs = [...document.querySelectorAll('#emojis button')];
      const rows = [...new Set(bs.map(b => Math.round(b.getBoundingClientRect().top)))];
      const cut = bs.filter(b => { const r = document.createRange(); r.selectNodeContents(b); const g = r.getBoundingClientRect(), q = b.getBoundingClientRect(); return g.left < q.left - 0.5 || g.right > q.right + 0.5 || g.top < q.top - 0.5 || g.bottom > q.bottom + 0.5; }).map(b => b.dataset.e);
      return { n: bs.length, rows: rows.length, perRow: rows.map(t => bs.filter(b => Math.round(b.getBoundingClientRect().top) === t).length), minW: Math.min(...bs.map(b => b.getBoundingClientRect().width)), minH: Math.min(...bs.map(b => b.getBoundingClientRect().height)),
        hscroll: document.documentElement.scrollWidth > innerWidth, cut, maxH: Math.max(...bs.map(b => b.getBoundingClientRect().height)), card: Math.round(document.getElementById('emojis').closest('.card').getBoundingClientRect().height),
      gap: parseFloat(getComputedStyle(document.getElementById('emojis')).rowGap) }; });
    const sizes = {};
    for (const w of [320, 375, 390, 430]){ await phones[0].p.setViewportSize({ width: w, height: 844 }); await wait(250); sizes[w] = await grid(); }
    await phones[0].p.setViewportSize({ width: 390, height: 844 });
    console.log('        grid sizes: ' + JSON.stringify(Object.fromEntries(Object.entries(sizes).map(([w, g]) => [w, Math.round(g.minW) + 'x' + Math.round(g.minH) + ' card ' + g.card]))));
    await check('PREVIEW: emoji grid is 4 × 3 (compact) at 320 / 375 / 390 / 430 px, buttons 44-46 px high and ≥ 44 wide, 6-px gaps, no sideways scroll, no glyph clipped', async () =>
      Object.values(sizes).every(g => g.n === 12 && g.rows === 3 && g.perRow.join() === '4,4,4' && g.minW >= 44 && g.minH >= 44 && g.maxH <= 46 && g.gap === 6 && !g.hscroll && !g.cut.length) || sizes);
    await check('PREVIEW: phone card order — blinds, Send to the table, Now playing, my chips, Chip count, then "Not you?" last (DOM and on screen)', async () => {
      const r = await phones[0].p.evaluate(() => { const kids = [...document.getElementById('game').children].filter(x => getComputedStyle(x).display !== 'none');
        const name = x => x.id === 'notMe' ? 'notMe' : x.classList.contains('clock') ? 'blinds' : x.id === 'npCard' ? 'now' : x.id === 'meCard' ? 'me' : x.querySelector('#emojis') ? 'emojis' : x.querySelector('#list') ? 'chips' : '?';
        const tops = kids.map(x => x.getBoundingClientRect().top); return { order: kids.map(name).join(','), down: tops.every((t, i) => i === 0 || t > tops[i - 1]) }; });
      return (r.order === 'blinds,emojis,now,me,chips,notMe' && r.down) || r; });
  }

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

  /* ---- the bug Igor hit on real iPhones: the phone's first "hello" lost → the iPad never learned its name ---- */
  await host.evaluate(() => phones.conns.forEach(x => { x.name = null; })); await wait(1300);
  await phones[2].p.click('[data-e="👏"]');
  await check('iPad lost a phone\'s name → its emoji still arrives (name rides along)', async () =>
    !!(await until(() => host.evaluate(() => [...document.querySelectorAll('#emojiLayer .emoji-fly')].some(f => f.textContent.includes('👏') && f.textContent.includes('Cat'))), 3000)));
  await check('…and the phone shows "✓ sent to the table"', async () =>
    !!(await until(() => phones[2].p.evaluate(() => { const r = document.getElementById('receipt'); return r.classList.contains('show') && r.textContent.includes('✓'); }), 3000)) || await phones[2].p.evaluate(() => document.getElementById('receipt').textContent));
  await check('…and the iPad lists all 3 names again by itself', async () =>
    !!(await until(() => host.evaluate(() => phones.players().length === 3), 6000)) || await host.evaluate(() => phones.players()));
  await wait(1300); await phones[2].p.click('[data-e="👏"]'); await phones[2].p.click('[data-e="👏"]');
  await check('Tapping too fast → phone says so (not silently dropped)', async () =>
    !!(await until(() => phones[2].p.evaluate(() => document.getElementById('receipt').textContent.includes('one per second')), 2000)));

  /* ---- emoji sound pauses the music, then it comes back ---- */
  await wait(7000); spCalls.length = 0; spPlaying = true; await host.evaluate(() => spotify.poll()); await wait(600);
  await phones[1].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '💀' }); });
  await check('💀 from a phone → music pauses, FAAAH plays, music comes back after it (~2 s)', async () => {
    await until(() => spCalls.length >= 2, 6000);
    const r = { calls: spCalls.map(x => x.c), gapMs: spCalls[1] ? spCalls[1].at - spCalls[0].at : null };
    return (r.calls[0] === 'PUT /me/player/pause' && r.calls[1] === 'PUT /me/player/play' && r.gapMs >= 1700 && r.gapMs <= 3200) || r; });
  await wait(1500); spCalls.length = 0; spPlaying = true; await host.evaluate(() => spotify.poll()); await wait(600);
  await phones[0].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '🤯' }); });
  await phones[2].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '🤡' }); });
  await check('Two emojis at once → ONE pause, ONE play (music back after both)', async () => {
    await wait(4500); const r = spCalls.map(x => x.c);
    return (r.length === 2 && r[0].includes('pause') && r[1].includes('play')) || r; });

  if (PV){
    /* ---- PREVIEW: Now playing on the phones ---- */
    const npView = p => p.evaluate(() => ({ shown: !document.getElementById('npCard').classList.contains('hide'), title: document.getElementById('npTitle').textContent, artist: document.getElementById('npArtist').textContent, paused: !document.getElementById('npPaused').classList.contains('hide') }));
    await wait(3000); spPlaying = true; await host.evaluate(() => spotify.poll());
    await check('PREVIEW: Now playing card on every phone — song title + artist from Spotify, not paused', async () =>
      !!(await until(async () => (await Promise.all(phones.map(ph => npView(ph.p)))).every(v => v.shown && v.title === 'Song' && v.artist === 'A' && !v.paused), 4000)) || await npView(phones[0].p));
    spTitle = 'A Much Longer Song Title That Will Not Fit On One Phone Line At All'; spArtist = 'Some Artist With A Very Long Name, Featuring Another Artist And A Whole Orchestra'; await host.evaluate(() => spotify.poll());
    await check('PREVIEW: …new song on Spotify → phones show it within 2 s, one line each (ellipsis)', async () => {
      const ok = await until(async () => { const v = await npView(phones[1].p); return v.title === spTitle && v.artist === spArtist; }, 2500);
      const one = await phones[1].p.evaluate(() => ['npTitle', 'npArtist'].map(i => { const e = document.getElementById(i), lh = parseFloat(getComputedStyle(e).lineHeight) || e.getBoundingClientRect().height; return e.getBoundingClientRect().height < 2 * (lh || 20) && getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth; }));
      return (!!ok && one.every(Boolean)) || { ok, one, v: await npView(phones[1].p) }; });
    spPlaying = false; await host.evaluate(() => spotify.poll());
    await check('PREVIEW: …music paused in Spotify → card stays, says Paused', async () =>
      !!(await until(async () => { const v = await npView(phones[2].p); return v.shown && v.paused; }, 2500)) || await npView(phones[2].p));
    spPlaying = true; await host.evaluate(() => spotify.poll()); await wait(1500); spCalls.length = 0;
    await phones[1].p.evaluate(() => { lastEmojiSent = 0; send({ t: 'emoji', e: '💀', name: myName() }); });
    await check('PREVIEW: …the clock\'s own pause for an emoji sound does NOT show Paused on the phones', async () => {
      await until(() => spCalls.some(x => x.c.endsWith('pause')), 3000); await host.evaluate(() => spotify.poll()); const seen = [];
      const end = Date.now() + 1500; while (Date.now() < end){ seen.push((await npView(phones[0].p)).paused); await wait(100); }
      const mid = spCalls.length && spCalls[spCalls.length - 1].c.endsWith('pause');
      return (spCalls[0] && spCalls[0].c.endsWith('pause') && seen.length > 5 && seen.every(x => x === false)) || { calls: spCalls.map(x => x.c), seen, mid }; });
    await wait(2500);
  }

  if (PV){
    /* ---- PREVIEW: the phone mirrors the iPad's red 5-second "Next up" screen ---- */
    await host.evaluate(() => { window.__sl = []; const o = clock.handleSlideChange.bind(clock); clock.handleSlideChange = () => { o(); window.__sl.push({ t: Date.now(), type: clock.type, el: !!clock.el }); }; });
    const watch = p => p.evaluate(() => { window.__tr = []; const c = document.querySelector('.card.clock'); let was = c.classList.contains('trans');
      new MutationObserver(() => { const now = c.classList.contains('trans'); if (now !== was){ was = now; window.__tr.push({ t: Date.now(), on: now }); } }).observe(c, { attributes: true, attributeFilter: ['class'] }); });
    for (const ph of phones) await watch(ph.p);
    const slides = () => host.evaluate(() => window.__sl.slice());
    const flips = p => p.evaluate(() => window.__tr.slice());
    const hostType = () => host.evaluate(() => (presentation.slides[presentation.current].dataset.type) || '');
    /* one scenario: run fn on the iPad, wait for the iPad slide type, then the phones' flip time vs the iPad's */
    const scenario = async (name, fn, want) => {
      const s0 = (await slides()).length, f0 = await Promise.all(phones.map(ph => flips(ph.p).then(x => x.length)));
      await fn(); await until(async () => (await slides()).slice(s0).some(x => x.type === want || (want === 'level' && x.type === 'level')), 8000); await wait(700);
      const sl = (await slides()).slice(s0).find(x => x.type === want), fl = await Promise.all(phones.map((ph, i) => flips(ph.p).then(x => x.slice(f0[i]).find(y => y.on === (want === 'transition')))));
      return { name, want, delays: fl.map(f => f && sl ? f.t - sl.t : null) }; };
    const R = [];
    await wait(1500);
    if ((await hostType()) !== 'level'){ await host.click('#nextBtn'); await wait(900); }
    R.push(await scenario('timer runs out → Next up', () => host.evaluate(() => { clock.deadline = performance.now() + 120; }), 'transition'));
    /* same second as the iPad, read at the same moments; cards below do not move */
    const same = []; let moved = null;
    { const top = () => phones[0].p.evaluate(() => Math.round(document.getElementById('emojis').closest('.card').getBoundingClientRect().top + scrollY));
      const tRed = await top();
      for (let k = 0; k < 6; k++){ const [h, ph] = await Promise.all([host.evaluate(() => (document.querySelector('.slide.active [data-clock]') || {}).textContent.trim()), phones[0].p.evaluate(() => document.getElementById('time').textContent)]); same.push([h, ph]); await wait(450); }
      R.push(await scenario('Next up runs out → level starts', async () => {}, 'level'));
      const tLevel = await top(); moved = tLevel - tRed; }
    await wait(800);
    R.push(await scenario('⏭ from a level → Next up', () => host.click('#nextBtn'), 'transition'));
    await wait(300);
    R.push(await scenario('⏭ on Next up → level now', () => host.click('#nextBtn'), 'level'));
    await wait(800);
    R.push(await scenario('⏭ again → Next up', () => host.click('#nextBtn'), 'transition'));
    await wait(300);
    R.push(await scenario('⏮ on Next up → back to the level', () => host.click('#prevBtn'), 'level'));
    console.log('        next-up delays (ms, per phone): ' + R.map(r => r.name + ' ' + r.delays.join('/')).join(' | '));
    await check('PREVIEW: iPad "Next up" (run-out, ⏭, ⏭ on Next up, ⏮) → every phone\'s blinds card turns red / back within 300 ms', async () =>
      R.every(r => r.delays.every(d => d !== null && d >= -50 && d <= 300)) || R);
    await check('PREVIEW: …the phone\'s red countdown shows the same second as the iPad (within one tick)', async () =>
      (same.length === 6 && same.every(([h, p]) => /^\d$/.test(p) && Math.abs(+h - +p) <= 1) && same.filter(([h, p]) => h === p).length >= 4) || same);
    await check('PREVIEW: …the cards under the blinds card do not move when it turns red and back', async () => moved === 0 || { moved });
    await check('PREVIEW: …the red card shows "Next up", the level, its blinds and "Starting…"', async () => {
      await host.click('#nextBtn'); await until(() => phones[1].p.evaluate(() => document.querySelector('.card.clock').classList.contains('trans')), 2000);
      const r = await phones[1].p.evaluate(() => ({ lv: document.getElementById('lv').textContent, b: document.getElementById('blinds').textContent, n: document.getElementById('next').textContent, t: document.getElementById('time').textContent, bg: getComputedStyle(document.querySelector('.card.clock')).animationName }));
      await wait(700); await host.click('#nextBtn'); await until(async () => (await hostType()) === 'level', 7000); await wait(600);   /* back on a level for the checks after */
      return (/^Next up · Level \d+$/.test(r.lv) && /^Blinds \S+ \/ \S+$/.test(r.b) && r.n === 'Starting…' && /^[1-5]$/.test(r.t) && r.bg === 'flashRAG') || r; });
    await wait(1500);
  }

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

  if (PV){
    await host.evaluate(() => spotify.disconnect());
    await check('PREVIEW: Spotify disconnected on the iPad → the Now playing card hides on every phone', async () =>
      !!(await until(async () => (await Promise.all(phones.map(ph => ph.p.evaluate(() => document.getElementById('npCard').classList.contains('hide'))))).every(Boolean), 3000)));
  }
  await check('No page errors (iPad + phones)', async () => (!hostErr.length && !phoneErr.length) || { hostErr, phoneErr });

  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  await hb.close(); await pb.close();
  if (srv) srv.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
