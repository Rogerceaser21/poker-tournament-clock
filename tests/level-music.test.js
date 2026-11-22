/* Poker Tournament Clock — level change + music checks (PREVIEW, round D). Ported from the investigator's probe
 * (/Users/igor/wt/poker-preview-logs/investigate-level/probe.js): a stateful fake Spotify plus an iPad audio-session model.
 *
 *   run (serves the repo itself on :8791):   NODE_PATH=<node_modules with playwright> node tests/level-music.test.js
 *   ONLY=<text>     just the scenarios whose name has it
 *   CLOCK_URL=…     another page (control: an older preview copy)
 *
 * iPad model:
 *   - PREVIEW (22 Nov rule): Spotify left paused longer than FREEZE falls asleep: every later play = 404, until a transfer
 *     playback (PUT /me/player, play: true) wakes it. FREEZE was 3.5 s (an assumption); Igor's real iPad (run mwrwlvfg,
 *     22 Nov, ipad-run2-tables.md table 2) came back by a plain play after every pause up to 15 s, so FREEZE = 15 s now.
 *   - a non-muted sound that starts while navigator.audioSession.type === 'playback' and Spotify is playing (no pause
 *     sent) = iPadOS stops Spotify ("OS-INTERRUPT"); nothing in the clock knows.
 * After EVERY scenario: (i) Spotify ends playing (unless the user had paused it); (ii) every pause Spotify carried out is
 * followed by a play sent ≤ 10 s (CAP) + 2.6 s (the longest sound) + 1.5 s (the longest wait for a pause answer) + 0.5 s
 * after the pause was sent (was 2850 ms: the 22 Nov rule holds the pause until the last sound ended); (iii) no sound starts
 * in 'playback' while Spotify plays; (iv) the session ends 'ambient' (nothing sounds); (v) user paused → no pause / play
 * calls at all; (vi) PREVIEW: every clock sound starts with the session 'playback' (one way of playing, never over the music).
 * Chromium (muted), iPad user agent. Prints a table; exits 1 on any failure.
 */
const { chromium } = require('playwright');
const PAGE = process.env.CLOCK_URL || 'http://localhost:8791/preview/Poker%20Tournament%20Clock.html';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FREEZE = 15000, CAP = 10000 + 2600 + 1500 + 500;
const wait = ms => new Promise(r => setTimeout(r, ms));
const LEVELS = [[5, 10], [10, 20], [20, 40], [30, 60], [50, 100], [100, 200]].map(([sb, bb], i) => ({ id: 'L' + (i + 1), sb, bb, mins: 20 }));

