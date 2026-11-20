/* Tiny static server for the tests: serves the repo root on http://localhost:8791/ (or PORT).
 * The tests start it themselves, so no separate server is needed (the Claude app's preview
 * server isn't allowed to read Google Drive folders on this Mac). */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml' };
function start(port = +(process.env.PORT || 8791)) {
  return new Promise((ok, bad) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
      });
    });
    srv.on('error', (e) => e.code === 'EADDRINUSE' ? ok(null) : bad(e));   /* something already serves it: use that */
    srv.listen(port, () => ok(srv));
  });
}
module.exports = { start };
if (require.main === module) start().then(s => console.log(s ? 'serving ' + ROOT + ' on :8791' : 'port 8791 already in use'));
