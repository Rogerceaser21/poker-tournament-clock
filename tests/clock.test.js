/* Poker Tournament Clock — automated checks (run before every push).
 *
 *   run (it serves the repo itself on :8791):                NODE_PATH=<a node_modules with playwright> node tests/clock.test.js
 *
 * Drives the real page in iPad-sized Safari (WebKit, iPad user agent) and Chrome.
 * Spotify is faked (no real account needed). Prints a results table; exits 1 if anything fails.
 */
const { webkit, chromium } = require('playwright');
const PAGE = process.env.CLOCK_URL || 'http://localhost:8791/Poker%20Tournament%20Clock.html';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const LEVELS = [[1, 2], [2, 4], [5, 10]].map(([sb, bb], i) => ({ id: 'L' + (i + 1), sb, bb, mins: 20 }));
const wait = ms => new Promise(r => setTimeout(r, ms));
/* HEADLESS WebKit only: after the first real tap unlocks all 17 sound players, its media side is busy for ~2 s and the
   next play() waits for it. The real Safari engine does not (iPadOS 26.3 Simulator: beep / 💀 audible within 33-125 ms
   of being asked 0.7-4 s after the first tap, all played in full; log /Users/igor/wt/poker-fixes-logs/sim-walk-t3-first-tap-timing.log).
   So the checks whose 2nd tap times a beep let that first tap settle first. */
const SETTLE = 3000;

