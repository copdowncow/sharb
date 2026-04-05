const http = require('http');
const fs   = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const PORT      = 3000;
const ROOT      = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const UPLOADS   = path.join(ROOT, 'uploads');

if (!fs.existsSync(UPLOADS))   fs.mkdirSync(UPLOADS);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ menu: [], terrace: [] }));

// ── helpers ──────────────────────────────────────────────────────────────
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { menu: [], terrace: [] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif',
  '.svg':'image/svg+xml', '.ico':'image/x-icon',
};

function sendFile(res, fp) {
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

// ── Robust multipart parser ───────────────────────────────────────────────
function bufIndexOf(haystack, needle, offset) {
  offset = offset || 0;
  const hl = haystack.length;
  const nl = needle.length;
  outer: for (let i = offset; i <= hl - nl; i++) {
    for (let j = 0; j < nl; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
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

      // Extract boundary — handle both quoted and unquoted forms
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
      if (!bm) return done(new Error('No boundary found in Content-Type'), null, null);
      const boundary = bm[1] || bm[2];

      const fields  = {};
      let   fileBuf = null, fileName = null, fileMime = 'application/octet-stream';

      // Split on \r\n--<boundary>  (RFC 2046)
      const delim     = Buffer.from('\r\n--' + boundary);
      const firstLine = Buffer.from('--' + boundary + '\r\n');

      // Find where first part body starts
      let pos = bufIndexOf(body, firstLine);
      if (pos === -1) return done(new Error('Cannot find first boundary'), null, null);
      pos += firstLine.length;

      while (pos < body.length) {
        // End of this part
        let partEnd = bufIndexOf(body, delim, pos);
        if (partEnd === -1) partEnd = body.length; // last part, no trailing CRLF delim

        const part    = body.slice(pos, partEnd);
        const hdrSep  = bufIndexOf(part, Buffer.from('\r\n\r\n'));
        if (hdrSep === -1) break;

        const headers  = part.slice(0, hdrSep).toString('latin1');
        let   content  = part.slice(hdrSep + 4);

        // Strip trailing \r\n from content
        if (content.length >= 2 &&
            content[content.length - 2] === 13 &&
            content[content.length - 1] === 10) {
          content = content.slice(0, -2);
        }

        // Parse headers
        const dispMatch  = headers.match(/Content-Disposition:[^\r\n]*;\s*name="([^"]+)"/i);
        const fileMatch  = headers.match(/;\s*filename="([^"]*)"/i);
        const ctMatch    = headers.match(/Content-Type:\s*([^\r\n]+)/i);

        if (!dispMatch) { pos = partEnd + delim.length + 2; continue; }
        const name = dispMatch[1];

        if (fileMatch) {
          fileName = fileMatch[1];
          fileMime = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
          fileBuf  = content;
        } else {
          fields[name] = content.toString('utf8');
        }

        // Advance past delimiter
        pos = partEnd + delim.length;
        if (pos >= body.length) break;

        // Next two bytes are either \r\n (more parts) or -- (epilogue)
        if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // final --
        pos += 2; // skip \r\n between parts
      }

      done(null, fields, fileBuf ? { data: fileBuf, name: fileName, mime: fileMime } : null);
    } catch (e) {
      console.error('parseMultipart exception:', e);
      done(e, null, null);
    }
  });
}

// ── Server ────────────────────────────────────────────────────────────────
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

  // ── Static pages ──
  if (p === '/' || p === '/index.html')     return sendFile(res, path.join(ROOT, 'index.html'));
  if (p === '/admin' || p === '/admin.html') return sendFile(res, path.join(ROOT, 'admin.html'));

  // ── Uploaded files ──
  if (p.startsWith('/uploads/')) {
    return sendFile(res, path.join(UPLOADS, path.basename(p)));
  }

  // ── GET /api/items ──
  if (req.method === 'GET' && p === '/api/items') {
    return sendJSON(res, (readData()[type] || []));
  }

  // ── POST /api/items ──
  if (req.method === 'POST' && p === '/api/items') {
    return parseMultipart(req, (err, fields, file) => {
      if (err) {
        console.error('Upload error:', err.message);
        return sendJSON(res, { error: err.message }, 400);
      }

      const data = readData();
      const id   = randomBytes(8).toString('hex');
      let   photoUrl = null;

      if (file && file.data && file.data.length > 0) {
        const ext  = (path.extname(file.name || '') || '.jpg').toLowerCase();
        const safe = id + ext;
        fs.writeFileSync(path.join(UPLOADS, safe), file.data);
        photoUrl = '/uploads/' + safe;
        console.log('[+] photo saved:', safe, '(' + file.data.length + ' bytes)');
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
      console.log('[+] item added:', item.nameRu || item.nameEn, '→', type);
      return sendJSON(res, item, 201);
    });
  }

  // ── DELETE /api/items/:id ──
  if (req.method === 'DELETE' && p.startsWith('/api/items/')) {
    const id   = path.basename(p);
    const data = readData();
    const arr  = data[type] || [];
    const item = arr.find(i => i.id === id);
    if (item && item.photo) {
      const fp = path.join(UPLOADS, path.basename(item.photo));
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log('[-] deleted file:', path.basename(fp)); }
    }
    data[type] = arr.filter(i => i.id !== id);
    saveData(data);
    console.log('[-] item deleted:', id);
    return sendJSON(res, { ok: true });
  }

  res.writeHead(404); res.end('Not found');

}).listen(PORT, () => {
  console.log('\n  ✦  Sharbat  →  http://localhost:' + PORT);
  console.log('  ✦  Admin   →  http://localhost:' + PORT + '/admin\n');
});