async function setup(browser, opt = {}){
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, userAgent: IPAD_UA });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
  const calls = [];   /* every pause / play call: { c, t (sent), st } */
  const fake = { playing: !opt.userPaused && !opt.noSpotify, asleep: false, pausedAt: opt.userPaused ? Date.now() - 60000 : 0, staleMs: opt.staleMs || 0, staleUntil: 0,
    rules: { pause: [], play: [], poll: [], token: [] }, interrupts: [], pauses: [], starts: [] };
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith('http://localhost:') || u.startsWith('data:')) return r.continue();
    if (u.includes('api.spotify.com') || u.includes('accounts.spotify.com')) return r.fallback(); return r.abort(); });
  await ctx.route('https://accounts.spotify.com/api/token', async r => {
    const rule = fake.rules.token.shift() || { status: 200 }; if (rule.delay) await wait(rule.delay);
    if (rule.status === 'abort') return r.abort('failed');
    if (rule.status !== 200) return r.fulfill({ status: rule.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"invalid_grant"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ access_token: 'AT2', expires_in: 3600 }) });
  });
  await ctx.route('https://api.spotify.com/v1/**', async r => {
    const u = r.request().url(), pth = u.split('/v1')[1], m = r.request().method(), c = m + ' ' + pth.split('?')[0], t = Date.now();
    const rec = /\/me\/player\/(pause|play)$/.test(c) ? { c: c.endsWith('pause') ? 'pause' : 'play', t, st: null } : null; if (rec) calls.push(rec);
    const fin = async (rule, o) => { if (rule && rule.delay) await wait(rule.delay);
      if (rule && rule.status === 'abort'){ if (rec) rec.st = 0; return r.abort('failed'); }
      if (rec) rec.st = o.status; return r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After', ...(o.status === 429 ? { 'Retry-After': '1' } : {}) }, ...o }); };
    const err = (st, msg) => ({ status: st, contentType: 'application/json', body: JSON.stringify({ error: { status: st, message: msg || 'x', reason: 'UNKNOWN' } }) });
    if (pth === '/me') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"display_name":"T"}' });
    if (pth.startsWith('/me/player?')){
      const rule = fake.rules.poll.shift() || null, isP = fake.playing && Date.now() >= fake.staleUntil;
      if (fake.asleep) return fin(rule, { status: 204, body: '' });
      return fin(rule, { status: 200, contentType: 'application/json', body: JSON.stringify({ is_playing: isP, progress_ms: 1000,
        device: { id: 'ipad', type: 'Tablet', volume_percent: 70, supports_volume: false },
        item: { id: 't', name: 'Song', duration_ms: 200000, artists: [{ name: 'A' }], album: { images: [{ url: 'x' }] } } }) });
    }
    if (c === 'PUT /me/player/pause'){
      const rule = fake.rules.pause.shift() || {};
      if (fake.asleep) return fin(rule, err(404, 'No active device'));
      if (!fake.playing) return fin(rule, err(403, 'Player command failed: Restriction violated'));
      if (rule.exec !== false){ fake.playing = false; fake.pausedAt = Date.now(); fake.pauses.push({ sent: t }); }
      if (rule.status && rule.status !== 204) return fin(rule, rule.status === 'abort' ? {} : err(rule.status));
      return fin(rule, { status: 204, body: '' });
    }
    if (c === 'PUT /me/player'){ fake.asleep = false; resumeFake(); fake.transfers = (fake.transfers || 0) + 1; return fin(null, { status: 204, body: '' }); }   /* transfer playback, play: true */
    if (c === 'PUT /me/player/play'){
      const rule = fake.rules.play.shift() || {};
      if (!fake.asleep && !fake.playing && fake.pausedAt && Date.now() - fake.pausedAt > FREEZE) fake.asleep = true;
      if (fake.asleep) return fin(rule, err(404, 'Player command failed: No active device found'));
      if (rule.status && rule.status !== 204){ if (rule.exec) resumeFake(); return fin(rule, rule.status === 'abort' ? {} : err(rule.status, rule.status === 403 ? 'Player command failed: Restriction violated' : 'x')); }
      if (fake.playing) return fin(rule, err(403, 'Player command failed: Restriction violated'));   /* like the real one: play while playing */
      resumeFake(); return fin(rule, { status: 204, body: '' });
    }
    return fin(null, { status: 204, body: '' });
  });
  function resumeFake(){ fake.playing = true; fake.staleUntil = Date.now() + fake.staleMs; }
  await p.exposeBinding('__osPlay', (src, info) => { fake.starts.push(info.session); if (info.session === 'playback' && fake.playing){ fake.playing = false; fake.pausedAt = Date.now(); fake.interrupts.push(info.what + '@' + Date.now()); } });
  await p.addInitScript(() => {
    window.__sess = []; let type = 'auto'; const sess = { get type(){ return type; }, set type(v){ window.__sess.push(v); type = v; } };
    Object.defineProperty(Navigator.prototype, 'audioSession', { get(){ return sess; }, configurable: true });
    const o = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ const what = this.src.startsWith('data:') ? 'BEEP' : this.src.split('/').pop();
      if (!this.muted) window.__osPlay({ what, session: type }); return o.apply(this, arguments); };
  });
  await p.addInitScript(([levels, opt]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.clear();
    const st = { v: 1, levels, names: ['Ann', 'Bob', 'Cat'], buyins: [500, 500, 500], photos: [null, null, null], chips: [700, 700, 700], startStack: 700 };
    if (opt.pauseWithClock) { st.musicPause = true; st.musicPauseUser = true; }
    localStorage.setItem('poker_clock_state_v1', JSON.stringify(st));
    if (!opt.noSpotify){ localStorage.setItem('poker_spotify_auth_v1', JSON.stringify({ access: 'AT', refresh: 'RT', exp: Date.now() + 3e6 })); localStorage.setItem('poker_spotify_premium_v2', 'true'); }
  }, [LEVELS, opt]);
  await p.goto(PAGE); await wait(1200);
  return { ctx, p, fake, calls, errors, marks: [] };
}
const S = {
  start: async p => { await p.click('#startBtn'); await wait(700); },
  expire: p => p.evaluate(() => { clock.deadline = performance.now() + 100; }),
  next: p => p.click('#nextBtn'), prev: p => p.click('#prevBtn'), pause: p => p.click('#pauseBtn'),
  clockPause: async (env) => { env.marks.push(Date.now()); await env.p.click('#pauseBtn'); },   /* ⏸ with "pause music with the clock": that pause is the user's, not a dip */
  emoji: (p, e) => p.evaluate(e => emojiSfx.play(e), e),
  poll: p => p.evaluate(() => { spotify.poll(); }),
};
const toLevel2 = async p => { await S.start(p); await S.expire(p); await wait(5900); };
const SC = [
  ['A1 timer runs out', async ({ p }) => { await toLevel2(p); await wait(3000); await S.expire(p); await wait(9000); }],
  ['A2 ⏭ from a level', async ({ p }) => { await toLevel2(p); await wait(3000); await S.next(p); await wait(9000); }],
  ['A3 ⏭ then ⏭ on Next-up', async ({ p }) => { await toLevel2(p); await wait(3000); await S.next(p); await wait(700); await S.next(p); await wait(9000); }],
  ['A5 ⏭ ⏭ ⏭ 0.5 s apart', async ({ p }) => { await toLevel2(p); await wait(3000); for (let i = 0; i < 3; i++){ await S.next(p); await wait(500); } await wait(9000); }],
  ['A6 ⏭ (Next-up) ⏮ back ⏭ again', async ({ p }) => { await toLevel2(p); await wait(3000); await S.next(p); await wait(700); await S.prev(p); await wait(700); await S.next(p); await wait(9000); }],
  ['B3 pause with clock ON: clock ⏸, then ⏭', async (env) => { const { p } = env; await toLevel2(p); await wait(3000); await S.clockPause(env); await wait(3000); await S.next(p); await wait(9000); }, { pauseWithClock: true }],
  ['B5 pause with clock ON: ⏸, ▶, run-out 1 s later', async (env) => { const { p } = env; await toLevel2(p); await wait(3000); await S.clockPause(env); await wait(3000); await S.pause(p); await wait(300); await p.evaluate(() => { clock.deadline = performance.now() + 700; }); await wait(9000); }, { pauseWithClock: true }],
  ['C1 🔥 0.5 s before the run-out', async ({ p }) => { await toLevel2(p); await wait(3000); await S.emoji(p, '🔥'); await wait(350); await S.expire(p); await wait(9000); }],
  ['C2 🔥 1.5 s before the run-out', async ({ p }) => { await toLevel2(p); await wait(3000); await S.emoji(p, '🔥'); await wait(1350); await S.expire(p); await wait(9000); }],
  ['C3 🔥 3 s before the run-out', async ({ p }) => { await toLevel2(p); await wait(3000); await S.emoji(p, '🔥'); await wait(2850); await S.expire(p); await wait(9000); }],
  ['C5 🔥 during the beep', async ({ p }) => { await toLevel2(p); await wait(3000); await S.expire(p); await wait(950); await S.emoji(p, '🔥'); await wait(9000); }],
  ['D2 Spotify says "not playing" for 1.5 s after our play; level change 4 s after an emoji dip', async ({ p }) => { await toLevel2(p); await wait(3000); await S.emoji(p, '🔥'); await wait(3900); await S.expire(p); await wait(9000); }, { staleMs: 1500 }],
  ['D3 Spotify says "not playing" for 3 s after our play; level change 5 s after an emoji dip', async ({ p }) => { await toLevel2(p); await wait(3000); await S.emoji(p, '🔥'); await wait(4900); await S.expire(p); await wait(9000); }, { staleMs: 3000 }],
  ['F3 pause answered 502 but carried out', async ({ p, fake }) => { await toLevel2(p); await wait(3000); fake.rules.pause.push({ status: 502, exec: true }); await S.expire(p); await wait(9000); }],
  ['F4 pause carried out, answer lost', async ({ p, fake }) => { await toLevel2(p); await wait(3000); fake.rules.pause.push({ status: 'abort', exec: true }); await S.expire(p); await wait(9000); }],
  ['F7 play 404 twice', async ({ p, fake }) => { await toLevel2(p); await wait(3000); fake.rules.play.push({ status: 404 }, { status: 404 }); await S.expire(p); await wait(9000); }],
  ['F9 play 500 three times', async ({ p, fake }) => { await toLevel2(p); await wait(3000); fake.rules.play.push({ status: 500 }, { status: 500 }, { status: 500 }); await S.expire(p); await wait(10000); }],
  ['F12 play 403 (restriction) once', async ({ p, fake }) => { await toLevel2(p); await wait(3000); fake.rules.play.push({ status: 403 }); await S.expire(p); await wait(9000); }],
  ['G3 token refresh refused at the level change', async ({ p, fake }) => { await toLevel2(p); await wait(3000); fake.rules.token.push({ status: 400 }, { status: 400 }); await p.evaluate(() => { spotify.auth.exp = 0; }); await S.expire(p); await wait(9000); }],
  ['G5 token refresh refused by a poll earlier, then the run-out', async ({ p, fake }) => { await toLevel2(p); fake.rules.token.push({ status: 400 }); await p.evaluate(() => { spotify.auth.exp = 0; }); await S.poll(p); await wait(3000); await S.expire(p); await wait(9000); }],
  ['I1 user paused Spotify beforehand', async ({ p }) => { await toLevel2(p); await wait(3000); await S.expire(p); await wait(9000); }, { userPaused: true }],
  ['I2 user pressed play in Spotify 1 s before the run-out (clock not polled yet)', async ({ p, fake }) => { await toLevel2(p); await wait(3000); fake.playing = true; fake.pausedAt = 0; await wait(1000); await S.expire(p); await wait(9000); }, { userPaused: true }],
  ['PLAYS play fails every way (404 / 500 / 403 mixed) → at most musicDip.PLAYS_MAX (9) play calls per resume', async ({ p, fake }) => { await toLevel2(p); await wait(3000);
    fake.rules.play.push(...[404, 500, 404, 404, 403, 500, 404, 500, 500, 500, 500, 500, 500].map(st => ({ status: st }))); await S.expire(p); await wait(12000); }, { playsMax: true }],
  ['N0 no Spotify at all: the beep plays full (playback), no Spotify calls', async ({ p }) => { await S.start(p); await S.expire(p); await wait(4000); }, { noSpotify: true }],
];

