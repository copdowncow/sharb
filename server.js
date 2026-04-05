const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'items.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// Ensure directories exist
[path.join(__dirname, 'data'), UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Init data file
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ menu: [], terrace: [] }));

// ─── HELPERS ───
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { menu: [], terrace: [] }; }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

// ─── MULTIPART PARSER ───
function parseMultipart(req, callback) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return callback(new Error('No boundary'), null, null);

    const boundary = Buffer.from('--' + boundaryMatch[1]);
    const fields = {};
    let fileData = null;
    let fileName = null;
    let fileMime = null;

    const parts = splitBuffer(body, boundary);
    for (const part of parts) {
      if (!part.length || part.equals(Buffer.from('--\r\n')) || part.equals(Buffer.from('--'))) continue;
      const crlfcrlf = Buffer.from('\r\n\r\n');
      const idx = indexOfBuffer(part, crlfcrlf);
      if (idx === -1) continue;
      const headerBuf = part.slice(0, idx).toString();
      let dataBuf = part.slice(idx + 4);
      if (dataBuf.slice(-2).toString() === '\r\n') dataBuf = dataBuf.slice(0, -2);

      const dispMatch = headerBuf.match(/Content-Disposition:.*name="([^"]+)"/i);
      const fileMatch = headerBuf.match(/filename="([^"]+)"/i);
      const mimeMatch = headerBuf.match(/Content-Type:\s*([^\r\n]+)/i);

      if (!dispMatch) continue;
      const fieldName = dispMatch[1];

      if (fileMatch) {
        fileName = fileMatch[1];
        fileMime = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
        fileData = dataBuf;
      } else {
        fields[fieldName] = dataBuf.toString();
      }
    }
    callback(null, fields, fileData ? { data: fileData, name: fileName, mime: fileMime } : null);
  });
}

function splitBuffer(buf, sep) {
  const parts = []; let start = 0;
  while (true) {
    const idx = indexOfBuffer(buf, sep, start);
    if (idx === -1) { parts.push(buf.slice(start)); break; }
    parts.push(buf.slice(start, idx));
    start = idx + sep.length;
    if (buf[start] === 13 && buf[start+1] === 10) start += 2;
  }
  return parts;
}

function indexOfBuffer(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) { if (buf[i+j] !== search[j]) { found = false; break; } }
    if (found) return i;
  }
  return -1;
}

// ─── REQUEST HANDLER ───
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // Serve /admin
  if (pathname === '/admin' || pathname === '/admin/') {
    const adminPath = path.join(PUBLIC_DIR, 'admin.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return fs.createReadStream(adminPath).pipe(res);
  }

  // API routes
  if (pathname.startsWith('/api/')) {

    // GET /api/items?type=menu|terrace
    if (req.method === 'GET' && pathname === '/api/items') {
      const type = url.searchParams.get('type') || 'menu';
      const data = readData();
      return json(res, data[type] || []);
    }

    // POST /api/items?type=menu|terrace
    if (req.method === 'POST' && pathname === '/api/items') {
      const type = url.searchParams.get('type') || 'menu';
      return parseMultipart(req, (err, fields, file) => {
        if (err) return json(res, { error: err.message }, 400);

        const data = readData();
        const id = randomBytes(8).toString('hex');
        let photoUrl = null;

        if (file && file.data && file.data.length > 0) {
          const ext = path.extname(file.name || '.jpg') || '.jpg';
          const filename = `${id}${ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.data);
          photoUrl = `/uploads/${filename}`;
        }

        const item = {
          id,
          nameRu: fields.nameRu || '',
          nameEn: fields.nameEn || '',
          descRu: fields.descRu || '',
          descEn: fields.descEn || '',
          price: fields.price || '',
          category: fields.category || 'main',
          photo: photoUrl,
          createdAt: new Date().toISOString(),
        };

        if (!data[type]) data[type] = [];
        data[type].unshift(item);
        writeData(data);
        return json(res, item, 201);
      });
    }

    // DELETE /api/items/:id?type=menu|terrace
    if (req.method === 'DELETE' && pathname.startsWith('/api/items/')) {
      const id = pathname.split('/').pop();
      const type = url.searchParams.get('type') || 'menu';
      const data = readData();
      const arr = data[type] || [];
      const item = arr.find(i => i.id === id);
      if (item && item.photo) {
        const filePath = path.join(PUBLIC_DIR, item.photo);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      data[type] = arr.filter(i => i.id !== id);
      writeData(data);
      return json(res, { ok: true });
    }

    return json(res, { error: 'Not found' }, 404);
  }

  // Static files
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  ✦ Sharbat running at http://localhost:${PORT}`);
  console.log(`  ✦ Admin panel at  http://localhost:${PORT}/admin\n`);
});

