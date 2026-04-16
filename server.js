const http = require('http');
const fs   = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

// 🔥 ВАЖНО: порт для Railway
const PORT      = process.env.PORT || 8080;

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

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── Multipart parser ─────────────────────────
function indexOf(buf, needle, from = 0) {
  outer: for (let i = from; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseMultipart(req, done) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      const ct   = req.headers['content-type'] || '';

      const bm = ct.match(/boundary=(?:"([^"]+)"|([^\s;,]+))/i);
      if (!bm) return done(new Error('No boundary'), null, null);

      const boundary = (bm[1] || bm[2]).trim();
      const CRLFCRLF = Buffer.from('\r\n\r\n');
      const delimStart = Buffer.from('--' + boundary + '\r\n');
      const delim = Buffer.from('\r\n--' + boundary);

      const fields = {};
      let fileBuf = null, fileName = null, fileMime = 'application/octet-stream';

      let pos = indexOf(body, delimStart);
      if (pos === -1) return done(new Error('Boundary not found'), null, null);
      pos += delimStart.length;

      while (pos < body.length) {
        let partEnd = indexOf(body, delim, pos);
        if (partEnd === -1) partEnd = body.length;

        const part   = body.slice(pos, partEnd);
        const hdrEnd = indexOf(part, CRLFCRLF);
        if (hdrEnd === -1) break;

        const hdrStr  = part.slice(0, hdrEnd).toString('latin1');
        let content = part.slice(hdrEnd + 4);

        if (content.length >= 2 &&
            content[content.length - 2] === 13 &&
            content[content.length - 1] === 10) {
          content = content.slice(0, -2);
        }

        const dMatch = hdrStr.match(/name="([^"]+)"/);
        const fMatch = hdrStr.match(/filename="([^"]*)"/);
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
        if (body[pos] === 45 && body[pos+1] === 45) break;
        pos += 2;
      }

      done(null, fields, fileBuf ? { data: fileBuf, name: fileName, mime: fileMime } : null);
    } catch (e) {
      done(e, null, null);
    }
  });
}

// ── Request handler ─────────────────────────
function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  const method = req.method;
  const type = u.searchParams.get('type') || 'menu';

  // 🔥 тестовый корень (важно)
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>Sharbat works 🚀</h1>');
  }

  if (pathname === '/admin') {
    return sendFile(res, path.join(ROOT, 'admin.html'));
  }

  if (pathname.startsWith('/uploads/')) {
    return sendFile(res, path.join(UPLOADS, path.basename(pathname)));
  }

  if (method === 'GET' && pathname === '/api/items') {
    return sendJSON(res, readData()[type] || []);
  }

  if (method === 'POST' && pathname === '/api/items') {
    return parseMultipart(req, (err, fields, file) => {
      if (err) return sendJSON(res, { error: err.message }, 400);

      const data = readData();
      const id   = randomBytes(8).toString('hex');

      let photoUrl = null;
      if (file) {
        const ext  = path.extname(file.name || '') || '.jpg';
        const name = id + ext;
        fs.writeFileSync(path.join(UPLOADS, name), file.data);
        photoUrl = '/uploads/' + name;
      }

      const item = {
        id,
        nameRu: fields.nameRu || '',
        nameEn: fields.nameEn || '',
        descRu: fields.descRu || '',
        descEn: fields.descEn || '',
        price:  fields.price || '',
        category: fields.category || 'main',
        photo: photoUrl,
        createdAt: new Date().toISOString(),
      };

      data[type].unshift(item);
      saveData(data);
      return sendJSON(res, item, 201);
    });
  }

  res.writeHead(404);
  res.end('Not found');
}

// 🚀 запуск
http.createServer(handle).listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
