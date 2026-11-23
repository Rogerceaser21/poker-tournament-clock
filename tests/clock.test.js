/* Poker Tournament Clock — automated checks (run before every push).
 *
 *   run (it serves the repo itself on :8791):                NODE_PATH=<a node_modules with playwright> node tests/clock.test.js
 *   the PREVIEW copy (preview/…):                             PREVIEW=1 NODE_PATH=… node tests/clock.test.js
 *     → runs every check against preview/Poker Tournament Clock.html; the few checks built on the old "pause for
 *       any sound" rule use a sound that still pauses there, and the extra "PREVIEW:" checks run too.
 *   control (the PREVIEW: checks against the root clock):    PREVIEW=1 ONLY=PREVIEW: CLOCK_URL=http://localhost:8791/Poker%20Tournament%20Clock.html …
 *
 * Drives the real page in iPad-sized Safari (WebKit, iPad user agent) and Chrome.
 * Spotify is faked (no real account needed). Prints a results table; exits 1 if anything fails.
 */
const { webkit, chromium } = require('playwright');
const P = process.env.PREVIEW === '1';
const NSND = P ? 12 : 8, NPER = P ? 4 : 2, NPL = NSND * NPER + 1;   /* sounds; sound players (PREVIEW: 4 per sound, root: 2) + the level beep */
const PAGE = process.env.CLOCK_URL || (P ? 'http://localhost:8791/preview/Poker%20Tournament%20Clock.html' : 'http://localhost:8791/Poker%20Tournament%20Clock.html');
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const LEVELS = [[1, 2], [2, 4], [5, 10]].map(([sb, bb], i) => ({ id: 'L' + (i + 1), sb, bb, mins: 20 }));
const wait = ms => new Promise(r => setTimeout(r, ms));
/* HEADLESS WebKit only: after the first real tap unlocks all 17 sound players, its media side is busy for ~2 s and the
   next play() waits for it. The real Safari engine does not (iPadOS 26.3 Simulator: beep / 💀 audible within 33-125 ms
   of being asked 0.7-4 s after the first tap, all played in full; log /Users/igor/wt/poker-fixes-logs/sim-walk-t3-first-tap-timing.log).
   So the checks whose 2nd tap times a beep let that first tap settle first. */
const SETTLE = 3000;
/* PREVIEW: with 49 players the headless-WebKit stall after the unlock tap lasts up to ~9 s on this Mac (measured: the first
   load() + play() after the tap took 9.3 s, the next 143 ms). So: a throwaway muted player (not one of the clock's) does
   load() + play() until one reaches "playing" within 250 ms, max 15 s. Chrome passes at once. */
const settle = p => p.evaluate(async () => { const a = new Audio('sounds/what.m4a'); a.muted = true; const end = Date.now() + 15000;
  while (Date.now() < end){ const t = Date.now(); a.load(); const pl = new Promise(r => a.addEventListener('playing', r, { once: true }));
    try { await a.play(); } catch (e) {} await Promise.race([pl, new Promise(r => setTimeout(r, 3000))]); const ms = Date.now() - t; a.pause(); if (ms < 250) break; await new Promise(r => setTimeout(r, 100)); } });

async function newPage(browserType, { spotify = false, noTap = false } = {}) {
  const b = await browserType.launch();
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, userAgent: browserType === webkit ? IPAD_UA : undefined, hasTouch: browserType === webkit });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  const spotifyCalls = [];
  /* fake Spotify that keeps state like the real one: pause → paused (a 2nd pause = 403 "Restriction violated"), play → playing.
     log = every call with its send time t and reply time done (ms) */
  const fake = { title: 'Song', artist: 'Artist', playing: true, playDelay: 0, pauseDelay: 0, playFails: [], playFailAll: 0, speaker: false, vol: 70, volFails: 0 }, log = [];
  /* the track position moves while playing (PREVIEW fix round 1: the clock tells the user's own pause by it); readLie = reads say playing */
  { let pl = true, pos = 1000, since = Date.now(); Object.defineProperty(fake, 'playing', { enumerable: true, get(){ return pl; }, set(v){ const n = Date.now(); if (pl) pos += n - since; since = n; pl = v; if (v && fake.onPlay){ const f = fake.onPlay; fake.onPlay = null; f(); } } });
    fake.pos = () => Math.round(pos + (pl ? Date.now() - since : 0)); }
  await ctx.route('https://api.spotify.com/v1/**', async r => {
    const u = r.request().url(), path = u.split('/v1')[1], m = r.request().method(), e = { c: m + ' ' + path.split('?')[0], u: path, t: Date.now(), done: 0, v: +(new URL(u).searchParams.get('volume_percent') || 0) };
    log.push(e);
    if (!path.startsWith('/me/player?')) spotifyCalls.push(e.c);
    const reply = async (o) => { if (e.c === 'PUT /me/player/play' && fake.playDelay) await wait(fake.playDelay); if (e.c === 'PUT /me/player/pause' && fake.pauseDelay) await wait(fake.pauseDelay); e.done = Date.now(); return r.fulfill(o); };
    if (path === '/me') return reply({ status: 200, contentType: 'application/json', body: '{"display_name":"Test"}' });
    if (path.startsWith('/me/player?')) return reply({ status: 200, contentType: 'application/json', body: JSON.stringify({ is_playing: fake.playing || !!fake.readLie, progress_ms: fake.pos(),
      device: fake.speaker ? { id: 'spk', type: 'Speaker', volume_percent: fake.vol, supports_volume: true } : { id: 'ipad', type: 'Tablet', volume_percent: 70, supports_volume: false },
      item: { id: fake.title === 'Song' ? 't' : 't2', name: fake.title, duration_ms: 200000, artists: [{ name: fake.artist }], album: { images: [{ url: 'x' }] } } }) });
    if (e.c === 'PUT /me/player/pause'){ if (!fake.playing) return reply({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } }) }); fake.playing = false; }
    if (e.c === 'PUT /me/player/volume'){ if (fake.volFails > 0 && e.v >= 50){ fake.volFails--;   /* only the RESTORE (back up to 70) fails */ e.st = 500; return reply({ status: 500, contentType: 'application/json', body: '{"error":{"status":500}}' }); } fake.vol = e.v; e.st = 204; return reply({ status: 204, body: '' }); }
    if (e.c === 'PUT /me/player/play' && (fake.playFails.length || fake.playFailAll)){ const st = fake.playFails.shift() || fake.playFailAll;   /* resume refused: Spotify stays paused */
      if (st === 'abort'){ e.done = Date.now(); return r.abort('failed'); }   /* no answer (network) = status 0 */
      return reply({ status: st, headers: st === 429 ? { 'Retry-After': '1', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After' } : {}, contentType: 'application/json', body: JSON.stringify({ error: { status: st, message: 'fail' } }) }); }
    if (e.c === 'PUT /me/player/play' && fake.ignorePlay > 0){ fake.ignorePlay--; return reply({ status: 204, body: '' }); }   /* PREVIEW: 204 but nothing happens */
    if (e.c === 'PUT /me/player/play'){ const res = reply({ status: 204, body: '' }); await res; fake.playing = true; return; }
    /* PREVIEW: transfer playback (PUT /me/player { device_ids, play: true }) = the 3rd way the clock brings the music back */
    if (e.c === 'PUT /me/player'){ fake.transfers = (fake.transfers || 0) + 1; if (fake.playFailAll){ const st = fake.playFailAll; return reply({ status: st, contentType: 'application/json', body: JSON.stringify({ error: { status: st, message: 'fail' } }) }); }
      const res = reply({ status: 204, body: '' }); await res; fake.playing = true; return; }
    return reply({ status: 204, body: '' });
  });
  /* spy: every meme sound started / ended (page clock) */
  /* i = which element (the pool has 2 per sound); __audioNew = how many Audio elements were ever made */
  await p.addInitScript(() => { window.__sfx = []; window.__ends = []; window.__ai = 0; const o = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ if (!this.muted && this.src && this.src.includes('/sounds/')){ const n = this.src.split('/').pop(), i = this.__i || (this.__i = ++window.__ai); window.__sfx.push({ n, i, t: Date.now() });
      this.addEventListener('ended', () => window.__ends.push({ n, i, t: Date.now(), m: this.muted }), { once: true }); } return o.apply(this, arguments); };
    window.__audioNew = 0; const A = window.Audio; window.Audio = new Proxy(A, { construct(t, a){ window.__audioNew++; return Reflect.construct(t, a); } }); });
  /* PREVIEW: main-thread stall recorder (headless WebKit freezes the page 0.2-0.9 s while many sounds start; real iPad
     Safari does not) — a pause → play stretch may exceed 2850 ms only by the stall time measured inside it */
  if (P) await p.addInitScript(() => { window.__stalls = []; let last = Date.now(); setInterval(() => { const n = Date.now(); if (n - last > 60) window.__stalls.push([last, n]); last = n; }, 20); });
  await p.addInitScript(([levels, spotify]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.clear();
    localStorage.setItem('poker_clock_state_v1', JSON.stringify({ v: 1, levels, names: ['Ann', 'Bob', 'Cat'], buyins: [500, 500, 500], photos: [null, null, null], chips: [700, 700, 700], startStack: 700 }));
    if (spotify) localStorage.setItem('poker_spotify_auth_v1', JSON.stringify({ access: 'AT', refresh: 'RT', exp: Date.now() + 3e6 }));
  }, [LEVELS, spotify]);
  await p.goto(PAGE); await wait(900);
  /* spies: how many alerts / sounds fired */
  await p.evaluate(() => {
    window.__alerts = 0; const a = window.levelAlert; window.levelAlert = (...x) => { window.__alerts++; return a(...x); };
    window.__sounds = 0; const s = sound.playTransition.bind(sound); sound.playTransition = (...x) => { window.__sounds++; return s(...x); };
  });
  /* PREVIEW rule: no sound before the first tap (the iPad refuses it), so a check that plays sounds taps once first
     (a synthetic pointerdown = the clock's unlock) and lets headless WebKit's media side settle (see SETTLE) */
  if (P && !noTap){ await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
    await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total), 8000); await settle(p); }
  return { b, p, errors, spotifyCalls, fake, log };
}
const state = p => p.evaluate(() => {
  const sl = presentation.slides[presentation.current], type = sl.dataset.type || (sl.id || (presentation.current === 0 ? 'cover' : 'other'));
  const left = clock.el ? Math.round((clock.paused ? clock.remaining : clock.deadline - performance.now()) / 1000) : null;
  return { type, level: sl.querySelector('.lv') ? sl.querySelector('.lv').textContent : (sl.querySelector('.trans-level') || {}).textContent || '',
    left, full: clock.el ? Math.round(clock.duration / 1000) : null, paused: clock.paused, alerts: window.__alerts, sounds: window.__sounds };
});
const press = async (p, sel) => { await p.click(sel); await wait(650); };
/* music-dip checks: only the pause / play calls, and "no two pauses in a row, each pause after the play before it came back" */
const dips = log => log.filter(e => /\/me\/player\/(pause|play)$/.test(e.c)).map(e => ({ c: e.c.endsWith('pause') ? 'pause' : 'play', t: e.t, done: e.done }));
const clean = d => d.every((e, i) => e.c !== 'pause' || (i === 0 || (d[i - 1].c === 'play' && d[i - 1].done && e.t >= d[i - 1].done)));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end){ const v = await fn(); if (v) return v; await wait(50); } return null; };
const emoji = (p, e) => p.evaluate(e => emojiSfx.play(e), e);
/* PREVIEW: the longest sound that still pauses the music (≤ musicDip.LONG); root: the old pick */
/* PREVIEW (22 Nov rule): every sound pauses the music, so this is simply the longest sound (🔥 wow, 2.6 s) */
const dipE = (p, rootE) => P ? p.evaluate(() => { let b = null;
  for (const [e, n] of Object.entries(EMOJI_SOUNDS)) if (!b || SFX_MS[n] > SFX_MS[EMOJI_SOUNDS[b]]) b = e; return b; }) : Promise.resolve(rootE);
const sndOf = (p, e) => p.evaluate(e => EMOJI_SOUNDS[e], e);
const TOL = 0;
/* (an 'ended' is paired with a start only when it comes > 30 ms after it: the clock starts the next play on a player inside that
   player's own 'ended' handler, before the spy's 'ended' listener runs) */
/* PREVIEW (22 Nov rule) checks on a log of pause / play calls + the page's sound starts / ends:
   rule(p, d) → { pauses: [{ accepted→play ms, limit }], playWhileSounding: [...], musicGap: [play reply → next pause ms] }
   - every pause → its play: play sent ≤ CAP (10 s) + the longest sound (2.6 s) + 0.5 s slack after the pause was answered
     (+ main-thread stall time measured inside it, headless noise)
   - no "play" sent while a clock sound was sounding (between a sound's start and its ended)
   - at least 2 s between the music coming back (its play reply) and the next pause */
const rule = async (p, d) => { const st = await p.evaluate(() => ({ s: window.__sfx.slice(), e: window.__ends.slice(), stalls: window.__stalls || [] }));
  const iv = st.s.map(x => { const e = st.e.find(y => y.i === x.i && y.t > x.t + 30); return [x.t, e ? e.t : Infinity, x.n]; });
  const out = { pauses: [], playWhileSounding: [], musicGap: [] };
  d.forEach((e, i) => { if (e.c === 'pause'){ const n = d.slice(i + 1).find(x => x.c === 'play'); const from = e.done || e.t;
      const frozen = n ? st.stalls.reduce((a, [s, t]) => a + Math.max(0, Math.min(t, n.t) - Math.max(s, from) - 20), 0) : 0;
      out.pauses.push({ ms: n ? n.t - from : Infinity, ok: !!n && n.t - from <= 10000 + 2600 + 500 + frozen });
      const prevPlay = d.slice(0, i).reverse().find(x => x.c === 'play'), firstPlay = prevPlay && d.slice(0, i).find(x => x.c === 'play' && x.t > (d.slice(0, i).reverse().find(y => y.c === 'pause') || { t: 0 }).t);
      if (firstPlay && firstPlay.done) out.musicGap.push(e.t - firstPlay.done); }
    if (e.c === 'play'){ const hit = iv.filter(([a, b]) => e.t > a + 5 && e.t < b - 5).map(x => x[2]); if (hit.length) out.playWhileSounding.push({ at: e.t, hit }); } });
  out.ok = out.pauses.every(x => x.ok) && !out.playWhileSounding.length && out.musicGap.every(g => g >= 1950);
  return out; };
/* each pause → play stretch, and how much of it the page's main thread was frozen (test-harness noise) */
const capCheck = async (p, d) => { const stalls = await p.evaluate(() => window.__stalls || []), out = [];
  d.forEach((e, i) => { if (e.c !== 'pause') return; const n = d.slice(i + 1).find(x => x.c === 'play'); if (!n){ out.push({ v: Infinity, frozen: 0, ok: false }); return; }
    const frozen = stalls.reduce((a, [s, t]) => a + Math.max(0, Math.min(t, n.t) - Math.max(s, e.t) - 20), 0), v = n.t - e.t;
    out.push({ v, frozen, ok: v <= 2850 || v <= 2850 + frozen }); });
  return out; };
const stretches = d => { const out = []; d.forEach((e, i) => { if (e.c === 'pause'){ const n = d.slice(i + 1).find(x => x.c === 'play'); out.push(n ? n.t - e.t : Infinity); } }); return out; };
const expireNow = p => p.evaluate(() => { clock.deadline = performance.now() + 120; });