async function newPage(browserType, { spotify = false } = {}) {
  const b = await browserType.launch();
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, userAgent: browserType === webkit ? IPAD_UA : undefined, hasTouch: browserType === webkit });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  const spotifyCalls = [];
  /* fake Spotify that keeps state like the real one: pause → paused (a 2nd pause = 403 "Restriction violated"), play → playing.
     log = every call with its send time t and reply time done (ms) */
  const fake = { playing: true, playDelay: 0, pauseDelay: 0, playFails: [], playFailAll: 0, speaker: false, vol: 70, volFails: 0 }, log = [];
  await ctx.route('https://api.spotify.com/v1/**', async r => {
    const u = r.request().url(), path = u.split('/v1')[1], m = r.request().method(), e = { c: m + ' ' + path.split('?')[0], t: Date.now(), done: 0, v: +(new URL(u).searchParams.get('volume_percent') || 0) };
    log.push(e);
    if (!path.startsWith('/me/player?')) spotifyCalls.push(e.c);
    const reply = async (o) => { if (e.c === 'PUT /me/player/play' && fake.playDelay) await wait(fake.playDelay); if (e.c === 'PUT /me/player/pause' && fake.pauseDelay) await wait(fake.pauseDelay); e.done = Date.now(); return r.fulfill(o); };
    if (path === '/me') return reply({ status: 200, contentType: 'application/json', body: '{"display_name":"Test"}' });
    if (path.startsWith('/me/player?')) return reply({ status: 200, contentType: 'application/json', body: JSON.stringify({ is_playing: fake.playing, progress_ms: 1000,
      device: fake.speaker ? { id: 'spk', type: 'Speaker', volume_percent: fake.vol, supports_volume: true } : { id: 'ipad', type: 'Tablet', volume_percent: 70, supports_volume: false },
      item: { id: 't', name: 'Song', duration_ms: 200000, artists: [{ name: 'Artist' }], album: { images: [{ url: 'x' }] } } }) });
    if (e.c === 'PUT /me/player/pause'){ if (!fake.playing) return reply({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } }) }); fake.playing = false; }
    if (e.c === 'PUT /me/player/volume'){ if (fake.volFails > 0 && e.v >= 50){ fake.volFails--;   /* only the RESTORE (back up to 70) fails */ e.st = 500; return reply({ status: 500, contentType: 'application/json', body: '{"error":{"status":500}}' }); } fake.vol = e.v; e.st = 204; return reply({ status: 204, body: '' }); }
    if (e.c === 'PUT /me/player/play' && (fake.playFails.length || fake.playFailAll)){ const st = fake.playFails.shift() || fake.playFailAll;   /* resume refused: Spotify stays paused */
      return reply({ status: st, headers: st === 429 ? { 'Retry-After': '1', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After' } : {}, contentType: 'application/json', body: JSON.stringify({ error: { status: st, message: 'fail' } }) }); }
    if (e.c === 'PUT /me/player/play'){ const res = reply({ status: 204, body: '' }); await res; fake.playing = true; return; }
    return reply({ status: 204, body: '' });
  });
  /* spy: every meme sound started / ended (page clock) */
  /* i = which element (the pool has 2 per sound); __audioNew = how many Audio elements were ever made */
  await p.addInitScript(() => { window.__sfx = []; window.__ends = []; window.__ai = 0; const o = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ if (!this.muted && this.src && this.src.includes('/sounds/')){ const n = this.src.split('/').pop(), i = this.__i || (this.__i = ++window.__ai); window.__sfx.push({ n, i, t: Date.now() });
      this.addEventListener('ended', () => window.__ends.push({ n, i, t: Date.now(), m: this.muted }), { once: true }); } return o.apply(this, arguments); };
    window.__audioNew = 0; const A = window.Audio; window.Audio = new Proxy(A, { construct(t, a){ window.__audioNew++; return Reflect.construct(t, a); } }); });
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
    await wait(1200); log.length = 0; emoji(p, '😂'); await wait(300); emoji(p, '😭'); await wait(6500);
    const d = dips(log), ends = await p.evaluate(() => window.__ends), last = Math.max(0, ...ends.map(e => e.t)), play = d.find(e => e.c === 'play');
    return (d.length === 2 && d[0].c === 'pause' && d[1].c === 'play' && ends.length === 2 && play.t >= last && clean(d)) || { d, ends }; }, { spotify: true }],
  ['Music dip: a sound while the "play" reply is on its way → no 2nd pause before it, still dips after', async ({ p, log, fake }) => {
    await wait(1200); fake.playDelay = 600; log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'play'), 4000); await wait(100); emoji(p, '🤡'); await wait(3500);
    const d = dips(log);
    return (d.map(e => e.c).join() === 'pause,play,pause,play' && clean(d)) || { d }; }, { spotify: true }],
  ['Music dip: Spotify not playing → no pause sent at all', async ({ p, log, fake }) => {
    fake.playing = false; await p.evaluate(() => spotify.poll()); await wait(1200); log.length = 0; emoji(p, '🤡'); await wait(2000);
    const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length);
    return (d.length === 0 && sfx === 1) || { d, sfx }; }, { spotify: true }],
  ['Music dip: a poll seeing "paused" mid-dip → music back, shows playing, next sound still dips', async ({ p, log }) => {
    await wait(1200); log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await p.evaluate(() => spotify.poll());
    await until(() => dips(log).some(e => e.c === 'play' && e.done), 4000); emoji(p, '🤡'); await wait(2500);
    const d = dips(log), r = await p.evaluate(() => ({ playing: spotify.now && spotify.now.playing, k: document.getElementById('npK').textContent }));
    return (d.map(e => e.c).join() === 'pause,play,pause,play' && clean(d) && r.playing === true && r.k === 'Now playing') || { d, r }; }, { spotify: true }],
  ['Music dip: a 403 that is NOT Premium-required on the dip\'s pause keeps the buttons, sound still plays, no play sent', async ({ p, log }) => {
    await p.context().route('https://api.spotify.com/v1/me/player/pause', r => { log.push({ c: 'PUT /me/player/pause', t: Date.now(), done: Date.now() }); return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } }) }); });
    await wait(1200); log.length = 0; emoji(p, '🤡'); await wait(2000);
    const d = dips(log), r = await p.evaluate(() => ({ premium: spotify.premium, hidden: ['npCtl', 'npSideCtl', 'npBigCtl'].map(i => document.getElementById(i).classList.contains('none')), sfx: window.__sfx.length }));
    return (d.map(e => e.c).join() === 'pause' && r.premium !== false && r.hidden.every(h => !h) && r.sfx === 1) || { d, r }; }, { spotify: true }],
  ['Music dip: a long sound (😭 4.5 s) is not cut — play ≥ 4.4 s after the pause', async ({ p, log }) => {
    await wait(1200); log.length = 0; emoji(p, '😭'); await wait(6500);
    const d = dips(log), gap = d.length === 2 ? d[1].t - d[0].t : null;
    return (d.length === 2 && d[0].c === 'pause' && d[1].c === 'play' && gap >= 4400) || { d, gap }; }, { spotify: true }],
  ['Music dip: a waiting sound is NOT played (and no extra pause) when sound was muted meanwhile', async ({ p, log }) => {
    await wait(1200); await p.evaluate(() => { musicDip.MAX = 3000; }); log.length = 0; emoji(p, '😭'); await wait(1500); emoji(p, '🔥');   /* 🔥 (2.6 s) can't end before the 3-s cap → waits */
    await wait(100); await p.evaluate(() => sound.toggleMute()); await wait(5500);
    const d = dips(log), sfx = await p.evaluate(() => window.__sfx.length), q = await p.evaluate(() => musicDip.queue.length);
    return (d.map(e => e.c).join() === 'pause,play' && sfx === 1 && q === 0 && clean(d)) || { d, sfx, q }; }, { spotify: true }],
  ['Music dip: a slow Spotify (pause answers after 6 s) → level alert still sounds within 2 s, one pause + one play after it', async ({ p, log, fake }) => {
    await wait(1200); fake.pauseDelay = 6000; log.length = 0; const t0 = Date.now(); p.evaluate(() => window.levelAlert());
    const heard = await until(() => p.evaluate(() => window.__sounds > 0), 4000), dt = Date.now() - t0; await wait(8000);
    const d = dips(log);
    return (heard && dt < 2000 && d.map(e => e.c).join() === 'pause,play' && d[1].t >= d[0].done && clean(d)) || { dt, d }; }, { spotify: true }],
  ['Music dip: resume answers 429 twice, then OK → retried, music back, only one pause', async ({ p, log, fake }) => {
    await wait(1200); fake.playFails = [429, 429]; log.length = 0; emoji(p, '🤡'); await wait(9000);
    const d = dips(log), r = await p.evaluate(() => spotify.now && spotify.now.playing);
    return (d.map(e => e.c).join() === 'pause,play,play,play' && fake.playing && r === true) || { d, r, fake: fake.playing }; }, { spotify: true }],
  ['Music dip: resume fails every time → shows Paused, next sound sends NO pause', async ({ p, log, fake }) => {
    await wait(1200); fake.playFailAll = 500; log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).filter(e => e.c === 'play' && e.done).length === 3, 7000); await wait(100);
    const r = await p.evaluate(() => ({ playing: spotify.now && spotify.now.playing, k: document.getElementById('npK').textContent })); emoji(p, '🤡'); await wait(1500);
    const d = dips(log);
    return (d.map(e => e.c).join() === 'pause,play,play,play' && r.playing === false && r.k !== 'Now playing') || { d, r }; }, { spotify: true }],
  ['Music dip (speaker): volume restore fails 3 times → next dip still restores the ORIGINAL 70, never lowers from the lowered level', async ({ p, log, fake }) => {
    fake.speaker = true; await p.evaluate(() => spotify.poll()); await wait(1200);
    fake.volFails = 3; log.length = 0; emoji(p, '🤡');
    await until(() => log.filter(e => e.c === 'PUT /me/player/volume' && e.st === 500).length === 3, 8000); await wait(300);
    await p.evaluate(() => spotify.poll()); await wait(600); emoji(p, '🤡'); await wait(2500);
    const v = log.filter(e => e.c === 'PUT /me/player/volume').map(e => e.v + ':' + e.st);
    return (v.join() === '18:204,70:500,70:500,70:500,18:204,70:204' && fake.vol === 70) || { v, vol: fake.vol }; }, { spotify: true }],
  ['Music dip: slow resume (play answers after 6 s) → a level alert right after the sound still starts within 2 s, music ends playing', async ({ p, log, fake }) => {
    await wait(1200); fake.playDelay = 6000; log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'play'), 4000); await wait(100);
    const t0 = Date.now(); p.evaluate(() => window.levelAlert());
    const heard = await until(() => p.evaluate(() => window.__sounds > 0), 8000), dt = Date.now() - t0; await wait(7500);
    const d = dips(log);
    return (heard && dt < 2000 && clean(d) && d.length && d[d.length - 1].c === 'play' && fake.playing) || { dt, d, playing: fake.playing }; }, { spotify: true }],
  ['Music dip: slow resume (play answers after 6 s) → 4 emojis + level alert fired together ALL start within 2 s', async ({ p, log, fake }) => {
    await wait(1200); fake.playDelay = 6000; log.length = 0; emoji(p, '🤡');
    await until(() => dips(log).some(e => e.c === 'play'), 4000); await wait(100);
    const t0 = await p.evaluate(() => { window.__alertAt = 0; const o = sound.playTransition.bind(sound); sound.playTransition = (...x) => { window.__alertAt = Date.now(); return o(...x); };
      const t = Date.now(); window.__sfx.length = 0; ['😂', '🔥', '💀', '👏'].forEach(e => emojiSfx.play(e)); window.levelAlert(); return t; });
    await wait(9000);
    const r = await p.evaluate(() => ({ sfx: window.__sfx.map(x => x.t), alert: window.__alertAt })), late = [...r.sfx, r.alert].map(t => t ? t - t0 : null), d = dips(log);
    return (r.sfx.length === 4 && late.every(x => x !== null && x < 2000) && clean(d) && d.map(e => e.c).join() === 'pause,play' && fake.playing) || { late, d, playing: fake.playing }; }, { spotify: true }],
  ['Emoji: same emoji twice 300 ms apart → two players overlap, the first is NOT restarted (runs to its own end)', async ({ p }) => {
    await wait(600); emoji(p, '💀'); await wait(300); emoji(p, '💀'); await wait(3500);
    const r = await p.evaluate(() => ({ s: window.__sfx.filter(x => x.n === 'fah.m4a'), e: window.__ends.filter(x => x.n === 'fah.m4a') }));
    const [a, b] = r.s, ea = a && r.e.find(x => x.i === a.i), eb = b && r.e.find(x => x.i === b.i);
    return (r.s.length === 2 && a.i !== b.i && ea && eb && b.t < ea.t && ea.t - a.t >= 1800 && eb.t - b.t >= 1800) || r; }],
  ['Emoji: the length table matches the real files (within 100 ms)', async ({ p }) => {
    const r = await until(() => p.evaluate(() => { if (typeof emojiSfx === 'undefined' || !emojiSfx.MS || !emojiSfx.pool) return { none: true };
      const out = {}; for (const [n, l] of Object.entries(emojiSfx.pool)){ const d = l[0].duration; if (!isFinite(d) || !(d > 0)) return null; out[n] = { real: Math.round(d * 1000), table: emojiSfx.MS[n] }; } return out; }), 8000);
    return (r && !r.none && Object.keys(r).length === 8 && Object.values(r).every(x => Math.abs(x.real - x.table) <= 100)) || r; }],
  ['Emoji: no Audio element is made at play time (all 16 made at start-up)', async ({ p }) => {
    const n0 = await p.evaluate(() => window.__audioNew);
    await p.evaluate(() => ['😂', '🔥', '💀', '💀', '💀', '🤡', '💰'].forEach(e => emojiSfx.play(e))); await wait(800);
    const n1 = await p.evaluate(() => window.__audioNew);
    return (n0 >= 17 && n1 === n0) || { n0, n1 }; }],
  ['Emoji: unlock is retried — 1st tap refused, 2nd tap (touchend) unlocks every player', async ({ p }) => {
    await p.evaluate(() => { const o = HTMLMediaElement.prototype.play; window.__refuse = true;
      HTMLMediaElement.prototype.play = function(){ if (window.__refuse && this.muted) return Promise.reject(new DOMException('no', 'NotAllowedError')); return o.apply(this, arguments); }; });
    await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown'))); await wait(400);
    const a = await p.evaluate(() => ({ n: emojiSfx.unlockedCount, total: emojiSfx.total }));
    await p.evaluate(() => { window.__refuse = false; window.dispatchEvent(new Event('touchend')); });
    const b = await until(() => p.evaluate(() => emojiSfx.unlockedCount === emojiSfx.total && emojiSfx.unlockedCount), 4000);
    const quiet = await p.evaluate(() => emojiSfx.all().every(x => x.paused && !x.muted) && sound.audio.paused && !sound.audio.muted);
    return (typeof a.n === 'number' && a.total === 17 && a.n < a.total && b === 17 && quiet) || { a, b, quiet }; }],
  ['Emoji: an unlock still on its way does not silence a real play started at the same moment', async ({ p }) => {
    await wait(600);
    await p.evaluate(() => { const o = HTMLMediaElement.prototype.play;   /* the 💀 players' unlock (muted) plays answer 400 ms late (only those: 17 running at once stalls headless WebKit) */
      HTMLMediaElement.prototype.play = function(){ const r = o.apply(this, arguments); return this.muted && this.src.includes('fah') ? new Promise((ok, bad) => setTimeout(() => r.then(ok, bad), 400)) : r; };
      window.dispatchEvent(new PointerEvent('pointerdown')); emojiSfx.play('💀'); });
    /* the real play must run to its own end, unmuted (an unlock that paused / muted it would never end, or end muted) */
    await until(() => p.evaluate(() => window.__ends.some(x => x.n === 'fah.m4a')), 8000);
    const r = await p.evaluate(() => ({ s: window.__sfx.filter(x => x.n === 'fah.m4a'), e: window.__ends.filter(x => x.n === 'fah.m4a') })), s = r.s[0], e = s && r.e.find(x => x.i === s.i);
    return (r.s.length === 1 && e && !e.m && e.t - s.t >= 1800) || r; }],
  ['Emoji: emojiSfx.log records a refused play (error name) and a good play (ok true)', async ({ p }) => {
    await wait(600);
    await p.evaluate(() => { const o = HTMLMediaElement.prototype.play; window.__refuseFah = true;
      HTMLMediaElement.prototype.play = function(){ if (window.__refuseFah && !this.muted && this.src.includes('fah')) return Promise.reject(new DOMException('no', 'NotAllowedError')); return o.apply(this, arguments); }; });
    await emoji(p, '💀'); await wait(500); await p.evaluate(() => { window.__refuseFah = false; }); await emoji(p, '🤡'); await wait(800);
    const log = await p.evaluate(() => emojiSfx.log || null), bad = log && log.find(x => x.e === '💀'), good = log && log.find(x => x.e === '🤡');
    return (bad && bad.ok === false && bad.err === 'NotAllowedError' && typeof bad.at === 'number' && good && good.ok === true) || { log }; }],
  ['Emoji: a play dropped while its player\'s unlock is on its way leaves no player muted or playing', async ({ p }) => {
    await wait(600);
    await p.evaluate(() => { const o = HTMLMediaElement.prototype.play;   /* the 😭 players' unlock (muted) plays answer 600 ms late */
      HTMLMediaElement.prototype.play = function(){ const r = o.apply(this, arguments); return this.muted && this.src.includes('fail-horn') ? new Promise((ok, bad) => setTimeout(() => r.then(ok, bad), 600)) : r; };
      window.dispatchEvent(new PointerEvent('pointerdown')); emojiSfx.play('😭'); emojiSfx.on = false; });   /* switched off before its dip turn → dropped */
    await wait(1500);
    const r = await p.evaluate(() => emojiSfx.pool['fail-horn'].map(a => ({ paused: a.paused, muted: a.muted, t: +a.currentTime.toFixed(2), ok: a._ok, job: !!a._job })));
    return r.every(a => a.paused && !a.muted && a.t === 0 && a.ok && !a.job) || r; }],
  ['Emoji: mute while 😭 plays → it stops within 200 ms and the music is back within ~1 s', async ({ p, log }) => {
    await wait(1200); log.length = 0; emoji(p, '😭');
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await wait(800);
    const t0 = Date.now(); await p.evaluate(() => sound.toggleMute());
    const stop = await until(() => p.evaluate(() => emojiSfx.pool['fail-horn'].every(a => a.paused)), 2000), dt = Date.now() - t0;
    const back = await until(() => dips(log).find(e => e.c === 'play'), 3000), d = dips(log);
    return (stop && dt <= 200 && back && back.t - t0 <= 1000 && d.map(e => e.c).join() === 'pause,play') || { dt, back: back && back.t - t0, d }; }, { spotify: true }],
  ['Emoji: switching Emoji sounds off while 😭 plays → it stops within 200 ms and the music is back within ~1 s', async ({ p, log }) => {
    await wait(1200); log.length = 0; emoji(p, '😭');
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await wait(800);
    const t0 = Date.now(); await p.evaluate(() => { const es = document.getElementById('phEmojiSounds'); es.checked = false; es.dispatchEvent(new Event('change')); });
    const stop = await until(() => p.evaluate(() => emojiSfx.pool['fail-horn'].every(a => a.paused)), 2000), dt = Date.now() - t0;
    const back = await until(() => dips(log).find(e => e.c === 'play'), 3000), d = dips(log);
    return (stop && dt <= 200 && back && back.t - t0 <= 1000 && d.map(e => e.c).join() === 'pause,play') || { dt, back: back && back.t - t0, d }; }, { spotify: true }],
  ['Emoji: mute while a 3rd 😭 reuses a playing player and still waits for its dip turn → no emoji player plays 250 ms later', async ({ p }) => {
    await wait(600); emoji(p, '😭'); await wait(300); emoji(p, '😭'); await wait(500);
    await p.evaluate(() => { musicDip.run(() => new Promise(r => setTimeout(r, 1500))); emojiSfx.play('😭'); });   /* dip chain busy 1.5 s: the 3rd waits */
    await wait(100); await p.evaluate(() => sound.toggleMute()); await wait(250);
    const r = await p.evaluate(() => emojiSfx.all().filter(a => !a.paused && !a.muted).map(a => a.src.split('/').pop() + '@' + a.currentTime.toFixed(2)));
    await wait(1800); const later = await p.evaluate(() => emojiSfx.all().filter(a => !a.paused && !a.muted).length);
    return (r.length === 0 && later === 0) || { r, later }; }],
  ['Beep: mute while the level beep plays → the music is back within ~1 s; the next alert still dips and sounds', async ({ p, log }) => {
    await wait(1200); log.length = 0; p.evaluate(() => window.levelAlert());
    await until(() => dips(log).some(e => e.c === 'pause' && e.done), 3000); await wait(200);
    const t0 = Date.now(); await p.evaluate(() => sound.toggleMute());
    const back = await until(() => dips(log).find(e => e.c === 'play'), 4000);
    await wait(1500); await p.evaluate(() => sound.toggleMute()); await wait(2200); log.length = 0; const s0 = await p.evaluate(() => window.__sounds);
    p.evaluate(() => window.levelAlert()); await wait(3500); const d = dips(log), s1 = await p.evaluate(() => window.__sounds);
    return (back && back.t - t0 <= 1000 && d.map(e => e.c).join() === 'pause,play' && s1 === s0 + 1) || { back: back && back.t - t0, d, s0, s1 }; }, { spotify: true }],
  ['Beep: a real beep that played counts the beep player as unlocked (unlock never ran)', async ({ p }) => {
    await p.evaluate(() => { sound._unlock = () => {}; window.levelAlert(); }); await wait(1500);
    const r = await p.evaluate(() => ({ unlocked: sound.unlocked, n: emojiSfx.unlockedCount, emoji: emojiSfx.all().filter(a => a._ok).length }));
    return (r.unlocked === true && r.n === r.emoji + 1) || r; }],
  ['Old stored Premium=false (v1 key) is ignored after reload and the old key is removed', async ({ p }) => {
    await wait(1200); await p.evaluate(() => localStorage.setItem('poker_spotify_auth_v1_premium', 'false'));
    await p.reload(); await wait(1500);
    const r = await p.evaluate(() => ({ premium: spotify.premium, old: localStorage.getItem('poker_spotify_auth_v1_premium'), hidden: ['npCtl', 'npSideCtl', 'npBigCtl'].map(i => document.getElementById(i).classList.contains('none')) }));
    return (r.premium !== false && r.old === null && r.hidden.every(h => !h)) || r; }, { spotify: true }],
];

(async () => {
  const srv = (process.env.CLOCK_URL || process.env.CLOCK_BASE) ? null : await require('./serve').start();   /* self-serve the repo */
  const rows = []; let failed = 0;
  for (const bt of [webkit, chromium]) {
    for (const [name, fn, opts] of TESTS.filter(t => !process.env.ONLY || t[0].includes(process.env.ONLY))) {   /* ONLY=<text>: just the checks whose name has it */
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
