/**
 * Tiny local HTTPS server for the Fitness Tracker.
 * GPS + DeviceMotion APIs require a secure context (HTTPS or localhost).
 *
 * Run:  node server.js
 * Then open:  http://localhost:3000
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext    = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅  Fitness Tracker running at http://localhost:${PORT}\n`);
  console.log('   Open this URL in your browser (Chrome/Edge recommended).');
  console.log('   For mobile: connect your phone to the same Wi-Fi,');
  console.log('   then open http://<your-computer-ip>:3000\n');
});