const TESTS = [
  ['Start → Level 1 at full time, no beep', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); const s = await state(p);
    return s.type === 'level' && s.level === 'Level 1' && s.left >= s.full - 2 && s.alerts === 0 || s; }],
  ['Level 1 counts down', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); const a = await state(p); await wait(2200); const b = await state(p);
    return (a.left - b.left >= 2 && a.left - b.left <= 3) || { a, b }; }],
  ['Timer runs out → 5-s Next up + ONE beep → Level 2 at full time', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await expireNow(p); await wait(900);
    const t = await state(p); await wait(5600); const l = await state(p);
    return (t.type === 'transition' && t.level === 'Level 2' && t.left <= 5 && t.alerts === 1 && l.type === 'level' && l.level === 'Level 2' && l.left >= l.full - 2 && l.alerts === 1) || { t, l }; }],
  ['⏭ from Level 1 → 5-s Next up + ONE beep → Level 2 at full time', async ({ p }) => {
    await p.click('#startBtn'); await wait(SETTLE); await press(p, '#nextBtn');
    const t = await state(p); await wait(5600); const l = await state(p);
    return (t.type === 'transition' && t.level === 'Level 2' && t.alerts === 1 && l.type === 'level' && l.level === 'Level 2' && l.left >= l.full - 2 && l.alerts === 1) || { t, l }; }],
  ['⏭ on the Next-up screen → Level 2 now, no 2nd beep', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await press(p, '#nextBtn'); await press(p, '#nextBtn'); const l = await state(p);
    return (l.type === 'level' && l.level === 'Level 2' && l.left >= l.full - 2 && l.alerts === 1) || l; }],
  ['⏮ from half-way through Level 2 → Level 1 restarted at FULL time, no beep', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.evaluate(() => { clock.deadline -= 7 * 60 * 1000; }); await wait(400);   /* level 1 had used 7 min */
    await press(p, '#nextBtn'); await press(p, '#nextBtn'); await p.evaluate(() => { clock.deadline -= 5 * 60 * 1000; }); await wait(400);
    const before = await state(p); await press(p, '#prevBtn'); const s = await state(p);
    return (s.type === 'level' && s.level === 'Level 1' && s.left >= s.full - 2 && s.alerts === before.alerts) || { before, s }; }],
  ['⏮ on a Next-up screen → back to the level you came from, full time', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await press(p, '#nextBtn'); await press(p, '#prevBtn'); const s = await state(p);
    return (s.type === 'level' && s.level === 'Level 1' && s.left >= s.full - 2) || s; }],
  ['⏮ from Level 1 → cover, no timer running', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await press(p, '#prevBtn'); const s = await state(p);
    return (s.type === 'cover' && s.left === null) || s; }],
  ['Only ONE timer: screens you left never tick', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await press(p, '#nextBtn'); await press(p, '#nextBtn');   /* now on Level 2 */
    const snap = () => p.evaluate(() => [...document.querySelectorAll('.slide')].filter(s => !s.classList.contains('active')).map(s => (s.querySelector('[data-clock]') || {}).textContent || ''));
    const a = await snap(); await wait(2200); const b = await snap();
    return JSON.stringify(a) === JSON.stringify(b) || { a, b }; }],
  ['Pause holds the time; resume carries on', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.keyboard.press('Space'); const a = await state(p); await wait(2100); const b = await state(p);
    await p.keyboard.press('Space'); await wait(2100); const c = await state(p);
    return (a.paused && b.paused && a.left === b.left && !c.paused && b.left - c.left >= 1) || { a, b, c }; }],
  ['Pause button on screen works the same', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.click('#pauseBtn'); const a = await state(p); await wait(1500); const b = await state(p); await p.click('#pauseBtn');
    return (a.paused && a.left === b.left) || { a, b }; }],
  ['Arrow keys = same as ⏭ / ⏮', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.keyboard.press('ArrowRight'); await wait(650); const t = await state(p);
    await p.keyboard.press('ArrowLeft'); await wait(650); const l = await state(p);
    return (t.type === 'transition' && l.type === 'level' && l.level === 'Level 1') || { t, l }; }],
  ['Last level ⏭ → Heads up; ⏮ → last level at full time', async ({ p }) => {
    await p.evaluate(() => presentation.goTo(presentation.slides.findIndex(s => s.dataset.lid === 'L3' && s.dataset.type === 'level'))); await wait(700);
    await press(p, '#nextBtn'); const h = await state(p); await press(p, '#prevBtn'); const l = await state(p);
    return (h.type === 'huSlide' && l.level === 'Level 3' && l.left >= l.full - 2) || { h, l }; }],
  ['Editing blinds mid-level does NOT reset the timer', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.evaluate(() => { clock.deadline -= 3 * 60 * 1000; }); await wait(300); const a = await state(p);
    await p.keyboard.press('r'); await wait(300); await p.fill('#blindRows input[data-lv="0"][data-k="bb"]', '3'); await wait(300);
    await p.click('#addLevel'); await wait(400); await p.keyboard.press('Escape'); await wait(300); const b = await state(p);
    return (b.type === 'level' && Math.abs(a.left - b.left) <= 2) || { a, b }; }],
  ['Table view shows the same time as the clock', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.click('.slide.active [data-table-view]'); await wait(600);
    const r = await p.evaluate(() => ({ tv: tvTimer.textContent, clockText: document.querySelector('.slide.active [data-clock]').textContent.replace(/\s+/g, '') }));
    return r.tv === r.clockText || r; }],
  ['Beep is loud: peak ≥ 95 % of max, strong average', async ({ p }) => {
    const r = await p.evaluate(() => { const b = atob(sound.audio.src.split(',')[1]); let peak = 0, sum = 0, n = 0;
      for (let i = 44; i + 1 < b.length; i += 2){ let v = b.charCodeAt(i) | (b.charCodeAt(i + 1) << 8); if (v > 32767) v -= 65536; const x = Math.abs(v) / 32768; peak = Math.max(peak, x); if (x > .01){ sum += x * x; n++; } }
      return { peak: +peak.toFixed(3), rmsWhilePipping: +Math.sqrt(sum / n).toFixed(3) }; });
    return (r.peak >= 0.95 && r.rmsWhilePipping >= 0.55) || r; }],
  ['With Spotify (iPad, Premium): level change → pause music, beep, play music', async ({ p, spotifyCalls }) => {
    await wait(1200); await p.click('#startBtn'); await wait(SETTLE); spotifyCalls.length = 0; await press(p, '#nextBtn'); await wait(2400);
    const calls = spotifyCalls.filter(c => /pause|play$/.test(c));
    return (calls[0] === 'PUT /me/player/pause' && calls[1] === 'PUT /me/player/play' && calls.length === 2) || { calls }; }, { spotify: true }],
  ['Spotify 403 that is NOT Premium-required keeps the ⏮ ⏯ ⏭ buttons', async ({ p }) => {
    await p.context().route('https://api.spotify.com/v1/me/player/pause', r => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } }) }));
    await wait(1200); await p.evaluate(() => spotify.control('pause')); await wait(1200);
    const r = await p.evaluate(() => ({ premium: spotify.premium, hidden: ['npCtl', 'npSideCtl', 'npBigCtl'].map(i => document.getElementById(i).classList.contains('none')), err: spotify.lastError && spotify.lastError.reason }));
    return (r.premium !== false && r.hidden.every(h => !h) && r.err === 'UNKNOWN') || r; }, { spotify: true }],
  ['Spotify 403 with reason PREMIUM_REQUIRED hides the ⏮ ⏯ ⏭ buttons', async ({ p }) => {
    await p.context().route('https://api.spotify.com/v1/me/player/pause', r => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { status: 403, message: 'Premium required', reason: 'PREMIUM_REQUIRED' } }) }));
    await wait(1200); await p.evaluate(() => spotify.control('pause')); await wait(1200);
    const r = await p.evaluate(() => ({ premium: spotify.premium, hidden: ['npCtl', 'npSideCtl', 'npBigCtl'].map(i => document.getElementById(i).classList.contains('none')) }));
    return (r.premium === false && r.hidden.every(h => h)) || r; }, { spotify: true }],
  ['Music dip: two sounds 300 ms apart → ONE pause, ONE play, play after the last sound ended', async ({ p, log }) => {
    await wait(1200); log.length = 0; emoji(p, '😂'); await wait(300); emoji(p, P ? '💀' : '😭'); await wait(6500);
    const d = dips(log), ends = await p.evaluate(() => window.__ends), last = Math.max(0, ...ends.map(e => e.t)), play = d.find(e => e.c === 'play');
    return (d.length === 2 && d[0].c === 'pause' && d[1].c === 'play' && ends.length === 2 && play.t >= last && clean(d)) || { d, ends }; }, { spotify: true }],
  ['Music dip: a sound while the "play" reply is on its way → no 2nd pause before it, still dips after', async ({ p, log, fake }) => {
    await wait(1200); fake.playDelay = 600; log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'play'), 4000); await wait(100); const t1 = Date.now(); emoji(p, '🤡'); await wait(3500);
    const d = dips(log);
    if (P){ /* PREVIEW (22 Nov rule): it WAITS until the music is back + 2 s of music, then its own pause (never over the music) */
      await wait(3000); const d2 = dips(log), s = await p.evaluate(() => window.__sfx.map(x => x.t)), play1 = d2[1];
      return (d2.map(e => e.c).join() === 'pause,play,pause,play' && clean(d2) && s.length === 2 && play1.done && s[1] >= play1.done + 1950 && d2[2].t >= play1.done + 1950) || { d: d2, s, t1 }; }
    return (d.map(e => e.c).join() === 'pause,play,pause,play' && clean(d)) || { d }; }, { spotify: true }],
  ['Music dip: Spotify not playing → no pause sent at all', async ({ p, log, fake }) => {
    fake.playing = false; await p.evaluate(() => spotify.poll()); await wait(1200); log.length = 0; emoji(p, '🤡'); await wait(2000);
    const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length);
    return (d.length === 0 && sfx === 1) || { d, sfx }; }, { spotify: true }],
  ['Music dip: a poll seeing "paused" mid-dip → music back, shows playing, next sound still dips', async ({ p, log }) => {
    await wait(1200); log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await p.evaluate(() => spotify.poll());
    await until(() => dips(log).some(e => e.c === 'play' && e.done), 4000); if (P) await wait(2100);   /* PREVIEW: 2 s of music (GAP) before a new pause */
    emoji(p, '🤡'); await wait(2500);
    const d = dips(log), r = await p.evaluate(() => ({ playing: spotify.now && spotify.now.playing, k: document.getElementById('npK').textContent }));
    return (d.map(e => e.c).join() === 'pause,play,pause,play' && clean(d) && r.playing === true && r.k === 'Now playing') || { d, r }; }, { spotify: true }],
  ['Music dip: a 403 that is NOT Premium-required on the dip\'s pause keeps the buttons, sound still plays, no play sent', async ({ p, log }) => {
    await p.context().route('https://api.spotify.com/v1/me/player/pause', r => { log.push({ c: 'PUT /me/player/pause', t: Date.now(), done: Date.now() }); return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } }) }); });
    await wait(1200); log.length = 0; emoji(p, '🤡'); await wait(2000);
    const d = dips(log), r = await p.evaluate(() => ({ premium: spotify.premium, hidden: ['npCtl', 'npSideCtl', 'npBigCtl'].map(i => document.getElementById(i).classList.contains('none')), sfx: window.__sfx.length }));
    return (d.map(e => e.c).join() === 'pause' && r.premium !== false && r.hidden.every(h => !h) && r.sfx === 1) || { d, r }; }, { spotify: true }],
  ['Music dip: a long sound (😭 4.5 s) is not cut — play ≥ 4.4 s after the pause', async ({ p, log }) => {
    const e = await dipE(p, '😭'), len = P ? await p.evaluate(e => SFX_MS[EMOJI_SOUNDS[e]], e) : 4500;
    await wait(1200); log.length = 0; emoji(p, e); await wait(6500);
    const d = dips(log), gap = d.length === 2 ? d[1].t - d[0].t : null;
    const ends = await p.evaluate(() => window.__ends.map(x => x.t));   /* PREVIEW: the play goes out only after the sound ended */
    return (d.length === 2 && d[0].c === 'pause' && d[1].c === 'play' && gap >= len - 100 && (!P || (ends.length === 1 && d[1].t >= ends[0]))) || { e, len, d, gap, ends }; }, { spotify: true }],
  ['Music dip: a waiting sound is NOT played (and no extra pause) when sound was muted meanwhile', async ({ p, log, fake }) => {
    if (P){ /* PREVIEW (22 Nov rule): a sound waits when the pause reached its cap (CAP set to 1.5 s here); mute drops it */
      await wait(1200); await p.evaluate(() => { musicDip.CAP = 1500; }); log.length = 0; emoji(p, '💀'); await wait(1700); emoji(p, '🔥');
      await wait(100); await p.evaluate(() => sound.toggleMute()); await wait(5500);
      const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length), q = await p.evaluate(() => musicDip.waiting.length);
      return (d.map(e => e.c).join() === 'pause,play' && sfx === 1 && q === 0 && clean(d)) || { d, sfx, q }; }
    await wait(1200); await p.evaluate(() => { musicDip.MAX = 3000; }); log.length = 0; emoji(p, '😭'); await wait(1500); emoji(p, '🔥');   /* 🔥 (2.6 s) can't end before the 3-s cap → waits */
    await wait(100); await p.evaluate(() => sound.toggleMute()); await wait(5500);
    const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length), q = await p.evaluate(() => musicDip.queue.length);
    return (d.map(e => e.c).join() === 'pause,play' && sfx === 1 && q === 0 && clean(d)) || { d, sfx, q }; }, { spotify: true }],
  ['Music dip: a slow Spotify (pause answers after 6 s) → level alert still sounds within 2 s, one pause + one play after it (PREVIEW fix 6: the pause has its own 3-s limit, so the play goes out after that limit, not after the 6-s answer)', async ({ p, log, fake }) => {
    await wait(1200); fake.pauseDelay = 6000; log.length = 0; const t0 = Date.now(); p.evaluate(() => window.levelAlert());
    const heard = await until(() => p.evaluate(() => window.__sounds > 0), 4000), dt = Date.now() - t0; await wait(8000);
    const d = dips(log);
    return (heard && dt < 2000 && d.map(e => e.c).join() === 'pause,play' && (P ? d[1].t >= d[0].t + 2950 && fake.playing : d[1].t >= d[0].done && clean(d))) || { dt, d }; }, { spotify: true }],
  ['Music dip: resume answers 429 twice, then OK → retried, music back, only one pause', async ({ p, log, fake }) => {
    await wait(1200); fake.playFails = [429, 429]; log.length = 0; emoji(p, '🤡'); await wait(9000);
    const d = dips(log), r = await p.evaluate(() => spotify.now && spotify.now.playing);
    return (d.map(e => e.c).join() === 'pause,play,play,play' && fake.playing && r === true) || { d, r, fake: fake.playing }; }, { spotify: true }],
  ['Music dip: resume fails every time → shows Paused, next sound sends NO pause', async ({ p, log, fake }) => {
    await wait(1200); fake.playFailAll = 500; log.length = 0; emoji(p, '🤡');
    if (P) await until(() => p.evaluate(() => musicDip.state === 'rest' || musicDip.state === 'idle').then(x => x && dips(log).length > 1), 15000);
    else await until(() => dips(log).filter(e => e.c === 'play' && e.done).length === 3, 7000);
    await wait(100);
    const r = await p.evaluate(() => ({ playing: spotify.now && spotify.now.playing, k: document.getElementById('npK').textContent })); emoji(p, '🤡'); await wait(P ? 3500 : 1500);
    const d = dips(log);
    /* PREVIEW (22 Nov rule): plain play ×3, play with device_id ×3, transfer playback ×3 (= PLAYS_MAX 9), then the card shows Paused */
    return (d.map(e => e.c).join() === (P ? 'pause,play,play,play,play,play,play' : 'pause,play,play,play') && (!P || fake.transfers === 3) && r.playing === false && r.k !== 'Now playing') || { d, r, transfers: fake.transfers }; }, { spotify: true }],
  ['Music dip (speaker): volume restore fails 3 times → next dip still restores the ORIGINAL 70, never lowers from the lowered level', async ({ p, log, fake }) => {
    fake.speaker = true; await p.evaluate(() => spotify.poll()); await wait(1200);
    fake.volFails = 3; log.length = 0; emoji(p, '🤡');
    await until(() => log.filter(e => e.c === 'PUT /me/player/volume' && e.st === 500).length === 3, 8000); await wait(300);
    await p.evaluate(() => spotify.poll()); await wait(600); emoji(p, '🤡'); await wait(P ? 4500 : 2500);   /* PREVIEW: it waits the 2 s of music first */
    const v = log.filter(e => e.c === 'PUT /me/player/volume').map(e => e.v + ':' + e.st);
    return (v.join() === '18:204,70:500,70:500,70:500,18:204,70:204' && fake.vol === 70) || { v, vol: fake.vol }; }, { spotify: true }],
  ['Music dip: slow pause (answers after 6 s) → 4 emojis + level alert fired together ALL start within 2 s, one pause + one play', async ({ p, log, fake }) => {
    await wait(1200); fake.pauseDelay = 6000; log.length = 0;
    const t0 = await p.evaluate(() => { window.__alertAt = 0; const o = sound.playTransition.bind(sound); sound.playTransition = (...x) => { window.__alertAt = Date.now(); return o(...x); };
      const t = Date.now(); window.__sfx.length = 0; ['😂', '🔥', '💀', '👏'].forEach(e => emojiSfx.play(e)); window.levelAlert(); return t; });
    await wait(12000);
    const r = await p.evaluate(() => ({ sfx: window.__sfx.map(x => x.t), alert: window.__alertAt })), late = [...r.sfx, r.alert].map(t => t ? t - t0 : null), d = dips(log);
    return (r.sfx.length === 4 && late.every(x => x !== null && x < 2000) && clean(d) && d.map(e => e.c).join() === 'pause,play' && fake.playing) || { late, d, playing: fake.playing }; }, { spotify: true }],
  ['Music dip: slow resume (play answers after 6 s) → a level alert right after the sound still starts within 2 s, music ends playing', async ({ p, log, fake }) => {
    await wait(1200); fake.playDelay = 6000; log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'play'), 4000); await wait(100);
    const t0 = Date.now(); p.evaluate(() => window.levelAlert());
    const heard = await until(() => p.evaluate(() => window.__sounds > 0), 12000), dt = Date.now() - t0; await wait(P ? 9000 : 7500);
    const d = dips(log);
    if (P){ /* PREVIEW (22 Nov rule): the beep waits for the music to be back (6 s reply) + 2 s of music, then its own pause; never during the play */
      const play1 = d[1];
      return (heard && play1 && play1.done && t0 + dt >= play1.done + 1950 && d.map(e => e.c).join() === 'pause,play,pause,play' && clean(d) && fake.playing) || { dt, d, playing: fake.playing }; }
    return (heard && dt < 2000 && clean(d) && d.length && d[d.length - 1].c === 'play' && fake.playing) || { dt, d, playing: fake.playing }; }, { spotify: true }],
  ['Music dip: slow resume (play answers after 6 s) → 4 emojis + level alert fired together ALL start within 2 s', async ({ p, log, fake }) => {
    await wait(1200); fake.playDelay = 6000; log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'play'), 4000); await wait(100);
    const t0 = await p.evaluate(() => { window.__alertAt = 0; const o = sound.playTransition.bind(sound); sound.playTransition = (...x) => { window.__alertAt = Date.now(); return o(...x); };
      const t = Date.now(); window.__sfx.length = 0; ['😂', '🔥', '💀', '👏'].forEach(e => emojiSfx.play(e)); window.levelAlert(); return t; });
    await wait(P ? 18000 : 9000);
    const r = await p.evaluate(() => ({ sfx: window.__sfx.map(x => x.t), alert: window.__alertAt })), late = [...r.sfx, r.alert].map(t => t ? t - t0 : null), d = dips(log);
    if (P){ /* PREVIEW (22 Nov rule): all five wait for the music (6 s reply) + 2 s, then play together in ONE new pause */
      const play1 = d[1], all = [...r.sfx, r.alert];
      return (r.sfx.length === 4 && r.alert && play1 && play1.done && all.every(t => t >= play1.done + 1950) && Math.max(...all) - Math.min(...all) < 1000 && clean(d) && d.map(e => e.c).join() === 'pause,play,pause,play' && fake.playing) || { late, d: d.map(x => x.c + '@' + (x.t - t0)), playing: fake.playing }; }
    return (r.sfx.length === 4 && late.every(x => x !== null && x < 2000) && clean(d) && d.map(e => e.c).join() === 'pause,play' && fake.playing) || { late, d, playing: fake.playing }; }, { spotify: true }],
  ['Emoji: same emoji twice 300 ms apart → two players overlap, the first is NOT restarted (runs to its own end)', async ({ p }) => {
    await wait(600); emoji(p, '💀'); await wait(300); emoji(p, '💀'); await wait(3500);
    const r = await p.evaluate(() => ({ s: window.__sfx.filter(x => x.n === 'fah.m4a'), e: window.__ends.filter(x => x.n === 'fah.m4a') }));
    const [a, b] = r.s, ea = a && r.e.find(x => x.i === a.i), eb = b && r.e.find(x => x.i === b.i);
    return (r.s.length === 2 && a.i !== b.i && ea && eb && b.t < ea.t && ea.t - a.t >= 1800 && eb.t - b.t >= 1800) || r; }],
  ['Emoji: the length table matches the real files (within 100 ms)', async ({ p }) => {
    const r = await until(() => p.evaluate(() => { if (typeof emojiSfx === 'undefined' || !emojiSfx.MS || !emojiSfx.pool) return { none: true };
      const out = {}; for (const [n, l] of Object.entries(emojiSfx.pool)){ const d = l[0].duration; if (!isFinite(d) || !(d > 0)) return null; out[n] = { real: Math.round(d * 1000), table: emojiSfx.MS[n] }; } return out; }), 8000);
    return (r && !r.none && Object.keys(r).length === NSND && Object.values(r).every(x => Math.abs(x.real - x.table) <= 100)) || r; }],
  ['Emoji: no Audio element is made at play time (all 16 made at start-up)', async ({ p }) => {
    const n0 = await p.evaluate(() => window.__audioNew);
    await p.evaluate(() => ['😂', '🔥', '💀', '💀', '💀', '🤡', '💰'].forEach(e => emojiSfx.play(e))); await wait(800);
    const n1 = await p.evaluate(() => window.__audioNew);
    return (n0 >= NPL && n1 === n0) || { n0, n1 }; }],
  ['Emoji: unlock is retried — 1st tap refused, 2nd tap (touchend) unlocks every player', async ({ p }) => {
    await p.evaluate(() => { const o = HTMLMediaElement.prototype.play; window.__refuse = true;
      HTMLMediaElement.prototype.play = function(){ if (window.__refuse && this.muted) return Promise.reject(new DOMException('no', 'NotAllowedError')); return o.apply(this, arguments); }; });
    await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown'))); await wait(400);
    const a = await p.evaluate(() => ({ n: emojiSfx.unlockedCount, total: emojiSfx.total }));
    await p.evaluate(() => { window.__refuse = false; window.dispatchEvent(new Event('touchend')); });
    const b = await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total && emojiSfx.unlockedCount), 4000);
    const quiet = await p.evaluate(() => emojiSfx.all().every(x => x.paused && !x.muted) && sound.audio.paused && !sound.audio.muted);
    return (typeof a.n === 'number' && a.total === NPL && a.n < a.total && b === NPL && quiet) || { a, b, quiet }; }, { noTap: true }],
  ['Emoji: an unlock still on its way does not silence a real play started at the same moment', async ({ p }) => {
    await wait(600);
    await p.evaluate(() => { const o = HTMLMediaElement.prototype.play;   /* the 💀 players' unlock (muted) plays answer 400 ms late (only those: 17 running at once stalls headless WebKit) */
      HTMLMediaElement.prototype.play = function(){ const r = o.apply(this, arguments); return this.muted && this.src.includes('fah') ? new Promise((ok, bad) => setTimeout(() => r.then(ok, bad), 400)) : r; };
      window.dispatchEvent(new PointerEvent('pointerdown')); emojiSfx.play('💀'); });
    /* the real play must run to its own end, unmuted (an unlock that paused / muted it would never end, or end muted) */
    await until(() => p.evaluate(() => window.__ends.some(x => x.n === 'fah.m4a')), P ? 20000 : 8000);
    const r = await p.evaluate(() => ({ s: window.__sfx.filter(x => x.n === 'fah.m4a'), e: window.__ends.filter(x => x.n === 'fah.m4a') }));
    /* PREVIEW: a play that does not reach "playing" within 1.5 s is over and gets ONE more go (the 22 Nov rule); headless WebKit's
       stall right after the tap (up to ~9 s here) can use that second go, so the LAST play must end in full, unmuted */
    const s = r.s[r.s.length - 1], e = s && r.e.find(x => x.i === s.i && x.t > s.t + 30);
    return ((P ? r.s.length >= 1 && r.s.length <= 2 : r.s.length === 1) && e && !e.m && e.t - s.t >= 1800) || r; }, { noTap: true }],
  ['Emoji: emojiSfx.log records a refused play (error name) and a good play (ok true)', async ({ p }) => {
    await wait(600);
    await p.evaluate(() => { const o = HTMLMediaElement.prototype.play; window.__refuseFah = true;
      HTMLMediaElement.prototype.play = function(){ if (window.__refuseFah && !this.muted && this.src.includes('fah')) return Promise.reject(new DOMException('no', 'NotAllowedError')); return o.apply(this, arguments); }; });
    await emoji(p, '💀'); await wait(500); await p.evaluate(() => { window.__refuseFah = false; }); await emoji(p, '🤡'); await wait(800);
    const log = await p.evaluate(() => emojiSfx.log || null), bad = log && log.find(x => x.e === '💀'), good = log && log.find(x => x.e === '🤡');
    return (bad && bad.ok === false && bad.err === 'NotAllowedError' && typeof bad.at === 'number' && good && good.ok === true) || { log }; }],
  ['Emoji: a play dropped while its player\'s unlock is on its way leaves no player muted or playing', async ({ p }) => {
    const e = await dipE(p, '😭'), n = await sndOf(p, e);
    await wait(600);
    await p.evaluate(([e, n]) => { const o = HTMLMediaElement.prototype.play;   /* the 😭 players' unlock (muted) plays answer 600 ms late */
      HTMLMediaElement.prototype.play = function(){ const r = o.apply(this, arguments); return this.muted && this.src.includes(n) ? new Promise((ok, bad) => setTimeout(() => r.then(ok, bad), 600)) : r; };
      window.dispatchEvent(new PointerEvent('pointerdown')); emojiSfx.play(e); emojiSfx.on = false; }, [e, n]);   /* switched off before its dip turn → dropped */
    await wait(1500);
    const r = await p.evaluate(n => emojiSfx.pool[n].map(a => ({ paused: a.paused, muted: a.muted, t: +a.currentTime.toFixed(2), ok: a._ok, job: !!a._job })), n);
    return r.every(a => a.paused && !a.muted && a.t === 0 && a.ok && !a.job) || r; }, { noTap: true }],
  ['Emoji: mute while 😭 plays → it stops within 200 ms and the music is back within ~1 s', async ({ p, log }) => {
    const e = await dipE(p, '😭'), n = await sndOf(p, e);
    await wait(1200); log.length = 0; emoji(p, e);
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await wait(800);
    const t0 = Date.now(); await p.evaluate(() => sound.toggleMute());
    const stop = await until(() => p.evaluate(n => emojiSfx.pool[n].every(a => a.paused), n), 2000), dt = Date.now() - t0;
    const back = await until(() => dips(log).find(e => e.c === 'play'), 3000), d = dips(log);
    return (stop && dt <= 200 && back && back.t - t0 <= 1000 && d.map(e => e.c).join() === 'pause,play') || { dt, back: back && back.t - t0, d }; }, { spotify: true }],
  ['Emoji: switching Emoji sounds off while 😭 plays → it stops within 200 ms and the music is back within ~1 s', async ({ p, log }) => {
    const e = await dipE(p, '😭'), n = await sndOf(p, e);
    await wait(1200); log.length = 0; emoji(p, e);
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await wait(800);
    const t0 = Date.now(); await p.evaluate(() => { const es = document.getElementById('phEmojiSounds'); es.checked = false; es.dispatchEvent(new Event('change')); });
    const stop = await until(() => p.evaluate(n => emojiSfx.pool[n].every(a => a.paused), n), 2000), dt = Date.now() - t0;
    const back = await until(() => dips(log).find(e => e.c === 'play'), 3000), d = dips(log);
    return (stop && dt <= 200 && back && back.t - t0 <= 1000 && d.map(e => e.c).join() === 'pause,play') || { dt, back: back && back.t - t0, d }; }, { spotify: true }],
  ...(P ? [['Emoji: mute while 4 🔥 sound and a 5th waits for a free player → no emoji player plays 250 ms later (PREVIEW: replaces the "3rd 😭 waits for its dip turn" check)', async ({ p }) => {
    await wait(600); for (let i = 0; i < 5; i++){ emoji(p, '🔥'); await wait(120); }   /* 4 players per sound: the 5th waits, it never takes a sounding one */
    const r0 = await p.evaluate(() => ({ n: emojiSfx.pool['wow'].filter(a => !a.paused && !a.muted).length, q: musicDip.waiting.length }));
    await wait(100); await p.evaluate(() => sound.toggleMute()); await wait(250);
    const r = await p.evaluate(() => emojiSfx.all().filter(a => !a.paused && !a.muted).map(a => a.src.split('/').pop() + '@' + a.currentTime.toFixed(2)));
    await wait(1800); const later = await p.evaluate(() => emojiSfx.all().filter(a => !a.paused && !a.muted).length), q = await p.evaluate(() => musicDip.waiting.length);
    return (r0.n === 4 && r0.q === 1 && r.length === 0 && later === 0 && q === 0) || { r0, r, later, q }; }]] : []),
  ...(P ? [] : [['Emoji: mute while a 3rd 😭 reuses a playing player and still waits for its dip turn → no emoji player plays 250 ms later', async ({ p }) => {
    const e = await dipE(p, '😭');
    await wait(600); emoji(p, e); await wait(300); emoji(p, e); await wait(500);
    await p.evaluate(e => { musicDip.run(() => new Promise(r => setTimeout(r, 1500))); emojiSfx.play(e); }, e);   /* dip chain busy 1.5 s: the 3rd waits */
    await wait(100); await p.evaluate(() => sound.toggleMute()); await wait(250);
    const r = await p.evaluate(() => emojiSfx.all().filter(a => !a.paused && !a.muted).map(a => a.src.split('/').pop() + '@' + a.currentTime.toFixed(2)));
    await wait(1800); const later = await p.evaluate(() => emojiSfx.all().filter(a => !a.paused && !a.muted).length);
    return (r.length === 0 && later === 0) || { r, later }; }]]),
  ['Beep: mute while the level beep plays → the music is back within ~1 s; the next alert still dips and sounds', async ({ p, log }) => {
    await wait(1200); log.length = 0; p.evaluate(() => window.levelAlert());
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await wait(200);
    const t0 = Date.now(); await p.evaluate(() => sound.toggleMute());
    const back = await until(() => dips(log).find(e => e.c === 'play'), 4000);
    await wait(1500); await p.evaluate(() => sound.toggleMute()); await wait(2200); log.length = 0; const s0 = await p.evaluate(() => window.__sounds);
    p.evaluate(() => window.levelAlert()); await wait(3500); const d = dips(log), s1 = await p.evaluate(() => window.__sounds);
    return (back && back.t - t0 <= 1000 && d.map(e => e.c).join() === 'pause,play' && s1 === s0 + 1) || { back: back && back.t - t0, d, s0, s1 }; }, { spotify: true }],
  ...(P ? [['Beep (PREVIEW fix 5, replaces "a real beep that played counts as unlocked"): its own player not unlocked (its unlock switched off, the emoji players unlocked) → a level change pauses NOTHING and plays no beep; the tap line stays', async ({ p, log }) => {
    await p.evaluate(() => { sound._unlock = () => {}; window.dispatchEvent(new PointerEvent('pointerdown')); });
    await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total - 1), 8000); await settle(p); log.length = 0;
    await p.evaluate(() => window.levelAlert()); await wait(2500);
    const r = await p.evaluate(() => ({ unlocked: sound.unlocked, beeps: window.__sounds, hint: getComputedStyle(document.getElementById('sndHint')).display !== 'none', dip: musicDip.lastBeep && musicDip.lastBeep.dip }));
    return (r.unlocked === false && r.beeps === 0 && r.hint && r.dip === 'no tap yet' && dips(log).length === 0) || r; }, { spotify: true, noTap: true }]] : [
  ['Beep: a real beep that played counts the beep player as unlocked (unlock never ran)', async ({ p }) => {
    /* PREVIEW: a beep needs a tap first like every sound — the tap unlocks the emoji players only (the beep's own unlock is switched off) */
    await p.evaluate(() => { sound._unlock = () => {}; if (typeof emojiSfx.ready === 'function') window.dispatchEvent(new PointerEvent('pointerdown')); });
    if (P){ await until(() => p.evaluate(() => emojiSfx.ready()), 4000); await settle(p); }
    await p.evaluate(() => window.levelAlert()); await wait(P ? 2500 : 1500);
    const r = await p.evaluate(() => ({ unlocked: sound.unlocked, n: emojiSfx.unlockedCount, emoji: emojiSfx.all().filter(a => a._ok).length }));
    return (r.unlocked === true && r.n === r.emoji + 1) || r; }, { noTap: true }]]),
  ['Old stored Premium=false (v1 key) is ignored after reload and the old key is removed', async ({ p }) => {
    await wait(1200); await p.evaluate(() => localStorage.setItem('poker_spotify_auth_v1_premium', 'false'));
    await p.reload(); await wait(1500);
    const r = await p.evaluate(() => ({ premium: spotify.premium, old: localStorage.getItem('poker_spotify_auth_v1_premium'), hidden: ['npCtl', 'npSideCtl', 'npBigCtl'].map(i => document.getElementById(i).classList.contains('none')) }));
    return (r.premium !== false && r.old === null && r.hidden.every(h => !h)) || r; }, { spotify: true }],
  ['Phones panel: hidden Status block — hidden by default, a click opens it with Spotify device / Premium / last error / sounds / last sounds, a 2nd click hides it', async ({ p }) => {
    await p.context().route('https://api.spotify.com/v1/me/player/pause', r => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } }) }));
    await wait(1200); await p.evaluate(() => { spotify.premium = true; });
    await p.evaluate(() => spotify.control('pause')); await wait(800);
    await p.click('#phonesBtn'); await wait(500);
    const hid = await p.evaluate(() => document.getElementById('phDiag').hidden && getComputedStyle(document.getElementById('phDiag')).display === 'none');
    await p.click('#phDiagToggle'); await wait(300);
    const vis = await p.evaluate(() => getComputedStyle(document.getElementById('phDiag')).display !== 'none');
    await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total), 8000);
    await emoji(p, '🤡'); await wait(2500);
    const t = await p.evaluate(() => document.getElementById('phDiag').textContent);
    const L = t.split('\n'), box = await p.evaluate(() => { const d = document.getElementById('phDiag').getBoundingClientRect(), c = document.querySelector('.ph-card').getBoundingClientRect(); return d.right <= c.right && d.left >= c.left; });
    await p.click('#phDiagToggle'); await wait(200);
    const hid2 = await p.evaluate(() => getComputedStyle(document.getElementById('phDiag')).display === 'none');
    return (hid && vis && hid2 && box && /^Spotify: Tablet, volume control no, Premium yes$/.test(L[0]) && /^Last Spotify error: 403 UNKNOWN \/me\/player\/pause, \d+ s ago$/.test(L[1])
      && L[2] === 'Sounds unlocked: ' + NPL + ' of ' + NPL && /^Audio mode: /.test(L[3]) && /^Music pause: /.test(L[4])
      && (P ? /^Last pause: \d\d:\d\d:\d\d, no pause \(Spotify was not playing\) \(answer \d+ ms\), 1 sound, \d+\.\d s, nothing to bring back$/.test(L[5]) && /^Last beep: none yet$/.test(L[6]) && /^Last sounds: 🤡 ok/.test(L[7]) && L.length === 8
        : /^Last sounds: 🤡 ok/.test(L[5]) && L.length === 6)) || { hid, vis, hid2, box, t }; }, { spotify: true }],
  ['Phones panel: Status block says "Spotify: not connected" when Spotify is not connected (and "none" errors, sounds not unlocked yet)', async ({ p }) => {
    await p.click('#phonesBtn'); await wait(500); await p.click('#phDiagToggle'); await wait(300);
    const t = await p.evaluate(() => document.getElementById('phDiag').textContent), L = t.split('\n');
    return (L[0] === 'Spotify: not connected' && L[1] === 'Last Spotify error: none' && new RegExp('^Sounds unlocked: \\d+ of ' + NPL + '( — tap the screen once)?$').test(L[2]) && L[P ? 7 : 5] === 'Last sounds: none yet' && (!P || (L[5] === 'Last pause: none yet' && L[6] === 'Last beep: none yet'))) || { t }; }, { noTap: true }],
];

