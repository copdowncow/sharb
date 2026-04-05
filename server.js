const http = require('http');
const fs   = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const PORT      = 8080;
const ROOT      = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const UPLOADS   = path.join(ROOT, 'uploads');

if (!fs.existsSync(UPLOADS))   fs.mkdirSync(UPLOADS);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ menu: [], terrace: [] }));

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { menu: [], terrace: [] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':'application/javascript',
  '.css':'text/css',
  '.json':'application/json',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.png':'image/png', '.webp':'image/webp',
  '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon',
};

function sendFile(res, fp) {
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

function sendJSON(res, data, status) {
  status = status || 200;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── Multipart parser ──────────────────────────────────────────────────────
function indexOf(buf, needle, from) {
  from = from || 0;
  const bl = buf.length, nl = needle.length;
  outer: for (let i = from; i <= bl - nl; i++) {
    for (let j = 0; j < nl; j++) if (buf[i+j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function parseMultipart(req, done) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', e => done(e, null, null));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      const ct   = req.headers['content-type'] || '';

      // boundary can be quoted or bare
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^\s;,]+))/i);
      if (!bm) return done(new Error('No boundary'), null, null);
      const boundary = (bm[1] || bm[2]).trim();

      const CRLF       = Buffer.from('\r\n');
      const CRLFCRLF   = Buffer.from('\r\n\r\n');
      const delimStart = Buffer.from('--' + boundary + '\r\n');
      const delim      = Buffer.from('\r\n--' + boundary);

      const fields = {};
      let fileBuf = null, fileName = null, fileMime = 'application/octet-stream';

      // find start of first part
      let pos = indexOf(body, delimStart);
      if (pos === -1) return done(new Error('First boundary not found'), null, null);
      pos += delimStart.length;

      while (pos < body.length) {
        // find end of this part (next delimiter)
        let partEnd = indexOf(body, delim, pos);
        if (partEnd === -1) partEnd = body.length;

        const part   = body.slice(pos, partEnd);
        const hdrEnd = indexOf(part, CRLFCRLF);
        if (hdrEnd === -1) break;

        const hdrStr  = part.slice(0, hdrEnd).toString('latin1');
        let   content = part.slice(hdrEnd + 4);

        // trim trailing \r\n from content
        if (content.length >= 2 &&
            content[content.length - 2] === 13 &&
            content[content.length - 1] === 10) {
          content = content.slice(0, -2);
        }

        const dMatch = hdrStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
        const fMatch = hdrStr.match(/filename="([^"]*)"/i);
        const cMatch = hdrStr.match(/Content-Type:\s*([^\r\n]+)/i);

        if (dMatch) {
          if (fMatch) {
            fileName = fMatch[1];
            fileMime = cMatch ? cMatch[1].trim() : 'application/octet-stream';
            fileBuf  = content;
          } else {
            fields[dMatch[1]] = content.toString('utf8');
          }
        }

        pos = partEnd + delim.length;
        if (pos >= body.length) break;
        if (body[pos] === 45 && body[pos+1] === 45) break; // '--' = end
        pos += 2; // skip \r\n between parts
      }

      done(null, fields, fileBuf ? { data: fileBuf, name: fileName, mime: fileMime } : null);
    } catch (e) {
      console.error('[multipart] error:', e.message);
      done(e, null, null);
    }
  });
}

// ── Request handler ───────────────────────────────────────────────────────
function handle(req, res) {
  // Safe URL parse
  let pathname = '/';
  let searchParams = new URLSearchParams();
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname     = u.pathname;
    searchParams = u.searchParams;
  } catch (e) {
    res.writeHead(400); return res.end('Bad request');
  }

  const method = req.method || 'GET';
  const type   = searchParams.get('type') || 'menu';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Pages
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, path.join(ROOT, 'index.html'));
  }
  if (pathname === '/admin' || pathname === '/admin.html') {
    return sendFile(res, path.join(ROOT, 'admin.html'));
  }

  // Uploaded images
  if (pathname.startsWith('/uploads/')) {
    const safe = path.basename(pathname); // prevent path traversal
    return sendFile(res, path.join(UPLOADS, safe));
  }

  // GET /api/items
  if (method === 'GET' && pathname === '/api/items') {
    return sendJSON(res, readData()[type] || []);
  }

  // POST /api/items
  if (method === 'POST' && pathname === '/api/items') {
    return parseMultipart(req, (err, fields, file) => {
      if (err) {
        console.error('[POST] parse error:', err.message);
        return sendJSON(res, { error: err.message }, 400);
      }

      try {
        const data = readData();
        const id   = randomBytes(8).toString('hex');
        let   photoUrl = null;

        if (file && file.data && file.data.length > 0) {
          const ext  = (path.extname(file.name || '') || '.jpg').toLowerCase();
          const name = id + ext;
          fs.writeFileSync(path.join(UPLOADS, name), file.data);
          photoUrl = '/uploads/' + name;
          console.log('[+] photo:', name, file.data.length + 'b');
        }

        const item = {
          id,
          nameRu:    (fields.nameRu   || '').trim(),
          nameEn:    (fields.nameEn   || '').trim(),
          descRu:    (fields.descRu   || '').trim(),
          descEn:    (fields.descEn   || '').trim(),
          price:     (fields.price    || '').trim(),
          category:  (fields.category || 'main').trim(),
          photo:     photoUrl,
          createdAt: new Date().toISOString(),
        };

        if (!data[type]) data[type] = [];
        data[type].unshift(item);
        saveData(data);
        console.log('[+] added:', item.nameRu || item.nameEn || id, '→', type);
        return sendJSON(res, item, 201);
      } catch (e) {
        console.error('[POST] save error:', e.message);
        return sendJSON(res, { error: e.message }, 500);
      }
    });
  }

  // DELETE /api/items/:id
  if (method === 'DELETE' && pathname.startsWith('/api/items/')) {
    try {
      const id   = path.basename(pathname);
      const data = readData();
      const arr  = data[type] || [];
      const item = arr.find(i => i.id === id);
      if (item && item.photo) {
        const fp = path.join(UPLOADS, path.basename(item.photo));
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      data[type] = arr.filter(i => i.id !== id);
      saveData(data);
      console.log('[-] deleted:', id);
      return sendJSON(res, { ok: true });
    } catch (e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }

  res.writeHead(404); res.end('Not found');
}

http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    console.error('[server] unhandled error:', e.message);
    try { res.writeHead(500); res.end('Server error'); } catch (_) {}
  }
}).listen(PORT, () => {
  console.log('\n  ✦  Sharbat  →  http://localhost:' + PORT);
  console.log('  ✦  Admin   →  http://localhost:' + PORT + '/admin\n');
});
