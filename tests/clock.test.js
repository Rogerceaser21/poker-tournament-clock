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

async function newPage(browserType, { spotify = false } = {}) {
  const b = await browserType.launch();
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, userAgent: browserType === webkit ? IPAD_UA : undefined, hasTouch: browserType === webkit });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  const spotifyCalls = [];
  await ctx.route('https://api.spotify.com/v1/**', r => {
    const u = r.request().url(), path = u.split('/v1')[1], m = r.request().method();
    if (!path.startsWith('/me/player?')) spotifyCalls.push(m + ' ' + path.split('?')[0]);
    if (path === '/me') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"display_name":"Test"}' });
    if (path.startsWith('/me/player?')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ is_playing: true, progress_ms: 1000,
      device: { id: 'ipad', type: 'Tablet', volume_percent: 70, supports_volume: false },
      item: { id: 't', name: 'Song', duration_ms: 200000, artists: [{ name: 'Artist' }], album: { images: [{ url: 'x' }] } } }) });
    return r.fulfill({ status: 204, body: '' });
  });
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
  return { b, p, errors, spotifyCalls };
}
const state = p => p.evaluate(() => {
  const sl = presentation.slides[presentation.current], type = sl.dataset.type || (sl.id || (presentation.current === 0 ? 'cover' : 'other'));
  const left = clock.el ? Math.round((clock.paused ? clock.remaining : clock.deadline - performance.now()) / 1000) : null;
  return { type, level: sl.querySelector('.lv') ? sl.querySelector('.lv').textContent : (sl.querySelector('.trans-level') || {}).textContent || '',
    left, full: clock.el ? Math.round(clock.duration / 1000) : null, paused: clock.paused, alerts: window.__alerts, sounds: window.__sounds };
});
const press = async (p, sel) => { await p.click(sel); await wait(650); };
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
    await p.click('#startBtn'); await wait(700); await press(p, '#nextBtn');
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
    await wait(1200); await p.click('#startBtn'); await wait(700); spotifyCalls.length = 0; await press(p, '#nextBtn'); await wait(2400);
    const calls = spotifyCalls.filter(c => /pause|play$/.test(c));
    return (calls[0] === 'PUT /me/player/pause' && calls[1] === 'PUT /me/player/play' && calls.length === 2) || { calls }; }, { spotify: true }],
];

(async () => {
  const srv = (process.env.CLOCK_URL || process.env.CLOCK_BASE) ? null : await require('./serve').start();   /* self-serve the repo */
  const rows = []; let failed = 0;
  for (const bt of [webkit, chromium]) {
    for (const [name, fn, opts] of TESTS) {
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