/* ---- PREVIEW only (PREVIEW=1): the music-safety rule, the 404 retry, the PREVIEW tag, the join link ---- */
/* a real sound longer than 2.7 s if the preview has one, else 😭 is TOLD it is 4 s long (the rule reads SFX_MS) */
const longE = p => p.evaluate(() => { const L = (typeof musicDip !== 'undefined' && musicDip.LONG) || 2700;
  const e = Object.keys(EMOJI_SOUNDS).find(e => SFX_MS[EMOJI_SOUNDS[e]] > L); if (e) return e; SFX_MS[EMOJI_SOUNDS['😭']] = 4000; return '😭'; });
const burst = (p, list, every) => p.evaluate(([list, every]) => list.forEach((e, i) => setTimeout(() => emojiSfx.play(e), i * every)), [list, every]);
/* every unmuted emoji start vs when it was fired (sorted pairing; each sound fired at most twice = its 2 players) */
const fired = (p, list, every) => p.evaluate(([list, every]) => { window.__fired = []; list.forEach((e, i) => setTimeout(() => { window.__fired.push(Date.now()); emojiSfx.play(e); }, i * every)); }, [list, every]);
const startLate = p => p.evaluate(() => { const f = window.__fired.slice().sort((a, b) => a - b), s = window.__sfx.map(x => x.t).sort((a, b) => a - b);
  return { n: s.length, fired: f.length, worst: Math.max(...f.map((t, i) => s[i] != null ? s[i] - t : 1e9)) }; });