(async () => {
  const srv = /^http:\/\/localhost:8791\//.test(PAGE) ? await require('./serve').start() : null;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const rows = []; let failed = 0;
  for (const [name, body, opt = {}] of SC.filter(s => !process.env.ONLY || s[0].includes(process.env.ONLY))){
    const env = await setup(browser, opt); const { p, fake, calls, errors, marks } = env; let detail = '', ok = false;
    try {
      await body(env);
      const st = await p.evaluate(() => ({ session: navigator.audioSession.type, sess: window.__sess, plMax: typeof musicDip !== 'undefined' ? musicDip.PLAYS_MAX : null }));
      const last = calls[calls.length - 1];
      const late = fake.pauses.filter(x => !marks.some(m => x.sent >= m && x.sent - m < 400)).map(x => { const n = calls.find(c => c.c === 'play' && c.t >= x.sent); return n ? n.t - x.sent : Infinity; });
      const pl = calls.filter(c => c.c === 'play').length;
      const userPaused = opt.userPaused && name.startsWith('I1');
      const r = {
        i: userPaused || opt.playsMax || opt.noSpotify || fake.playing,   /* PREVIEW: the last call may be a 403 play (= already playing) or a transfer */
        ii: late.every(v => v <= CAP),
        iii: fake.interrupts.length === 0,
        iv: st.session === 'ambient',
        v: !userPaused || calls.length === 0,
        vi: fake.starts.length > 0 && fake.starts.every(x => x === 'playback'),
        extra: opt.playsMax ? st.plMax === 9 && pl >= 2 && pl <= 9 : opt.noSpotify ? calls.length === 0 && st.sess.includes('playback') : true,
      };
      ok = Object.values(r).every(Boolean) && !errors.length;
      if (!ok) detail = JSON.stringify({ r, playing: fake.playing, calls: calls.map(c => c.c + ':' + c.st), late, interrupts: fake.interrupts, starts: fake.starts, session: st.session, plays: pl, errors });
    } catch (e) { detail = e.message.split('\n')[0]; }
    if (!ok) failed++;
    rows.push((ok ? 'PASS  ' : 'FAIL  ') + 'PREVIEW: level music — ' + name + (detail ? '\n        ' + detail : '')); console.log(rows[rows.length - 1]);
    await env.ctx.close();
  }
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  await browser.close(); if (srv) srv.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
