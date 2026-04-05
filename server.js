const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const PORT = 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const UPLOADS_DIR = path.join(ROOT, 'uploads');

// Create uploads dir if needed
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Init data file
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ menu: [], terrace: [] }));
}

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { menu: [], terrace: [] }; }
}
function writeData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

// ─── Multipart parser (no deps) ───
function parseMultipart(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)$/);
    if (!bm) return cb(new Error('no boundary'), null, null);

    const boundary = Buffer.from('--' + bm[1]);
    const fields = {};
    let fileData = null, fileName = null, fileMime = null;

    const parts = splitBuf(body, boundary);
    for (const part of parts) {
      if (!part.length) continue;
      const sep = Buffer.from('\r\n\r\n');
      const hi = indexOfBuf(part, sep);
      if (hi === -1) continue;
      const header = part.slice(0, hi).toString();
      let data = part.slice(hi + 4);
      if (data.slice(-2).toString() === '\r\n') data = data.slice(0, -2);

      const nm = header.match(/name="([^"]+)"/i);
      const fm = header.match(/filename="([^"]+)"/i);
      const mm = header.match(/Content-Type:\s*([^\r\n]+)/i);
      if (!nm) continue;

      if (fm) {
        fileName = fm[1];
        fileMime = mm ? mm[1].trim() : 'application/octet-stream';
        fileData = data;
      } else {
        fields[nm[1]] = data.toString();
      }
    }
    cb(null, fields, fileData ? { data: fileData, name: fileName, mime: fileMime } : null);
  });
}

function splitBuf(buf, sep) {
  const parts = []; let s = 0;
  while (true) {
    const i = indexOfBuf(buf, sep, s);
    if (i === -1) { parts.push(buf.slice(s)); break; }
    parts.push(buf.slice(s, i));
    s = i + sep.length;
    if (buf[s] === 13 && buf[s+1] === 10) s += 2;
  }
  return parts;
}

function indexOfBuf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let ok = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i+j] !== search[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

// ─── Server ───
http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const p    = url.pathname;
  const type = url.searchParams.get('type') || 'menu';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── Routes ──

  if (p === '/' || p === '/index.html') {
    return serveFile(res, path.join(ROOT, 'index.html'));
  }

  if (p === '/admin' || p === '/admin.html') {
    return serveFile(res, path.join(ROOT, 'admin.html'));
  }

  // Serve uploads
  if (p.startsWith('/uploads/')) {
    return serveFile(res, path.join(ROOT, p.slice(1)));
  }

  // GET /api/items
  if (req.method === 'GET' && p === '/api/items') {
    const data = readData();
    return json(res, data[type] || []);
  }

  // POST /api/items
  if (req.method === 'POST' && p === '/api/items') {
    return parseMultipart(req, (err, fields, file) => {
      if (err) return json(res, { error: err.message }, 400);

      const data = readData();
      const id   = randomBytes(8).toString('hex');
      let photoUrl = null;

      if (file && file.data && file.data.length > 0) {
        const ext  = (path.extname(file.name || '') || '.jpg').toLowerCase();
        const name = `${id}${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, name), file.data);
        photoUrl = `/uploads/${name}`;
      }

      const item = {
        id,
        nameRu:   fields.nameRu   || '',
        nameEn:   fields.nameEn   || '',
        descRu:   fields.descRu   || '',
        descEn:   fields.descEn   || '',
        price:    fields.price    || '',
        category: fields.category || 'main',
        photo:    photoUrl,
        createdAt: new Date().toISOString(),
      };

      if (!data[type]) data[type] = [];
      data[type].unshift(item);
      writeData(data);
      return json(res, item, 201);
    });
  }

  // DELETE /api/items/:id
  if (req.method === 'DELETE' && p.startsWith('/api/items/')) {
    const id   = p.split('/').pop();
    const data = readData();
    const arr  = data[type] || [];
    const item = arr.find(i => i.id === id);
    if (item && item.photo) {
      const fp = path.join(ROOT, item.photo.replace(/^\//, ''));
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    data[type] = arr.filter(i => i.id !== id);
    writeData(data);
    return json(res, { ok: true });
  }

  res.writeHead(404); res.end('Not found');

}).listen(PORT, () => {
  console.log(`\n  ✦  Sharbat  →  http://localhost:${PORT}`);
  console.log(`  ✦  Admin   →  http://localhost:${PORT}/admin\n`);
});