const settled = (p, log) => until(async () => { const d = dips(log); return d.length && d[d.length - 1].c === 'play' && d[d.length - 1].done && !(await p.evaluate(() => musicDip.busy())); }, 40000);
const SEED40 = () => { const a = ['😂', '🔥', '🤡', '💀', '👏', '😭', '🤯', '💰']; let t = 0, s = 7; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 40; i++){ t += Math.floor(rnd() * 600); const e = a[Math.floor(rnd() * 8)]; setTimeout(() => emojiSfx.play(e), t); } };
const TEN = ['😂', '🔥', '🤡', '💀', '🤯', '📖', '👏', '😭', '💰', '💵', '❓', '💣'];   /* (name kept) the twelve emojis, 3 rows of 4 on the phone */
const TEN_SND = { '😂': 'oh-my-god', '🔥': 'wow', '🤡': 'bruh', '💀': 'fah', '🤯': 'what', '📖': 'cool-story-bro', '👏': 'very-nice', '😭': 'emotional-damage', '💰': 'show-me-the-money', '💵': 'pay-that-man', '❓': 'what-happened', '💣': 'boomshakalaka' };
/* the five new clips: SFX_MS = ffprobe length within 30 ms. The five kept Remotion sounds keep their old values (set to
   what Safari decodes; ffprobe / Chrome count ~70 ms more AAC priming on those) and the old 100-ms rule. */
const NEW5 = ['very-nice', 'emotional-damage', 'show-me-the-money', 'pay-that-man', 'what-happened', 'what', 'cool-story-bro', 'boomshakalaka'];   /* the new clips: ffprobe within 30 ms */
const fakeConn = id => ({ connectionId: id, open: true, sent: [], send(m){ this.sent.push(m); } });
/* PREVIEW end-pages items 1-2 (23 Nov): the Heads up button in the bar opens the Heads up page OVER the running level */
/* a big noisy JPEG made in the page (w x h), as a Buffer — a stand-in for a 12-megapixel iPad photo */
const bigJpeg = async (p, w, h) => Buffer.from(await p.evaluate(([w, h]) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#c33'); g.addColorStop(1, '#36c'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 1500; i++){ x.fillStyle = 'hsl(' + (i * 37 % 360) + ',70%,' + (30 + i % 40) + '%)'; x.fillRect(Math.random() * w, Math.random() * h, 20 + Math.random() * 300, 20 + Math.random() * 300); }
  return c.toDataURL('image/jpeg', 0.92).split(',')[1]; }, [w, h]), 'base64');
const HU = {
  open: async p => { await p.click('#headsUpBtn', { timeout: 2000 }); await wait(600); },
  /* the page really on top: the element in the middle of the screen belongs to the Heads up page */
  top: p => p.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return !!(e && e.closest('#huSlide')); }),
  view: p => p.evaluate(() => { const t = id => ((document.getElementById(id) || {}).textContent || '').replace(/\s+/g, ' ').trim();
    return { timer: t('huTimer'), level: t('huLevel'), blinds: t('huBlinds'), next: t('huNext'),
      names: [0, 1].map(s => (document.querySelector('[data-hu-name="' + s + '"]') || {}).textContent),
      chips: [0, 1].map(s => (document.querySelector('[data-hu-chips="' + s + '"]') || {}).textContent),
      seats: [...document.querySelectorAll('#huSlide .hu-seat-card')].map(c => c.innerText.replace(/\s+/g, ' ').trim()),
      invested: document.getElementById('huSlide').innerText.includes('Invested') }; }),
  secs: t => { const m = /^(\d+):(\d\d)$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; },
  /* a phone (signed in as `name`) sends a chip count, the way phones.onData gets it */
  phone: (p, name, value) => p.evaluate(([name, value]) => { const c = { connectionId: 'ph-' + name, open: true, send(){} }; phones.conns.set(c.connectionId, { c, name });
    phones.onData(c, { t: 'chips', name, value, id: 'x' + Math.random() }); }, [name, value]),
  chips: (p, arr) => p.evaluate(arr => { bank.chips.splice(0, bank.chips.length, ...arr); syncBankUI(); }, arr),
  /* 4 players Ann 900 / Bob 800 / Cat 500 / Dan 400 */
  four: p => p.evaluate(() => { resizeBank(4); bank.names.splice(0, 4, 'Ann', 'Bob', 'Cat', 'Dan'); bank.chips.splice(0, 4, 900, 800, 500, 400); syncBankUI(); })
};
const PREVIEW_TESTS = [
  ['PREVIEW: twelve emojis in order (😂 🔥 🤡 💀 / 🤯 📖 👏 😭 / 💰 💵 ❓ 💣), each with its own sound file, SFX_MS of the new clips within 30 ms of ffprobe', async ({ p }) => {
    const r = await until(() => p.evaluate(() => { const out = {}; for (const [n, l] of Object.entries(emojiSfx.pool)){ const d = l[0].duration; if (!isFinite(d) || !(d > 0)) return null; out[n] = { real: Math.round(d * 1000), table: SFX_MS[n] }; }
      return { emojis: EMOJIS, map: EMOJI_SOUNDS, len: out, players: emojiSfx.all().length }; }), 10000);
    const files = r && Object.values(r.map), dir = require('path').resolve(__dirname, '..', 'preview', 'sounds');
    /* the real length = ffprobe on the file itself (browsers add up to ~70 ms of AAC priming for some files) */
    const probe = n => { try { return Math.round(1000 * +require('child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dir + '/' + n + '.m4a']).toString().trim()); } catch (e) { return null; } };
    const ff = r ? Object.fromEntries(files.map(n => [n, { file: probe(n), table: r.len[n] && r.len[n].table, browser: r.len[n] && r.len[n].real }])) : null;
    return (r && JSON.stringify(r.emojis) === JSON.stringify(TEN) && JSON.stringify(r.map) === JSON.stringify(TEN_SND) && new Set(files).size === 12 && Object.keys(r.len).length === 12
      && Object.entries(ff).every(([n, x]) => x.file != null && Math.abs(x.browser - x.table) <= 100 && (!NEW5.includes(n) || Math.abs(x.file - x.table) <= 30)) && r.players === 48) || { emojis: r && r.emojis, ff, players: r && r.players }; }],
  ['PREVIEW: ONE tap unlocks all 48 emoji players (4 per sound, + the beep = 49 of 49)', async ({ p }) => {
    await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
    const ok = await until(() => p.evaluate(() => emojiSfx.unlockedCount === 49 && emojiSfx.all().length === 48 && emojiSfx.all().every(a => a._ok)), 8000);
    const r = await p.evaluate(() => ({ n: emojiSfx.unlockedCount, total: emojiSfx.total, quiet: emojiSfx.all().every(a => a.paused && !a.muted) }));
    return (ok && r.total === 49 && r.quiet) || r; }, { noTap: true }],
  ['PREVIEW: before the first tap an emoji pauses NOTHING (no Spotify pause / play), plays nothing, shows "Tap the screen once to turn sounds on"; the tap hides it and the next emoji pauses and plays', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0;
    const hid0 = await p.evaluate(() => getComputedStyle(document.getElementById('sndHint')).display === 'none');
    for (const e of ['🔥', '💀', '🤡']){ await emoji(p, e); await wait(300); } await wait(800);
    const a = await p.evaluate(() => { const h = document.getElementById('sndHint'); return { shown: getComputedStyle(h).display !== 'none', text: h.textContent, sfx: window.__sfx.length, pe: getComputedStyle(h).pointerEvents }; }), d0 = dips(log).length;
    await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown'))); await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total), 8000);
    const gone = await p.evaluate(() => getComputedStyle(document.getElementById('sndHint')).display === 'none');
    await settle(p);
    await emoji(p, '🤡'); await wait(2500); const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length);
    return (hid0 && a.shown && a.text === 'Tap the screen once to turn sounds on' && a.pe === 'none' && a.sfx === 0 && d0 === 0 && gone && d.map(x => x.c).join() === 'pause,play' && sfx === 1 && fake.playing) || { hid0, a, d0, gone, d, sfx }; }, { spotify: true, noTap: true }],
  ['PREVIEW: 💵 and ❓ from a phone are accepted, fly up on the iPad and play their own sounds (pay-that-man, what-happened)', async ({ p }) => {
    await wait(600); const r = await p.evaluate(async () => { const out = {};
      for (const [i, e] of [['a', '💵'], ['b', '❓']]){ const c = { connectionId: 'tc' + i, open: true, sent: [], send(m){ this.sent.push(m); } };
        phones.onData(c, { t: 'emoji', e, name: i === 'a' ? 'Ann' : 'Bob', id: 'x' + i }); out[e] = c.sent.find(m => m.t === 'ack'); }
      await new Promise(r => setTimeout(r, 600));
      return { acks: out, fly: [...document.querySelectorAll('#emojiLayer .emoji-fly .e')].map(x => x.textContent), sfx: window.__sfx.map(x => x.n) }; });
    return (r.acks['💵'] && r.acks['💵'].ok && r.acks['❓'] && r.acks['❓'].ok && r.fly.includes('💵') && r.fly.includes('❓') && r.sfx.includes('pay-that-man.m4a') && r.sfx.includes('what-happened.m4a')) || r; }],
  ['PREVIEW: phones state carries the Spotify song — title/artist, new track pushed, user pause = not playing, clock dip still playing, not connected = null', async ({ p, log, fake }) => {
    await wait(1500);
    await p.evaluate(() => { window.__pushes = 0; const o = phones.push.bind(phones); phones.push = (...a) => { window.__pushes++; return o(...a); }; });
    const snap = () => p.evaluate(() => phones.snapshot().now);
    const a = await snap(); fake.title = 'Other Song'; fake.artist = 'Other Artist'; await p.evaluate(() => spotify.poll()); await wait(400);
    const b = await snap(), pushed = await p.evaluate(() => window.__pushes);
    fake.playing = false; await p.evaluate(() => spotify.poll()); await wait(400); const c = await snap();
    fake.playing = true; await p.evaluate(() => spotify.poll()); await wait(400); log.length = 0; emoji(p, '💀');
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await p.evaluate(() => spotify.poll()); await wait(300); const d = await snap(), midDip = !fake.playing;
    await wait(3000); await p.evaluate(() => spotify.disconnect()); const e = await snap();
    return (a && a.title === 'Song' && a.artist === 'Artist' && a.playing === true && b && b.title === 'Other Song' && b.artist === 'Other Artist' && pushed >= 1
      && c && c.playing === false && d && d.playing === true && midDip && e === null) || { a, b, pushed, c, d, e, midDip }; }, { spotify: true }],
  ['PREVIEW: phones get the new screen AT ONCE (no 120-ms wait) — Next up by run-out, ⏭, ⏭ on Next up, ⏮ back', async ({ p }) => {
    await p.evaluate(() => { window.__bc = []; window.__sl = []; const c = { connectionId: 'tcx', open: true, send(m){ if (m.t === 'state') window.__bc.push({ t: performance.now(), type: m.type, rem: m.remaining }); } };
      phones.conns.set('tcx', { c, name: 'Ann' });
      const o = clock.handleSlideChange.bind(clock); clock.handleSlideChange = () => { const t = performance.now(); o(); window.__sl.push({ t, type: presentation.slides[presentation.current].dataset.type || '' }); }; });
    const R = [];
    const step = async (name, fn) => { const n0 = await p.evaluate(() => window.__sl.length); await fn(); await wait(900);
      const r = await p.evaluate(n0 => { const s = window.__sl[n0]; if (!s) return null; const b = window.__bc.find(x => x.t >= s.t && x.type === (s.type || x.type)); return { type: s.type, ms: b ? Math.round(b.t - s.t) : null, rem: b ? b.rem : null }; }, n0);
      R.push({ name, ...r }); };
    await p.click('#startBtn'); await wait(900);
    await step('run-out', () => expireNow(p).then(() => wait(300)));
    await step('Next up ends', () => p.evaluate(() => { clock.deadline = performance.now() + 100; }).then(() => wait(300)));
    await step('⏭', () => p.click('#nextBtn'));
    await step('⏭ on Next up', () => p.click('#nextBtn'));
    await step('⏮ from a level', () => p.click('#prevBtn'));
    await step('⏭ again', () => p.click('#nextBtn'));
    await step('⏮ on Next up', () => p.click('#prevBtn'));
    const want = ['transition', 'level', 'transition', 'level', 'level', 'transition', 'level'];
    return (R.length === 7 && R.every((r, i) => r && r.type === want[i] && r.ms !== null && r.ms <= 50) && R.filter(r => r.type === 'transition').every(r => r.rem > 4500)) || R; }],
  ['PREVIEW: Status block — after a level change it says "Last beep: <time>, dip pause, session playback, clock thought Spotify playing (poll n s old), pause to play n s, play reply 204"', async ({ p }) => {
    await wait(1500); await p.click('#startBtn'); await wait(SETTLE); await p.click('#nextBtn'); await wait(3500);
    await p.click('#phonesBtn'); await wait(400); await p.click('#phDiagToggle'); await wait(1300);
    const L = (await p.evaluate(() => document.getElementById('phDiag').textContent)).split('\n');
    return (L.length === 8 && /^Last beep: \d\d:\d\d:\d\d, dip pause, session playback, clock thought Spotify playing \(poll \d+ s old\), pause to play [12]\.\d s, play reply 204$/.test(L[6])
      && /^Last pause: \d\d:\d\d:\d\d, music paused \(answer \d+ ms\), 1 sound, [12]\.\d s, plain play 204, confirmed playing$/.test(L[5])) || L; }, { spotify: true }],
  ['PREVIEW: Spotify not connected → phones state says now: null', async ({ p }) => {
    const r = await p.evaluate(() => phones.snapshot().now); return r === null || { r }; }],
  ...[2800, 3500].map(ms => ['PREVIEW: slow pause answer (' + ms + ' ms) → the sound starts after 1.5 s anyway; "play" goes out at once after the later of the pause answer and the sound\'s end, never before either', async ({ p, log, fake }) => {
    await wait(1200); fake.pauseDelay = ms; log.length = 0; emoji(p, '👏'); await wait(ms + 2500);
    const d = dips(log), st = stretches(d), ends = await p.evaluate(() => window.__ends.map(x => x.t)), s = await p.evaluate(() => window.__sfx.map(x => x.t));
    const after = d.length === 2 && ends.length === 1 ? Math.max(d[0].done, ends[0]) : null;
    return (d.map(x => x.c).join() === 'pause,play' && after && d[1].t >= after && d[1].t - after <= 400 && s.length === 1 && s[0] - d[0].t < 2000 && fake.playing) || { d, st, ends, s }; }, { spotify: true }]),
  ['PREVIEW: the 22 Nov rule — 👏 alone, 🔥 ×20 @1 s, 40 mixed (random 0-0.6 s apart): every pause ≤ 10 s + the longest sound, no "play" while a sound sounds, ≥ 2 s of music between pauses, music ends playing (replaces the 2850-ms cap-margin check)', async ({ p, log, fake }) => {
    const out = {};
    for (const [k, go] of [['clap', () => emoji(p, '👏')], ['fire20', () => burst(p, Array(20).fill('🔥'), 1000)], ['mixed40', () => p.evaluate(SEED40)]]){
      await p.evaluate(() => { window.__sfx.length = 0; window.__ends.length = 0; });
      await wait(2500); log.length = 0; await go(); await wait(k === 'clap' ? 1000 : k === 'fire20' ? 19500 : 12000); await settled(p, log); await wait(300);
      const d = dips(log); out[k] = { rule: await rule(p, d), clean: clean(d), end: d.length && d[d.length - 1].c }; }
    return (Object.values(out).every(x => x.rule.pauses.length >= 1 && x.rule.ok && x.clean && x.end === 'play') && fake.playing) || JSON.stringify(out).slice(0, 1500); }, { spotify: true }],
  ['PREVIEW: slow "play" (answers after 2 s) + all 8 ×2 @250 ms → every sound starts within 300 ms of being fired', async ({ p, log, fake }) => {
    await wait(1200); fake.playDelay = 2000; log.length = 0; const a = ['😂', '🔥', '🤡', '💀', '👏', '😭', '🤯', '💰'];
    await fired(p, a.concat(a), 250); await wait(9000);
    const r = await startLate(p), d = dips(log);
    return (r.n === 16 && r.fired === 16 && r.worst <= 300 && clean(d) && fake.playing) || { r, d: d.map(x => x.c) }; }, { spotify: true }],
  ...[[10, 300], [30, 400]].map(([k, every]) => ['PREVIEW: burst 🤡 ×' + k + ' @' + every + ' ms → ' + (k === 10 ? 'ONE pause, ONE play after the last sound' : 'the pause stops at 10 s, music back, ≥ 2 s of music, then the rest in a new pause') + ' (replaces the 2850-ms burst check)', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; await burst(p, Array(k).fill('🤡'), every); await wait(k * every + 2000); await settled(p, log); await wait(300);
    const d = dips(log), rr = await rule(p, d), r = await p.evaluate(() => ({ n: window.__sfx.length, skipped: emojiSfx.log.filter(x => x.err === 'skipped').length, ends: window.__ends.length }));
    const ok = k === 10 ? d.map(x => x.c).join() === 'pause,play' && r.n === 10 : d.filter(x => x.c === 'pause').length === 2 && r.n + r.skipped >= 28 && r.n >= 22;
    return (ok && rr.ok && clean(d) && fake.playing && r.ends === r.n) || { d: d.map(x => x.c + '@' + (x.t - d[0].t)), rr, r }; }, { spotify: true }]),
  ['PREVIEW: resume retry spacing — no answer, then 500 → tries again 0.5 s apart → music back by ~1.2 s', async ({ p, log, fake }) => {
    await wait(1200); fake.playFails = ['abort', 500]; log.length = 0; emoji(p, '🤡'); await wait(4000);
    const pl = log.filter(e => e.c === 'PUT /me/player/play'), g = pl.slice(1).map((e, i) => e.t - pl[i].done);
    const r = await p.evaluate(() => spotify.now && spotify.now.playing);
    return (pl.length === 3 && g.every(x => x >= 400 && x <= 700) && fake.playing && r === true) || { g, n: pl.length, r }; }, { spotify: true }],
  ['PREVIEW: the limits in one place — musicDip.CAP 10 s, MUSIC_MIN 2 s, QMAX 6 waiting, 4 players per sound, pause answer waited for max 1.5 s, PLAYS_MAX 9 (replaces the MAX / SAFE / LONG constants check)', async ({ p }) => {
    const r = await p.evaluate(() => ({ CAP: musicDip.CAP, MIN: musicDip.MUSIC_MIN, Q: musicDip.QMAX, PER: emojiSfx.PER, PW: musicDip.PAUSE_WAIT, PM: musicDip.PLAYS_MAX, old: ['MAX', 'SAFE', 'LONG', 'GAP', 'hardEnd', 'begin', 'join'].filter(k => k in musicDip) }));
    return (r.CAP === 10000 && r.MIN === 2000 && r.Q === 6 && r.PER === 4 && r.PW === 1500 && r.PM === 9 && r.old.length === 0) || r; }],
  ['PREVIEW: the 10-s cap — 🔥 every 2 s keeps the pause going: 💰 fired 9.6 s after the pause was answered still plays; 🤡 fired 10.4 s after waits, the music comes back after the last sound, ≥ 2 s of music, then 🤡 in a new pause (replaces the 2780-ms hard-timer check)', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0;
    await p.evaluate(() => { window.__fired = {}; emojiSfx.play('🔥'); const t = setInterval(() => { if (musicDip.state === 'open' && musicDip.acceptedAt){ clearInterval(t); const a0 = musicDip.acceptedAt;
      [2000, 4000, 6000, 8000].forEach(ms => setTimeout(() => emojiSfx.play('🔥'), a0 + ms - Date.now()));
      setTimeout(() => { window.__fired.money = Date.now(); emojiSfx.play('💰'); }, a0 + 9600 - Date.now()); setTimeout(() => { window.__fired.clown = Date.now(); emojiSfx.play('🤡'); }, a0 + 10400 - Date.now()); } }, 5); });
    await wait(13000); await settled(p, log); await wait(300);
    const d = dips(log), rr = await rule(p, d), r = await p.evaluate(() => ({ f: window.__fired, money: window.__sfx.filter(x => x.n === 'show-me-the-money.m4a').map(x => x.t), clown: window.__sfx.filter(x => x.n === 'bruh.m4a').map(x => x.t), ends: window.__ends.map(x => x.n + '@' + x.t) }));
    const play1 = d.find(x => x.c === 'play');
    return (d.map(x => x.c).join() === 'pause,play,pause,play' && r.money.length === 1 && r.money[0] - r.f.money < 400 && r.clown.length === 1 && play1 && r.clown[0] >= play1.done + 1950 && rr.ok && clean(d) && fake.playing) || { d: d.map(x => x.c + '@' + (x.t - d[0].t)), rr, r }; }, { spotify: true }],
  ['PREVIEW: one way of playing — 🔥, 💀 and the level beep all start with the session "playback"; it is "ambient" only when nothing sounds, never changed while a sound sounds (replaces "a sound longer than 2.7 s sends NO pause")', async ({ p, log, fake }) => {
    await wait(1200); await p.evaluate(() => { window.__ss = []; const AS = navigator.audioSession; if (!AS) return; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(AS), 'type') || {};
      let cur = AS.type; try { Object.defineProperty(AS, 'type', { configurable: true, get(){ return d.get ? d.get.call(AS) : cur; }, set(v){ if (d.set) d.set.call(AS, v); cur = v; window.__ss.push({ v, t: Date.now() }); } }); } catch (e) {}
      const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function(){ if (!this.muted) (window.__ss_starts = window.__ss_starts || []).push({ s: navigator.audioSession.type, t: Date.now() }); return o.apply(this, arguments); }; });
    log.length = 0; emoji(p, '🔥'); await wait(400); emoji(p, '💀'); await wait(300); p.evaluate(() => window.levelAlert()); await wait(6000); await settled(p, log); await wait(300);
    const r = await p.evaluate(() => ({ has: !!navigator.audioSession, ss: window.__ss, starts: window.__ss_starts || [], s: window.__sfx.map(x => x.t), e: window.__ends.map(x => x.t), now: navigator.audioSession && navigator.audioSession.type }));
    if (!r.has) return true;   /* Chrome: no navigator.audioSession — nothing to check */
    const first = Math.min(...r.starts.map(x => x.t)), last = Math.max(...r.e), during = r.ss.filter(x => x.t > first + 2 && x.t < last - 2);
    return (r.starts.length === 3 && r.starts.every(x => x.s === 'playback') && during.length === 0 && r.now === 'ambient' && dips(log).map(x => x.c).join() === 'pause,play' && fake.playing) || r; }, { spotify: true }],
  ['PREVIEW: the same emoji 4 times 350 ms apart → 4 players overlap, none cut; a 5th waits for a free player and plays in full; one pause, one play after the last (replaces "a long sound plays over a pause dip")', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; for (let i = 0; i < 4; i++){ emoji(p, '🔥'); await wait(350); } emoji(p, '🔥'); await wait(9000); await settled(p, log); await wait(300);
    const r = await p.evaluate(() => { const s = window.__sfx.filter(x => x.n === 'wow.m4a'), e = window.__ends.filter(x => x.n === 'wow.m4a');
      return s.map(x => { const y = e.find(z => z.i === x.i && z.t > x.t + 30); return { i: x.i, t: x.t, ms: y ? y.t - x.t : null }; }); });
    const d = dips(log), ids = new Set(r.slice(0, 4).map(x => x.i));
    return (r.length === 5 && ids.size === 4 && r.every(x => x.ms !== null && x.ms >= 2400) && r[4].t >= Math.min(...r.slice(0, 4).map(x => x.t + x.ms)) - 30 && d.map(x => x.c).join() === 'pause,play' && fake.playing) || { r, d }; }, { spotify: true }],
  ['PREVIEW: 🔥 again 1.4 s later joins the SAME pause — both play in full, one pause, the play only after the 2nd ended (replaces "plays AT ONCE over the music")', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; emoji(p, '🔥'); await wait(1400); const t1 = await p.evaluate(() => Date.now()); emoji(p, '🔥'); await wait(5500);
    const d = dips(log), s = await p.evaluate(() => window.__sfx.filter(x => x.n === 'wow.m4a').map(x => x.t)), e = await p.evaluate(() => window.__ends.filter(x => x.n === 'wow.m4a').map(x => x.t)), late = s[1] ? s[1] - t1 : null;
    return (s.length === 2 && e.length === 2 && late !== null && late < 400 && d.map(x => x.c).join() === 'pause,play' && d[1].t >= Math.max(...e) && fake.playing) || { s, e, late, d }; }, { spotify: true }],
  ...[['the same emoji 10× (300 ms apart)', () => Array(10).fill('🤡'), 300, 7], ['10 different emojis (250 ms apart, long ones too)', () => ['🔥', '👏', '💀', '😂', '🤡', '🤯', '💰', '😭', '🔥', '👏'], 250, 10]].map(([what, list, every, min]) =>
    ['PREVIEW: burst — ' + what + ': every sound plays in full in one pause, no "play" while one sounds, music ends playing (replaces the 2850-ms stretch check)', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; await burst(p, list(), every); await wait(3000); await settled(p, log); await wait(500);
    const d = dips(log), rr = await rule(p, d), r = await p.evaluate(() => ({ n: window.__sfx.length, full: window.__sfx.filter(x => { const e = window.__ends.find(y => y.i === x.i && y.t > x.t + 30); return e && e.t - x.t >= SFX_MS[x.n.replace('.m4a', '')] * 0.85; }).length }));
    return (rr.ok && clean(d) && d.map(x => x.c).join() === 'pause,play' && fake.playing && r.n >= min && r.full === r.n) || { rr, d: d.map(x => x.c + '@' + x.t), r }; }, { spotify: true }]),
  ['PREVIEW: more than 6 waiting → the OLDEST waiting emoji is skipped, its phone gets "skipped" (the newest ones play); the emoji still flies', async ({ p, log, fake }) => {
    await wait(1200); await p.evaluate(() => { musicDip.CAP = 800; });   /* a short cap so the next ones must wait */
    const r = await p.evaluate(async () => { const names = ['Ann', 'Bob', 'Cat'], C = []; const mk = (k) => ({ connectionId: 'sk' + k, open: true, sent: [], send(m){ this.sent.push(m); } });
      for (let k = 0; k < 10; k++){ const c = mk(k); C.push(c); phones.conns.set(c.connectionId, { c, name: null }); }
      phones.onData(C[0], { t: 'emoji', e: '🔥', name: 'Ann', id: 'k0' }); await new Promise(r => setTimeout(r, 1200));   /* the cap passed: the next 9 wait */
      for (let k = 1; k < 10; k++){ phones.lastEmoji.clear(); phones.onData(C[k], { t: 'emoji', e: ['💀', '🤡', '😂', '👏', '🤯', '💰', '📖', '❓', '💣'][k - 1], name: names[k % 3], id: 'k' + k }); }
      await new Promise(r => setTimeout(r, 30)); const q = musicDip.waiting.length; await new Promise(r => setTimeout(r, 170));
      return { q, sent: C.map(c => c.sent.filter(m => m.t === 'ack' || m.t === 'skipped').map(m => m.t + (m.ok === false ? ':no' : ''))), fly: document.querySelectorAll('#emojiLayer .emoji-fly').length }; });
    await wait(9000); await settled(p, log); await wait(300);
    const sk = r.sent.map((x, k) => x.includes('skipped') ? k : -1).filter(k => k >= 0), d = dips(log), n = await p.evaluate(() => window.__sfx.length);
    return (r.q === 6 && JSON.stringify(sk) === '[1,2,3]' && r.sent.every(x => x[0] === 'ack') && r.fly === 10 && n === 7 && fake.playing && (await rule(p, d)).ok) || { r, sk, n, d: d.map(x => x.c) }; }, { spotify: true }],
  ['PREVIEW: resume gets 404 (plain + device_id) → transfer playback (play: true) ~1 s later → music back, card shows Now playing (replaces "ONE more plain try")', async ({ p, log, fake }) => {
    await wait(1200); fake.playFails = [404, 404]; log.length = 0; emoji(p, '🤡'); await wait(6000);
    const pl = log.filter(e => e.c === 'PUT /me/player/play' || e.c === 'PUT /me/player'), gap = pl.length >= 3 ? pl[2].t - pl[1].done : null;
    const r = await p.evaluate(() => ({ playing: spotify.now && spotify.now.playing, k: document.getElementById('npK').textContent }));
    return (pl.length === 3 && pl[0].c.endsWith('/play') && !pl[0].u.includes('device_id') && pl[1].u.includes('device_id=ipad') && pl[2].c === 'PUT /me/player' && gap >= 900 && gap <= 1500
      && fake.playing && r.playing === true && r.k === 'Now playing') || { calls: pl.map(e => e.u + '@' + e.t), gap, r, playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW: resume refused every time (404) → plain play, play with device_id, transfer playback (3 calls, ≤ PLAYS_MAX 9), then the card shows Paused (replaces the 5-play 404 ladder)', async ({ p, log, fake }) => {
    await wait(1200); fake.playFailAll = 404; log.length = 0; emoji(p, '🤡'); await wait(6000);
    const pl = log.filter(e => e.c === 'PUT /me/player/play' || e.c === 'PUT /me/player'), r = await p.evaluate(() => ({ playing: spotify.now && spotify.now.playing, k: document.getElementById('npK').textContent, max: musicDip.PLAYS_MAX }));
    return (pl.length === 3 && pl[1].u.includes('device_id') && pl[2].c === 'PUT /me/player' && r.max === 9 && r.playing === false && r.k !== 'Now playing') || { calls: pl.map(e => e.u), r }; }, { spotify: true }],
  ['PREVIEW: "play" answered 204 but Spotify did not start (state read 1 s later says paused) → play with device_id → music back', async ({ p, log, fake }) => {
    await wait(1200); fake.ignorePlay = 1; log.length = 0; emoji(p, '🤡'); await wait(5000);
    const pl = log.filter(e => e.c === 'PUT /me/player/play' || e.c === 'PUT /me/player'), reads = log.filter(e => e.u.startsWith('/me/player?'));
    return (pl.length === 2 && pl[1].u.includes('device_id') && pl[1].t - pl[0].done >= 950 && fake.playing) || { calls: pl.map(e => e.u + '@' + e.t), playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW: Spotify disconnected in Settings → emoji and level beep play in full, no Spotify calls (like no Spotify at all)', async ({ p, log }) => {
    await wait(1200); await p.evaluate(() => spotify.disconnect()); log.length = 0;
    await emoji(p, '🤡'); await wait(300); await p.evaluate(() => window.levelAlert()); await wait(3000);
    const r = await p.evaluate(() => ({ sfx: window.__sfx.map(x => x.n), ends: window.__ends.map(x => x.n), beeps: window.__sounds, hint: getComputedStyle(document.getElementById('sndHint')).display }));
    return (dips(log).length === 0 && r.sfx.length === 1 && r.ends.length === 1 && r.beeps === 1 && r.hint === 'none') || r; }, { spotify: true }],
  ['PREVIEW fix 1: Spotify login lost while it plays → emoji: no sound, no pause; the LEVEL BEEP still sounds (no pause); the clock says why and that the music may need ▶ (replaces "login lost → no sound and no beep")', async ({ p, log, fake }) => {
    await wait(1200); await p.context().route('https://accounts.spotify.com/api/token', r => r.fulfill({ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"invalid_grant"}' }));
    await p.evaluate(() => { spotify.auth.exp = 0; }); log.length = 0; await emoji(p, '🔥'); await wait(1500); await p.evaluate(() => window.levelAlert()); await wait(3000);
    const r = await p.evaluate(() => ({ sfx: window.__sfx.length, beeps: window.__sounds, ends: window.__ends.length, hint: document.getElementById('sndHint').textContent, shown: getComputedStyle(document.getElementById('sndHint')).display !== 'none' }));
    return (dips(log).length === 0 && r.sfx === 0 && r.beeps === 1 && r.shown && /press play in the Spotify app/.test(r.hint) && /Reconnect/.test(r.hint)) || r; }, { spotify: true }],
  ['PREVIEW fix 1: no Premium while Spotify shows playing → the level beep still sounds (no pause, no Spotify call), emoji sounds stay off with a line on the clock', async ({ p, log }) => {
    await wait(1200); await p.evaluate(() => { spotify.premium = false; }); log.length = 0; await emoji(p, '🔥'); await wait(800);
    const h1 = await p.evaluate(() => document.getElementById('sndHint').textContent); await p.evaluate(() => window.levelAlert()); await wait(3000);
    const r = await p.evaluate(() => ({ sfx: window.__sfx.length, beeps: window.__sounds }));
    return (dips(log).length === 0 && r.sfx === 0 && r.beeps === 1 && /needs Premium/.test(h1)) || { r, h1 }; }, { spotify: true }],
  ['PREVIEW fix 2: a pause refused with 403 (answered after 2 s; the read said playing) → NO play afterwards, ever', async ({ p, log, fake }) => {
    await wait(1200); fake.playing = false; fake.readLie = true; fake.pauseDelay = 2000; log.length = 0; emoji(p, '🤡'); await wait(6000);
    const d = dips(log);
    return (d.map(x => x.c).join() === 'pause' && fake.playing === false) || { d: d.map(x => x.c), playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW fix 3: the user had paused, the clock still showed playing, the pause would get 500 → the fresh read before it sees paused: no pause, no play, music stays paused', async ({ p, log, fake }) => {
    await wait(1200); fake.playing = false; await p.context().route('https://api.spotify.com/v1/me/player/pause', r => { log.push({ c: 'PUT /me/player/pause', t: Date.now(), done: Date.now() }); return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"status":500}}' }); });
    log.length = 0; emoji(p, '🤡'); await wait(4000);
    const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length);
    return (d.length === 0 && fake.playing === false && sfx === 1) || { d: d.map(x => x.c), playing: fake.playing, sfx }; }, { spotify: true }],
  ['PREVIEW fix 3: pause answered 500 (carried out) when the fresh read just before said playing → maybe paused: play at the end, music back', async ({ p, log, fake }) => {
    await wait(1200); await p.context().route('https://api.spotify.com/v1/me/player/pause', r => { fake.playing = false; log.push({ c: 'PUT /me/player/pause', t: Date.now(), done: Date.now() }); return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"status":500}}' }); });
    log.length = 0; emoji(p, '🤡'); await wait(4500);
    const d = dips(log);
    return (d.map(x => x.c).join() === 'pause,play' && fake.playing === true) || { d: d.map(x => x.c), playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW fix 4: the user pauses in Spotify 300 ms after the clock\'s play → the confirm read sees the track moved on and paused: ONE play only, music left paused', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; emoji(p, '🤡'); await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000);
    fake.onPlay = () => setTimeout(() => { fake.playing = false; }, 300); await wait(5000);
    const pl = log.filter(e => e.c === 'PUT /me/player/play' || e.c === 'PUT /me/player'), last = await p.evaluate(() => musicDip.lastWin && musicDip.lastWin.back);
    return (pl.length === 1 && fake.playing === false && /paused in Spotify/.test(last || '')) || { pl: pl.map(e => e.u), playing: fake.playing, last }; }, { spotify: true }],
  ['PREVIEW fix 5: the tap unlocks only the beep (every emoji player refused) → "Tap the screen once" stays, 🔥 pauses NOTHING and plays nothing; the next tap unlocks the rest and 🔥 plays with a pause', async ({ p, log, fake }) => {
    await wait(1200); await p.evaluate(() => { const o = HTMLMediaElement.prototype.play; window.__ref = true; HTMLMediaElement.prototype.play = function(){ if (window.__ref && this.muted && this.src.includes('/sounds/')) return Promise.reject(new DOMException('no', 'NotAllowedError')); return o.apply(this, arguments); }; window.dispatchEvent(new PointerEvent('pointerdown')); });
    await wait(1500); const a = await p.evaluate(() => ({ beep: sound.unlocked, n: emojiSfx.unlockedCount, hint: getComputedStyle(document.getElementById('sndHint')).display !== 'none' || null }));
    log.length = 0; await emoji(p, '🔥'); await wait(1500); const d0 = dips(log).length, s0 = await p.evaluate(() => window.__sfx.length), h0 = await p.evaluate(() => getComputedStyle(document.getElementById('sndHint')).display !== 'none');
    await p.evaluate(() => { window.__ref = false; window.dispatchEvent(new PointerEvent('pointerdown')); }); await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total), 8000); await settle(p);
    const gone = await p.evaluate(() => getComputedStyle(document.getElementById('sndHint')).display === 'none'); await emoji(p, '🔥'); await wait(3800);
    const d = dips(log), s1 = await p.evaluate(() => window.__sfx.length);
    return (a.beep === true && a.n === 1 && d0 === 0 && s0 === 0 && h0 && gone && d.map(x => x.c).join() === 'pause,play' && s1 === 1) || { a, d0, s0, h0, gone, d: d.map(x => x.c), s1 }; }, { spotify: true, noTap: true }],
  ['PREVIEW fix 6: a pause whose answer never comes → "no answer" after 3 s, the sound plays, music back ≤ 12.7 s after the pause, "Last pause" shows the real time pause → music back', async ({ p, log, fake }) => {
    await wait(1200); fake.pauseDelay = 60000; log.length = 0; emoji(p, '🔥'); await wait(9000);
    const d = dips(log), pl = d.find(x => x.c === 'play'), w = await p.evaluate(() => musicDip.lastWin && { ms: musicDip.lastWin.pausedMs, how: musicDip.lastWin.how }), sfx = await p.evaluate(() => window.__sfx.length);
    const real = pl && pl.done ? pl.done - d[0].t : null;
    return (pl && pl.t - d[0].t <= 12700 && fake.playing && sfx === 1 && w && real != null && Math.abs(w.ms - real) <= 400) || { d: d.map(x => x.c + '@' + (x.t - d[0].t)), w, real, sfx, playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW fix 7: the login is refused while the music is paused (play 401, refresh 400) → never a silent stop: the clock says the music is paused and to press play in Spotify, plus Reconnect', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; emoji(p, '🔥'); await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000);
    await p.context().route('https://accounts.spotify.com/api/token', r => r.fulfill({ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"invalid_grant"}' }));
    await p.context().route('https://api.spotify.com/v1/me/player/play', r => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"status":401,"message":"expired"}}' }));
    await wait(6000);
    const r = await p.evaluate(() => { const h = document.getElementById('sndHint'); return { shown: getComputedStyle(h).display !== 'none', text: h.textContent, back: musicDip.lastWin && musicDip.lastWin.back }; });
    return (r.shown && /The music is paused: press play in the Spotify app/.test(r.text) && /Reconnect/.test(r.text)) || r; }, { spotify: true }],
  ['PREVIEW fix round 2 (1): every sound file fails for 2.5 s, then works → a player in error is NOT reloaded by itself (no reload storm: few sound-file requests), the page never freezes, the next 🔥 plays in full, the music is back within the cap (replaces fix 8 "reloads spaced and limited")', async ({ p, log, fake }) => {
    await wait(1200); let fail = true, reqFail = 0, reqAll = 0; await p.context().route('**/*.m4a', r => { reqAll++; if (fail){ reqFail++; return r.fulfill({ status: 500, body: '' }); } return r.continue(); });
    await p.evaluate(() => { window.__loads = 0; const o = HTMLMediaElement.prototype.load; HTMLMediaElement.prototype.load = function(){ window.__loads++; return o.apply(this, arguments); }; emojiSfx.all().forEach(a => { try { a.load(); } catch (e) {} }); });
    await wait(2500); const errd = await p.evaluate(() => emojiSfx.all().filter(a => a.error).length), loads = await p.evaluate(() => window.__loads), nFail = reqFail; fail = false;
    log.length = 0; const tE = Date.now(); emoji(p, '🔥'); await wait(8000);
    /* stalls counted from the emoji on (the defect froze the page right after its play(); the 48 loads the check itself forces make headless WebKit stall ~3 s, on 0b65220 too) */
    const d = dips(log), pl = d.find(x => x.c === 'play'), r = await p.evaluate(tE => ({ stalls: (window.__stalls || []).filter(([a, b]) => b > tE && b - a > 3000).length, allStalls: (window.__stalls || []).filter(([a, b]) => b - a > 3000).map(([a, b]) => [a - tE, b - a]), busy: musicDip.busy(), loads: window.__loads,
      wow: window.__sfx.filter(x => x.n === 'wow.m4a').map(x => { const e = window.__ends.find(y => y.i === x.i && y.t > x.t + 30); return e ? e.t - x.t : null; }), len: SFX_MS.wow }), tE);
    const full = r.wow.some(ms => ms != null && ms >= r.len * 0.9);
    /* the 48 forced loads make 48 (+ range) requests; the defect added up to 3 reloads per player on top (≥ 140 requests in 2.5 s) */
    console.log('        [fix round 2 (1)] ' + (P ? 'preview' : 'root') + ': sound-file requests while failing ' + nFail + ', load() calls while failing ' + loads + ' (48 forced), players in error ' + errd + ', requests in all ' + reqAll);
    return (errd > 0 && nFail > 0 && nFail <= 72 && loads <= 52 && r.stalls === 0 && !r.busy && pl && pl.t - d[0].t <= 12700 && fake.playing && full) || { nFail, loads, errd, reqAll, r, d: d.map(x => x.c), playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW fix round 2 (2): somebody uses Spotify during the clock\'s pause (play, then pause 250 ms later, in the app) → the clock sends NO play and leaves it paused; the normal pause (track not moved) still resumes', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; emoji(p, '🔥'); await settled(p, log); const n1 = dips(log).map(x => x.c).join(), p1 = fake.playing;
    await until(() => p.evaluate(() => !musicDip.busy() && musicDip.state === 'idle'), 6000); await wait(500);
    const k = log.length; emoji(p, '🔥'); const rec = await until(() => p.evaluate(() => musicDip.state === 'open' && musicDip.pausedPos != null), 4000);
    await wait(300); fake.playing = true; await wait(250); fake.playing = false; await wait(9000);
    const d2 = dips(log.slice(k)).map(x => x.c).join(), back = await p.evaluate(() => musicDip.lastWin && musicDip.lastWin.back);
    return (n1 === 'pause,play' && p1 && rec && d2 === 'pause' && fake.playing === false && /used in Spotify/.test(back || '')) || { n1, p1, rec, d2, playing: fake.playing, back }; }, { spotify: true }],
  ['PREVIEW 9a: mute mid-pause and "Emoji sounds" switched off mid-burst → sounds stop, no session change while one sounds, music back each time', async ({ p, log, fake }) => {
    await wait(1200); await p.evaluate(() => { window.__ss = []; const AS = navigator.audioSession; if (!AS) return; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(AS), 'type') || {}; let cur = AS.type;
      Object.defineProperty(AS, 'type', { configurable: true, get(){ return d.get ? d.get.call(AS) : cur; }, set(v){ if (d.set) d.set.call(AS, v); cur = v; window.__ss.push({ v, t: Date.now(), sounding: emojiSfx.all().concat([sound.audio]).filter(a => !a.paused && !a.muted).length }); } }); });
    log.length = 0; emoji(p, '🔥'); await wait(300); emoji(p, '💀'); await wait(700); await p.evaluate(() => sound.toggleMute()); await wait(2500); await p.evaluate(() => sound.toggleMute()); await wait(2500);
    const back1 = fake.playing; await burst(p, ['😂', '🔥', '💀', '👏', '🤡'], 200); await wait(700);
    await p.evaluate(() => { const es = document.getElementById('phEmojiSounds'); es.checked = false; es.dispatchEvent(new Event('change')); }); await wait(3000);
    const r = await p.evaluate(() => ({ ss: window.__ss, has: !!navigator.audioSession, sounding: emojiSfx.all().filter(a => !a.paused && !a.muted).length, busy: musicDip.busy() })), d = dips(log);
    return (back1 && fake.playing && r.sounding === 0 && !r.busy && r.ss.every(x => x.sounding === 0) && d.filter(x => x.c === 'pause').length === 2 && d[d.length - 1].c === 'play') || { back1, r, d: d.map(x => x.c), playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW 9b: the page hidden and shown again mid-pause → the sound finishes, music back, nothing stuck, the next emoji pauses and plays again', async ({ p, log, fake }) => {
    await wait(1200); log.length = 0; emoji(p, '🔥'); await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await wait(300);
    const vis = h => p.evaluate(h => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }, h);
    await vis(true); await wait(1500); await vis(false); await wait(4500);
    const st = await p.evaluate(() => ({ busy: musicDip.busy(), state: musicDip.state })), d1 = dips(log).map(x => x.c).join(), p1 = fake.playing;
    emoji(p, '🤡'); await wait(3500); const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length);
    return (d1 === 'pause,play' && p1 && !st.busy && d.map(x => x.c).join() === 'pause,play,pause,play' && fake.playing && sfx === 2) || { d1, p1, st, d: d.map(x => x.c), sfx }; }, { spotify: true }],
  ['PREVIEW: the PREVIEW tag shows on the clock (cover + level), small, covers no control, lets taps through', async ({ p }) => {
    const look = () => p.evaluate(() => { const t = document.getElementById('previewTag'); if (!t) return { none: true }; const r = t.getBoundingClientRect(), cs = getComputedStyle(t);
      const ctl = [...document.querySelectorAll('button, input, select, a, [data-sp], .np-card')].filter(b => { const q = b.getBoundingClientRect(); return q.width && q.height && getComputedStyle(b).visibility !== 'hidden'; })
        .filter(b => { const q = b.getBoundingClientRect(); return !(q.right <= r.left || q.left >= r.right || q.bottom <= r.top || q.top >= r.bottom); }).map(b => b.id || b.className);
      return { text: t.textContent, w: r.width, h: r.height, inView: r.left >= 0 && r.bottom <= innerHeight, vis: cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.5, pe: cs.pointerEvents, pos: cs.position, ctl }; });
    const a = await look(); await p.click('#startBtn'); await wait(900); const b = await look();
    const good = x => x.text === 'PREVIEW' && x.w > 30 && x.w < 140 && x.h < 30 && x.inView && x.vis && x.pe === 'none' && x.pos === 'fixed' && x.ctl.length === 0;
    return (good(a) && good(b)) || { a, b }; }],
  ['PREVIEW: the PREVIEW tag shows on the preview join.html (phone), covers nothing', async ({ p }) => {
    await p.setViewportSize({ width: 390, height: 844 }); await p.goto(PAGE.replace(/[^/]*$/, 'join.html?room=abcdef')); await wait(800);
    const r = await p.evaluate(() => { const t = document.getElementById('previewTag'); if (!t) return { none: true }; const q = t.getBoundingClientRect(), pill = document.getElementById('pill').getBoundingClientRect();
      const top = document.querySelector('.top').getBoundingClientRect(), gap = parseFloat(getComputedStyle(document.querySelector('.wrap')).rowGap) || 0;
      const c = [...document.querySelectorAll('.wrap > .card')].map(x => x.getBoundingClientRect()).filter(x => x.height > 0);   /* the next row starts at .top bottom + the gap */
      return { text: t.textContent, w: q.width, inView: q.top >= 0 && q.right <= innerWidth, pe: getComputedStyle(t).pointerEvents, hitsPill: !(pill.right <= q.left || pill.left >= q.right || pill.bottom <= q.top || pill.top >= q.bottom), hitsCard: q.bottom > top.bottom + gap || c.some(x => x.top < q.bottom) }; });
    return (r.text === 'PREVIEW' && r.w > 20 && r.inView && r.pe === 'none' && !r.hitsPill && !r.hitsCard) || r; }],
  ['PREVIEW: the phones QR / join link points into preview/ (preview/join.html?room=…)', async ({ p }) => {
    await p.click('#phonesBtn'); await wait(600);
    const r = await p.evaluate(() => ({ url: phones.joinUrl(), shown: document.getElementById('phUrl').textContent }));
    return (/\/preview\/join\.html\?room=[a-z0-9]{6}$/.test(r.url) && r.shown === r.url) || r; }],
  /* Sound check button in the 📱 panel (sound-check build, 22 Nov) */
  ['PREVIEW: Sound check plays ONE emoji sound with the music paused and the music comes back; then "Did you hear it?" with Yes and No', async ({ p, log, fake }) => {
    await p.click('#phonesBtn'); await wait(400);
    await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown'))); await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total), 15000); await settle(p);
    log.length = 0; const hid0 = await p.evaluate(() => document.getElementById('phScAsk').hidden);
    await p.click('#phSoundCheck');
    const ask = await until(() => p.evaluate(() => !document.getElementById('phScAsk').hidden), 20000);
    await settled(p, log);
    const d = dips(log), sfx = await p.evaluate(() => ({ n: window.__sfx.length, fly: document.querySelectorAll('.emoji-fly').length, q: document.getElementById('phScAsk').textContent.replace(/\s+/g, ' ').trim(),
      btns: [...document.querySelectorAll('#phScAsk button')].map(b => b.textContent) }));
    return (hid0 && ask && d.map(x => x.c).join() === 'pause,play' && sfx.n === 1 && sfx.fly === 0 && fake.playing && sfx.q === 'Did you hear it? Yes No' && sfx.btns.join() === 'Yes,No') || { hid0, ask, d, sfx, playing: fake.playing }; }, { spotify: true }],
  ['PREVIEW: Sound check: "Yes" shows "Sounds are working." and the question goes away; "No" shows the three lines', async ({ p }) => {
    await p.click('#phonesBtn'); await wait(400);
    await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown'))); await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total), 15000); await settle(p);
    const st = () => p.evaluate(() => ({ ask: !document.getElementById('phScAsk').hidden, msg: document.getElementById('phScMsg').hidden ? '' : document.getElementById('phScMsg').innerText.trim() }));
    await p.click('#phSoundCheck'); await until(() => p.evaluate(() => !document.getElementById('phScAsk').hidden), 20000);
    await p.click('#phScYes'); const y = await st();
    await p.click('#phSoundCheck'); await until(() => p.evaluate(() => !document.getElementById('phScAsk').hidden), 20000);
    const again = await st(); await p.click('#phScNo'); const n = await st();
    return (y.ask === false && y.msg === 'Sounds are working.' && again.ask && again.msg === '' && n.ask === false
      && n.msg === 'Turn the iPad volume up.\nTap the screen once, then try again.\nIf Emoji sounds is switched off above, switch it on.') || { y, again, n }; }, { spotify: true, noTap: true }],
  ['PREVIEW fix round 2 (3): Sound check with "Emoji sounds" switched off → nothing plays, no pause, NO "Did you hear it?"; one line says they are off and to switch them on', async ({ p, log, fake }) => {
    await p.click('#phonesBtn'); await wait(400);
    await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown'))); await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total), 15000); await settle(p);
    await p.evaluate(() => { const es = document.getElementById('phEmojiSounds'); es.checked = false; es.dispatchEvent(new Event('change')); }); await wait(500);
    log.length = 0; const s0 = await p.evaluate(() => window.__sfx.length); await p.click('#phSoundCheck'); await wait(6500);
    const r = await p.evaluate(() => ({ ask: !document.getElementById('phScAsk').hidden, msg: document.getElementById('phScMsg').hidden ? '' : document.getElementById('phScMsg').innerText.trim(), sfx: window.__sfx.length }));
    return (r.ask === false && r.msg === 'Emoji sounds are switched off. Switch them on above, then try again.' && r.sfx === s0 && dips(log).length === 0 && fake.playing) || { r, s0, d: dips(log).map(x => x.c) }; }, { spotify: true, noTap: true }],
  ['PREVIEW: Sound check as the FIRST tap (no other tap before): the tap itself unlocks and the sound is played, music paused and back', async ({ p, log, fake }) => {
    await wait(1200); await p.evaluate(() => document.getElementById('phonesBtn').click()); await wait(400); log.length = 0;   /* a JS click: no pointerdown, so no tap yet */
    const before = await p.evaluate(() => ({ n: emojiSfx.unlockedCount, sfx: window.__sfx.length }));
    await p.click('#phSoundCheck');
    const ask = await until(() => p.evaluate(() => !document.getElementById('phScAsk').hidden), 30000);
    await settled(p, log);
    const d = dips(log), r = await p.evaluate(() => ({ n: emojiSfx.unlockedCount, sfx: window.__sfx.filter(x => x.n === 'oh-my-god.m4a').length }));
    return (before.n === 0 && before.sfx === 0 && ask && r.n === 49 && r.sfx >= 1 && r.sfx <= 2 && d.map(x => x.c).join() === 'pause,play' && fake.playing) || { before, ask, r, d }; }, { spotify: true, noTap: true }],
  ['PREVIEW: SFX_MS of all twelve sounds = the real file length (ffprobe) within 30 ms', async ({ p }) => {
    /* ffprobe on the 22 Nov loud-v2 files: boomshakalaka 1190, bruh 647, cool-story-bro 1110, emotional-damage 2037, fah 1948, oh-my-god 1623,
       pay-that-man 1670, show-me-the-money 2060, very-nice 1075, what-happened 910, what 400, wow 2621 (read live below) */
    const tbl = await p.evaluate(() => ({ ...SFX_MS })), dir = require('path').resolve(__dirname, '..', 'preview', 'sounds');
    const probe = n => Math.round(1000 * +require('child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dir + '/' + n + '.m4a']).toString().trim());
    const bad = Object.entries(tbl).filter(([n, ms]) => !(Math.abs(probe(n) - ms) <= 30)).map(([n, ms]) => [n, ms, probe(n)]);
    return (Object.keys(tbl).length === 12 && bad.length === 0) || { bad }; }],
  /* end-pages items 1-2: Heads up button, the game carries on under the Heads up page, chips, auto-pick, Winner button, bar layout */
  ['PREVIEW: Heads up button — in the bottom bar right after 📱 Phones, labelled "Heads up"; one tap on Level 1 shows the Heads up page ON TOP while Level 1 keeps its time (not reset, still running); a 2nd tap or Clock → back on Level 1 with the time still running; it also opens from the Next up screen', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.evaluate(() => { clock.deadline -= 5 * 60 * 1000; }); await wait(200);
    const btn = await p.evaluate(() => { const b = document.getElementById('headsUpBtn'); return b ? { prev: (b.previousElementSibling || {}).id, inBar: !!b.closest('#fontScaleCtrl'), label: b.getAttribute('aria-label'), title: b.title, fs: b.classList.contains('fs-btn'), ico: !!b.querySelector('svg') } : null; });
    const a = await state(p); await HU.open(p); const onTop = await HU.top(p), b = await state(p);
    await wait(2200); const c = await state(p);
    await p.click('#headsUpBtn', { timeout: 2000 }); await wait(600); const off1 = !(await HU.top(p)), d = await state(p);
    await HU.open(p); const on2 = await HU.top(p); await p.click('#huBack', { timeout: 2000 }); await wait(600); const off2 = !(await HU.top(p)), e = await state(p);
    await press(p, '#nextBtn'); await HU.open(p); const t = await state(p), onTop3 = await HU.top(p), v = await HU.view(p);
    return (btn && btn.prev === 'phonesBtn' && btn.inBar && btn.label === 'Heads up' && btn.title === 'Heads up' && btn.fs && btn.ico
      && onTop && b.type === 'level' && b.level === 'Level 1' && b.left <= a.left && b.left >= a.left - 2 && b.left <= b.full - 290
      && c.left <= b.left - 1 && c.left >= b.left - 3 && !c.paused
      && off1 && d.type === 'level' && d.level === 'Level 1' && d.left <= c.left && d.left >= c.left - 2
      && on2 && off2 && e.type === 'level' && e.level === 'Level 1' && e.left <= d.left && e.left >= d.left - 3
      && t.type === 'transition' && onTop3 && v.level === 'Next up · Level 2') || { btn, a, b, c, d, e, t, onTop, off1, on2, off2, onTop3, v }; }],
  ['PREVIEW: Heads up page shows the running level live — "Level 1 of 3", the time left ticking down (same as the clock, not reset), Blinds 1 / 2, Next 2 / 4', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.evaluate(() => { clock.deadline -= 3 * 60 * 1000; }); await HU.open(p);
    const v1 = await HU.view(p), s1 = await state(p); await wait(2300); const v2 = await HU.view(p), s2 = await state(p);
    const t1 = HU.secs(v1.timer), t2 = HU.secs(v2.timer);
    return (v1.level === 'Level 1 of 3' && t1 !== null && Math.abs(t1 - s1.left) <= 1 && t1 <= 17 * 60 + 1 && t2 <= t1 - 2 && t2 >= t1 - 3 && Math.abs(t2 - s2.left) <= 1
      && v1.blinds === 'Blinds 1 / 2' && v1.next === 'Next 2 / 4') || { v1, v2, s1, s2 }; }],
  ['PREVIEW: Heads up — the level runs out while the page shows: ONE beep, the 5-s Next up, then Level 2 at full time; the page STAYS on top and shows Next up, then Level 2\'s blinds and time; the phones\' state says Next up, then Level 2', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.open(p); await expireNow(p); await wait(900);
    const t = await state(p), tv = await HU.view(p), tTop = await HU.top(p), ts = await p.evaluate(() => phones.snapshot());
    await wait(5600);
    const l = await state(p), lv = await HU.view(p), lTop = await HU.top(p), ls = await p.evaluate(() => phones.snapshot());
    return (t.type === 'transition' && t.level === 'Level 2' && t.alerts === 1 && tTop && tv.level === 'Next up · Level 2' && tv.blinds === 'Blinds 2 / 4' && ts.type === 'transition'
      && l.type === 'level' && l.level === 'Level 2' && l.left >= l.full - 2 && l.alerts === 1 && lTop && lv.level === 'Level 2 of 3' && lv.blinds === 'Blinds 2 / 4' && lv.next === 'Next 5 / 10'
      && HU.secs(lv.timer) >= l.full - 2 && ls.type === 'level' && ls.levelNo === 2 && ls.sb === 2 && ls.bb === 4 && ls.remaining > (l.full - 3) * 1000) || { t, tv, tTop, ts: { type: ts.type, levelNo: ts.levelNo }, l, lv, lTop, ls: { type: ls.type, levelNo: ls.levelNo, sb: ls.sb, bb: ls.bb, remaining: ls.remaining } }; }],
  ['PREVIEW: Heads up — pause works on the page (Space, then the ⏸ button): the time holds and shows paused, resume carries on, the page stays', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.open(p);
    await p.keyboard.press('Space'); await wait(300); const a = await state(p), va = await HU.view(p), pa = await p.evaluate(() => document.getElementById('huTimer').classList.contains('paused'));
    await wait(1600); const b = await state(p), vb = await HU.view(p);
    await p.click('#pauseBtn', { timeout: 2000 }); await wait(2200); const c = await state(p), vc = await HU.view(p), top = await HU.top(p);
    return (a.paused && pa && b.paused && a.left === b.left && va.timer === vb.timer && !c.paused && HU.secs(vc.timer) <= HU.secs(vb.timer) - 1 && top && c.type === 'level') || { a, b, c, va, vb, vc, pa, top }; }],
  ['PREVIEW: Heads up shows each player\'s CHIPS (not Invested); a phone\'s chip change shows at once; a busted player picked with ▶ shows OUT', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.open(p);
    const a = await HU.view(p);
    await HU.phone(p, 'Ann', 1500); await wait(250); const b = await HU.view(p);
    await HU.phone(p, 'Cat', 0); await wait(250); const c = await HU.view(p);
    await p.click('#huSlide .hu-bot .hu-arrow[data-dir="1"]', { timeout: 2000 }); await wait(250); const d = await HU.view(p);
    return (!a.invested && a.seats.every(s => /Chips 700$/.test(s)) && a.chips.join() === '700,700' && b.chips.join() === '1,500,700'
      && c.names.join() === 'Ann,Bob' && d.names.join() === 'Ann,Cat' && d.chips.join() === '1,500,OUT') || { a, b, c, d }; }],
  ['PREVIEW: Heads up opens with the two players who still have chips (biggest stack on top); with 3 in, the two biggest stacks; a reopen keeps the previous pair (both still have chips); a shown player busting with two left → those two', async ({ p }) => {
    await p.click('#startBtn'); await wait(700);
    await HU.chips(p, [0, 500, 900]); await HU.open(p); const a = await HU.view(p);
    await p.click('#headsUpBtn', { timeout: 2000 }); await wait(400);
    await HU.chips(p, [300, 800, 600]); await HU.open(p); const b = await HU.view(p);
    await HU.phone(p, 'Bob', 0); await wait(250); const c = await HU.view(p);
    return (a.names.join() === 'Cat,Bob' && a.chips.join() === '900,500' && b.names.join() === 'Cat,Bob' && b.chips.join() === '600,800'
      && c.names.join() === 'Cat,Ann' && c.chips.join() === '600,300') || { a, b, c }; }],
  ['PREVIEW: Heads up — the host\'s ◀ ▶ choice survives phone chip changes (no auto-pick on every update)', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.open(p); const a = await HU.view(p);
    await p.click('#huSlide .hu-bot .hu-arrow[data-dir="1"]', { timeout: 2000 }); await wait(250); const b = await HU.view(p);
    await HU.phone(p, 'Ann', 650); await wait(250); const c = await HU.view(p);
    await HU.phone(p, 'Bob', 900); await wait(250); const d = await HU.view(p);
    return (a.names.join() === 'Ann,Bob' && b.names.join() === 'Ann,Cat' && c.names.join() === 'Ann,Cat' && c.chips.join() === '650,700' && d.names.join() === 'Ann,Cat') || { a, b, c, d }; }],
  ['PREVIEW: Heads up Winner button (openWinner) opens the Winner page — from the page over a level and from the Heads up slide reached by ⏭ after the last level (auto-picked, chips shown, no Clock button there)', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.open(p);
    await p.click('#huWinnerBtn', { timeout: 2000 }); await wait(700);
    const w1 = await p.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return { winner: presentation.slides[presentation.current].classList.contains('winner'), top: !!(e && e.closest('.slide.winner')), hu: document.body.classList.contains('hu-open'), fn: typeof openWinner }; });
    await p.evaluate(() => presentation.goTo(presentation.slides.findIndex(s => s.dataset.lid === 'L3' && s.dataset.type === 'level'))); await wait(700);
    await HU.chips(p, [0, 400, 1700]); await press(p, '#nextBtn');
    const h = await state(p), v = await HU.view(p), top = await HU.top(p), r = await p.evaluate(() => ({ back: getComputedStyle(document.getElementById('huBack')).display, pressed: document.getElementById('headsUpBtn').getAttribute('aria-pressed') }));
    await p.click('#huWinnerBtn', { timeout: 2000 }); await wait(700);
    const w2 = await p.evaluate(() => presentation.slides[presentation.current].classList.contains('winner'));
    return (w1.winner && w1.top && !w1.hu && w1.fn === 'function' && h.type === 'huSlide' && top && v.names.join() === 'Cat,Bob' && v.chips.join() === '1,700,400' && r.back === 'none' && r.pressed === 'true' && w2) || { w1, h, v, top, r, w2 }; }],
  ['PREVIEW: Heads up — the bottom bar (with the Heads up button) stays ONE row inside the screen at 768x1024, 834x1112, 1024x768, 1180x820, 1366x1024: no clipped button, no overlap with the slide counter or the PREVIEW tag; on the Heads up page Clock, Winner, the 4 arrows and the live level are tappable (nothing on top) and on screen', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.open(p);
    const out = [];
    for (const [w, h] of [[768, 1024], [834, 1112], [1024, 768], [1180, 820], [1366, 1024]]){
      await p.setViewportSize({ width: w, height: h }); await wait(400);
      out.push(await p.evaluate(([w, h]) => { const bar = document.getElementById('fontScaleCtrl'), r = bar.getBoundingClientRect(), kids = [...bar.children].filter(k => getComputedStyle(k).display !== 'none');
        const cy = r.top + r.height / 2, hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        const others = ['slideCounter', 'previewTag'].map(id => document.getElementById(id)).filter(e => e && getComputedStyle(e).display !== 'none');
        const tap = [document.getElementById('huBack'), document.getElementById('huWinnerBtn'), document.getElementById('huLive'), ...document.querySelectorAll('#huSlide .hu-arrow')].filter(Boolean).map(el => { const q = el.getBoundingClientRect();
          const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { id: el.id || el.className, ok: q.width > 0 && q.left >= 0 && q.right <= innerWidth && q.top >= 0 && q.bottom <= r.top && !!e && (e === el || el.contains(e)) }; });
        return { size: w + 'x' + h, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height), n: kids.filter(k => k.tagName === 'BUTTON').length,
          inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
          oneRow: kids.every(k => { const q = k.getBoundingClientRect(); return Math.abs(q.top + q.height / 2 - cy) < 4; }),
          clipped: kids.filter(k => k.scrollWidth > k.clientWidth + 1 || k.scrollHeight > k.clientHeight + 1).map(k => k.id || k.className),
          overlaps: others.filter(o => hit(r, o.getBoundingClientRect())).map(o => o.id),
          gapCounter: Math.round(document.getElementById('slideCounter').getBoundingClientRect().left - r.right), gapTag: Math.round(r.left - document.getElementById('previewTag').getBoundingClientRect().right),
          hu: !!bar.querySelector('#headsUpBtn'), tapBad: tap.filter(x => !x.ok).map(x => x.id), tapN: tap.length }; }, [w, h]));
    }
    console.log('    [bar] ' + JSON.stringify(out));
    return (out.every(x => x.inside && x.oneRow && !x.clipped.length && !x.overlaps.length && x.hu && x.n === 11 && x.tapN === 7 && !x.tapBad.length)) || out; }],
  ['PREVIEW: Heads up with Spotify — the level runs out under the page: music paused, beep, music back (as on the level page); the Now playing card covers none of Clock / Winner / live level / arrows at 1366x1024 and 1180x820; split music view stays off while the page is open (back on after Clock)', async ({ p, spotifyCalls }) => {
    await wait(1200); await p.click('#startBtn'); await wait(SETTLE); await HU.open(p); spotifyCalls.length = 0; await expireNow(p); await wait(3000);
    const calls = spotifyCalls.filter(c => /pause|play$/.test(c)), roll = await state(p), top = await HU.top(p);
    await p.evaluate(() => { musicState.view = 'side'; musicState.open = true; spotify.render(); }); await wait(300);
    const out = [];
    for (const [w, h] of [[1366, 1024], [1180, 820]]){
      await p.setViewportSize({ width: w, height: h }); await wait(400);
      out.push(await p.evaluate(s => { const card = document.getElementById('nowPlaying');
        const tap = [document.getElementById('huBack'), document.getElementById('huWinnerBtn'), document.getElementById('huLive'), ...document.querySelectorAll('#huSlide .hu-arrow')].map(el => { const q = el.getBoundingClientRect();
          const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { id: el.id || el.className, ok: !!e && (e === el || el.contains(e)) }; });
        return { s, card: !card.classList.contains('none') && card.getBoundingClientRect().width > 0, side: document.body.classList.contains('np-side-on'), bad: tap.filter(x => !x.ok).map(x => x.id) }; }, w + 'x' + h));
    }
    await p.click('#huBack', { timeout: 2000 }); await wait(400); const sideAfter = await p.evaluate(() => document.body.classList.contains('np-side-on'));
    return (calls[0] === 'PUT /me/player/pause' && calls[1] === 'PUT /me/player/play' && calls.length === 2 && roll.type === 'transition' && roll.alerts === 1 && top
      && out.every(x => x.card && !x.side && !x.bad.length) && sideAfter) || { calls, roll, top, out, sideAfter }; }, { spotify: true }],
  ['PREVIEW: Heads up — at 768x1024 the moved PREVIEW tag covers nothing on a level page (chip strip, Table button, bar)', async ({ p }) => {
    await p.setViewportSize({ width: 768, height: 1024 }); await p.click('#startBtn'); await wait(900);
    const r = await p.evaluate(() => { const t = document.getElementById('previewTag').getBoundingClientRect(), hit = q => !(q.right <= t.left || q.left >= t.right || q.bottom <= t.top || q.top >= t.bottom);
      const els = [...document.querySelectorAll('.slide.active [data-strip], .slide.active [data-strip] *, #fontScaleCtrl, #fontScaleCtrl *, .slide.active button')].filter(e => { const q = e.getBoundingClientRect(); return q.width && q.height; });
      return { tag: [t.left, t.top, t.right, t.bottom].map(Math.round), hits: els.filter(e => hit(e.getBoundingClientRect())).map(e => e.id || e.className) }; });
    return (r.hits.length === 0 && r.tag[1] >= 0) || r; }],
  /* end-pages item 4: the Winner page runs nothing; three photo tiles; Heads up fixes C and D */
  ['PREVIEW: Winner page — reached by the Winner button, by ⏭ from the real Heads up slide, by an arrow key and by a nav dot: the Heads up page is closed, no tick, no beep / Next up even after the old deadline, no countdown or blinds shown, phones get the no-timer state', async ({ p }) => {
    const out = [];
    for (const route of ['button', 'next', 'arrow', 'dot']){
      await p.evaluate(() => { presentation.isAnimating = false; presentation.goTo(0); }); await wait(600);
      await p.click('#startBtn'); await wait(700);
      if (route === 'button'){ await HU.open(p); await p.evaluate(() => { window.__alerts = 0; clock.deadline = performance.now() + 1200; }); await p.click('#huWinnerBtn', { timeout: 2000 }); }
      else {
        await p.evaluate(() => presentation.goTo(presentation.slides.findIndex(s => s.dataset.lid === 'L3' && s.dataset.type === 'level'))); await wait(700);
        await p.evaluate(() => { clock.deadline = performance.now() + 1200; });
        await press(p, '#nextBtn');                                   /* the real Heads up slide */
        await p.evaluate(() => { window.__alerts = 0; });
        if (route === 'next') await p.click('#nextBtn'); else if (route === 'arrow') await p.keyboard.press('ArrowRight');
        else await p.evaluate(() => { const d = document.querySelectorAll('#navDots > *'); d[d.length - 1].click(); });
      }
      await wait(3000);
      out.push(await p.evaluate(route => { const sl = presentation.slides[presentation.current], sn = phones.snapshot();
        return { route, winner: sl.classList.contains('winner'), hu: document.body.classList.contains('hu-open'), tick: clock.tickId, el: !!clock.el, act: !!clock.activeSlide, alerts: window.__alerts,
          clocks: sl.querySelectorAll('[data-clock]').length, timeText: /\d+:\d\d/.test(sl.innerText), blinds: /blinds|next up/i.test(sl.innerText), huLive: getComputedStyle(document.getElementById('huLive')).display,
          snap: { type: sn.type, remaining: sn.remaining, paused: sn.paused, sb: sn.sb, bb: sn.bb, next: sn.next } }; }, route));
    }
    return out.every(o => o.winner && !o.hu && o.tick === null && !o.el && !o.act && o.alerts === 0 && !o.clocks && !o.timeText && !o.blinds && o.huLive === 'none'
      && o.snap.type === 'winner' && o.snap.remaining === null && !o.snap.paused && o.snap.sb === null && o.snap.next === null) || out; }],
  ['PREVIEW: Winner page — three photo tiles "Hand 1", "Hand 2 (optional)", "Winner photo": a REAL mouse click at each tile\'s centre hits it and opens the picker (file chooser); at 768x1024, 834x1112, 1024x768, 1180x820, 1366x1024 the tiles, avatar, pick row, name and line are inside the screen above the bottom bar and do not overlap', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.evaluate(() => { presentation.goTo(presentation.slides.findIndex(s => s.classList.contains('winner'))); }); await wait(900);
    const labels = await p.evaluate(() => [...document.querySelectorAll('[data-win-tile]')].map(t => t.querySelector('.wt-label').textContent));
    const out = []; let chosen = 0;
    for (const [w, h] of [[768, 1024], [834, 1112], [1024, 768], [1180, 820], [1366, 1024]]){
      await p.setViewportSize({ width: w, height: h }); await wait(600);
      const m = await p.evaluate(([w, h]) => { const bar = document.getElementById('fontScaleCtrl').getBoundingClientRect(), R = e => { const q = e.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom }; };
        const items = { avatar: R(document.querySelector('.win-avatar')), pick: R(document.querySelector('.win-pick')), name: R(document.querySelector('[data-win-name]')), tiles: R(document.getElementById('winTiles')), sub: R(document.querySelector('.win-sub')) };
        const hit = (a, b) => !(a.r <= b.l + 1 || a.l >= b.r - 1 || a.b <= b.t + 1 || a.t >= b.b - 1), keys = Object.keys(items), over = [];
        for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (hit(items[keys[i]], items[keys[j]])) over.push(keys[i] + '/' + keys[j]);
        const inside = keys.every(k => items[k].l >= 0 && items[k].r <= w && items[k].t >= 0 && items[k].b <= bar.top - 2);
        const crown = R(document.querySelector('.win-crown')), tile = document.querySelector('[data-win-tile]').getBoundingClientRect();
        return { size: w + 'x' + h, barTop: Math.round(bar.top), tiles: [items.tiles.l, items.tiles.t, items.tiles.r, items.tiles.b].map(Math.round).join(','), tile: Math.round(tile.width) + 'x' + Math.round(tile.height), lowest: Math.round(Math.max(items.sub.b, items.tiles.b)), crownTop: Math.round(crown.t), inside, over }; }, [w, h]);
      m.taps = [];
      for (const slot of ['hand1', 'hand2', 'winner']){
        const t = await p.evaluate(slot => { const e = document.querySelector('[data-win-tile="' + slot + '"]'); e.scrollIntoView({ block: 'nearest' }); const q = e.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2, h = document.elementFromPoint(x, y); return { x, y, hit: !!h && (h === e || e.contains(h)) }; }, slot);
        const fc = await Promise.all([p.waitForEvent('filechooser', { timeout: 8000 }), p.mouse.click(t.x, t.y)]).then(r => r[0], () => null); m.taps.push(t.hit && !!fc); if (fc){ chosen++; await fc.setFiles([]); await wait(150); }
      }
      out.push(m);
    }
    console.log('    [winner tiles] ' + JSON.stringify(out.map(o => ({ size: o.size, barTop: o.barTop, tiles: o.tiles, tile: o.tile, lowest: o.lowest, crownTop: o.crownTop }))));
    return (labels.join('|') === 'Hand 1|Hand 2 (optional)|Winner photo' && out.every(o => o.inside && !o.over.length && o.taps.every(Boolean) && o.crownTop >= 0) && chosen === 15) || { labels, out, chosen }; }],
  ['PREVIEW: Winner photos — a 4000x3000 photo picked on a tile shows on it, is kept at 1280 px (JPEG, under 400 KB), is NOT in bank.photos nor in the main saved game, survives a reload; a 2nd pick replaces it; Reset clears all three', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.evaluate(() => { presentation.goTo(presentation.slides.findIndex(s => s.classList.contains('winner'))); }); await wait(900);
    const buf = await bigJpeg(p, 4000, 3000), buf2 = await bigJpeg(p, 3000, 4000);
    const pickTile = async (slot, b) => { const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 15000 }), p.click('[data-win-tile="' + slot + '"]', { timeout: 15000 })]); await fc.setFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: b }); };
    await pickTile('hand1', buf); await until(() => p.evaluate(() => !!(window.winnerPhotos && winnerPhotos.get().hand1)), 20000); await wait(300); await pickTile('winner', buf2);
    await until(() => p.evaluate(() => !!(window.winnerPhotos && winnerPhotos.get().hand1 && winnerPhotos.get().winner)), 20000); await wait(400);
    const info = () => p.evaluate(async () => { const g = winnerPhotos.get(), raw = localStorage.getItem('poker_winner_photos_v1'), st = localStorage.getItem('poker_clock_state_v1') || '';
      const dim = u => new Promise(r => { if (!u) return r(null); const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = u; });
      const o = raw ? JSON.parse(raw) : null;
      return { tiles: [...document.querySelectorAll('[data-win-tile]')].map(t => t.classList.contains('has-photo') && /url\("data:image\/jpeg/.test(t.style.backgroundImage)),
        h1: await dim(g.hand1), w: await dim(g.winner), h2: g.hand2, kb: { h1: g.hand1 ? Math.round(g.hand1.length * 3 / 4 / 1024) : 0, w: g.winner ? Math.round(g.winner.length * 3 / 4 / 1024) : 0 },
        stored: !!o && o.hand1 === g.hand1 && o.winner === g.winner && o.hand2 === null, jpeg: !!g.hand1 && g.hand1.startsWith('data:image/jpeg'),
        inBank: bank.photos.some(x => x && x.length > 5000), inState: !!g.hand1 && (st.includes(g.hand1.slice(30, 130)) || st.includes('poker_winner')), mainOk: !!(JSON.parse(st || '{}').names) }; });
    await p.evaluate(() => { bank.chips[0] = 701; syncBankUI(); saveState(); }); await wait(600);
    const a = await info(); console.log('    [winner photos] ' + JSON.stringify({ srcKB: [buf.length >> 10, buf2.length >> 10], hand1: a.h1, winner: a.w, kb: a.kb }));
    const before = await p.evaluate(() => winnerPhotos.get().hand1);
    await p.reload(); await wait(1400); await p.evaluate(() => { presentation.goTo(presentation.slides.findIndex(s => s.classList.contains('winner'))); }); await wait(900); const b = await info();
    await pickTile('hand1', buf2); await until(() => p.evaluate(b => winnerPhotos.get().hand1 !== b, before), 20000); await wait(400); const c = await info();
    p.once('dialog', d => d.accept()); await p.evaluate(() => document.getElementById('resetAll').click()); await wait(1800);
    const d = await p.evaluate(() => ({ key: localStorage.getItem('poker_winner_photos_v1'), tiles: [...document.querySelectorAll('[data-win-tile]')].some(t => t.classList.contains('has-photo')), g: winnerPhotos.get() }));
    return (a.tiles.join() === 'true,false,true' && a.h1.join() === '1280,960' && a.w.join() === '960,1280' && a.kb.h1 < 400 && a.kb.w < 400 && a.stored && a.jpeg && !a.inBank && !a.inState && a.mainOk
      && b.tiles.join() === 'true,false,true' && b.h1.join() === '1280,960' && b.stored && c.h1.join() === '960,1280' && c.tiles[0]
      && d.key === null && !d.tiles && !d.g.hand1 && !d.g.winner && !d.g.hand2) || { a, b, c, d }; }],
  ['PREVIEW: Winner photos — storage full: a refused write gets one more try at 960 px; refused again → the photo stays on the tile for this session with "Not saved: storage full"; the main saved game is untouched and keeps saving', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await p.evaluate(() => { presentation.goTo(presentation.slides.findIndex(s => s.classList.contains('winner'))); }); await wait(900);
    const buf = await bigJpeg(p, 4000, 3000);
    const pickTile = async (slot) => { const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 15000 }), p.click('[data-win-tile="' + slot + '"]', { timeout: 15000 })]); await fc.setFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: buf }); };
    await p.evaluate(() => { bank.chips[0] = 702; syncBankUI(); saveState(); }); await wait(600);
    const mainBefore = await p.evaluate(() => localStorage.getItem('poker_clock_state_v1'));
    /* 1: only the first write is refused; the smaller retry fits */
    await p.evaluate(() => { window.__tries = []; window.__origSet = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v){ if (k === 'poker_winner_photos_v1'){ window.__tries.push(v.length); if (window.__tries.length === 1) throw new DOMException('full', 'QuotaExceededError'); } return window.__origSet.apply(this, arguments); }; });
    await pickTile('hand1'); await until(() => p.evaluate(() => window.__tries.length >= 2), 20000); await wait(500);
    const one = await p.evaluate(async () => { const g = winnerPhotos.get(); const dim = await new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = g.hand1; });
      return { tries: window.__tries.length, small: window.__tries[1] < window.__tries[0] || dim[0] <= 960, dim, note: document.querySelector('[data-win-tile="hand1"] .wt-note').textContent, stored: !!JSON.parse(localStorage.getItem('poker_winner_photos_v1') || 'null') }; });
    /* 2: every write to that key is refused */
    await p.evaluate(() => { window.__tries = []; Storage.prototype.setItem = function(k, v){ if (k === 'poker_winner_photos_v1'){ window.__tries.push(v.length); throw new DOMException('full', 'QuotaExceededError'); } return window.__origSet.apply(this, arguments); }; });
    await pickTile('winner'); await until(() => p.evaluate(() => window.__tries.length >= 2), 20000); await wait(600);
    const two = await p.evaluate(() => ({ tries: window.__tries.length, note: document.querySelector('[data-win-tile="winner"] .wt-note').textContent, shown: document.querySelector('[data-win-tile="winner"]').classList.contains('has-photo'), mem: !!winnerPhotos.get().winner,
      noteOnOther: document.querySelector('[data-win-tile="hand1"] .wt-note').textContent, mainSame: localStorage.getItem('poker_clock_state_v1') }));
    await p.evaluate(() => { bank.chips[0] = 703; syncBankUI(); saveState(); }); await wait(700);
    const mainAfter = await p.evaluate(() => JSON.parse(localStorage.getItem('poker_clock_state_v1')));
    return (one.tries === 2 && one.small && one.note === '' && one.stored && two.tries === 2 && two.note === 'Not saved: storage full' && two.shown && two.mem && two.noteOnOther === '' && two.mainSame === mainBefore && mainAfter.chips[0] === 703 && mainAfter.names.length === 3) || { one, two, mainAfter }; }],
  ['PREVIEW: Heads up — a busted player cannot stay on the page: 4 players 900/800/500/400, the shown #2 goes OUT, then a player who is NOT shown goes out so two remain → the page shows exactly those two (no OUT)', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.four(p); await HU.open(p); const a = await HU.view(p);
    await HU.phone(p, 'Bob', 0); await wait(250); const b = await HU.view(p);
    await HU.phone(p, 'Dan', 0); await wait(250); const c = await HU.view(p);
    return (a.names.join() === 'Ann,Bob' && b.names.join() === 'Ann,Bob' && b.chips.join() === '900,OUT' && c.names.join() === 'Ann,Cat' && c.chips.join() === '900,500' && !c.chips.includes('OUT')) || { a, b, c }; }],
  ['PREVIEW: Heads up — closing and reopening the page keeps the host\'s ◀ ▶ pair while both still have chips; it auto-picks on the first open and when a shown player is out', async ({ p }) => {
    await p.click('#startBtn'); await wait(700); await HU.four(p); await HU.open(p); const a = await HU.view(p);
    await p.click('#huSlide .hu-bot .hu-arrow[data-dir="1"]', { timeout: 2000 }); await wait(250); const b = await HU.view(p);
    await p.click('#headsUpBtn', { timeout: 2000 }); await wait(500); await HU.open(p); const c = await HU.view(p);
    await p.click('#headsUpBtn', { timeout: 2000 }); await wait(500); await HU.phone(p, 'Cat', 0); await wait(250); await HU.open(p); const d = await HU.view(p);
    return (a.names.join() === 'Ann,Bob' && b.names.join() === 'Ann,Cat' && c.names.join() === 'Ann,Cat' && c.chips.join() === '900,500' && d.names.join() === 'Ann,Bob' && d.chips.join() === '900,800') || { a, b, c, d }; }],
];

(async () => {
  const srv = /^http:\/\/localhost:8791\//.test(PAGE) ? await require('./serve').start() : null;   /* self-serve the repo (also for preview/) */
  const rows = []; let failed = 0;
  for (const bt of [webkit, chromium]) {
    for (const [name, fn, opts] of TESTS.concat(P ? PREVIEW_TESTS : []).filter(t => !process.env.ONLY || t[0].includes(process.env.ONLY))) {   /* ONLY=<text>: just the checks whose name has it */
      const env = await newPage(bt, opts);
      let ok, detail = '';
      try { const r = await fn(env); ok = r === true; if (!ok) detail = JSON.stringify(r); }
      catch (e) { ok = false; detail = e.message.split('\n')[0]; }
      if (env.errors.length) { ok = false; detail += ' page errors: ' + env.errors.join(' | '); }
      if (!ok) failed++;
      rows.push(`${ok ? 'PASS' : 'FAIL'}  ${bt === webkit ? 'Safari' : 'Chrome'}  ${name}${detail ? '\n        ' + detail : ''}`);
      await env.b.close();
    }
  }
  console.log(rows.join('\n'));
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  if (srv) srv.close(); process.exit(failed ? 1 : 0);
})();
