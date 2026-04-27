import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;

const catalogs = {
  ca: new Map(),
  tr: new Map()
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, statusCode, data) {
  setCors(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function normalizeId(value) {
  return String(value || '').trim();
}

function parseCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const index = Object.fromEntries(headers.map((h, i) => [h, i]));

  if (index.item_id === undefined) {
    throw new Error('CSV must include item_id column');
  }

  return lines
    .slice(1)
    .map((line) => {
      const cols = line.split(',').map((col) => col.trim());
      return {
        item_id: normalizeId(cols[index.item_id]),
        name: cols[index.name] || '',
        price: cols[index.price] || '',
        currency: cols[index.currency] || '',
        url: cols[index.url] || ''
      };
    })
    .filter((row) => row.item_id);
}

function parseMultipartCsv(req, bodyBuffer) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) {
    throw new Error('Invalid multipart request');
  }

  const boundary = `--${boundaryMatch[1]}`;
  const body = bodyBuffer.toString('utf-8');
  const parts = body.split(boundary).map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.includes('name="file"')) {
      const splitToken = '\r\n\r\n';
      const idx = part.indexOf(splitToken);
      if (idx === -1) {
        continue;
      }
      const fileContent = part.slice(idx + splitToken.length).replace(/\r\n--$/, '').trim();
      return fileContent;
    }
  }

  throw new Error('File field not found in multipart request');
}

function compareItemId(itemId) {
  const caItem = catalogs.ca.get(itemId);
  const trItem = catalogs.tr.get(itemId);

  if (!caItem) {
    return {
      itemId,
      status: 'NOT_FOUND_IN_CANADA',
      message: 'Item was not found in Canada catalog.'
    };
  }

  if (!trItem) {
    return {
      itemId,
      status: 'NOT_SELLING_IN_TURKEY',
      message: 'This item is not selling in Turkey.',
      canada: caItem
    };
  }

  return {
    itemId,
    status: 'MATCHED',
    message: 'Item is available in both Canada and Turkey.',
    canada: caItem,
    turkey: trItem
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = join(process.cwd(), 'public', pathname);
  const ext = extname(filePath);

  try {
    const content = await readFile(filePath);
    setCors(res);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (
    req.method === 'GET' &&
    (url.pathname === '/' || url.pathname.startsWith('/public') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html'))
  ) {
    return serveStatic(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/catalog/status') {
    return json(res, 200, {
      canadaCount: catalogs.ca.size,
      turkeyCount: catalogs.tr.size
    });
  }

  if (req.method === 'POST' && (url.pathname === '/api/catalog/ca' || url.pathname === '/api/catalog/tr')) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    try {
      const csvText = parseMultipartCsv(req, Buffer.concat(chunks));
      const parsed = parseCsv(csvText);
      const key = url.pathname.endsWith('/ca') ? 'ca' : 'tr';

      catalogs[key].clear();
      for (const row of parsed) {
        catalogs[key].set(row.item_id, row);
      }

      return json(res, 200, {
        message: `${key.toUpperCase()} catalog uploaded successfully`,
        itemCount: catalogs[key].size
      });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/compare') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(normalizeId).filter(Boolean) : [];

      if (!itemIds.length) {
        return json(res, 400, { error: 'itemIds must be a non-empty array' });
      }

      const results = itemIds.map(compareItemId);
      return json(res, 200, { results });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  return json(res, 404, { error: 'Route not found' });
});

server.listen(PORT, () => {
  console.log(`Decathlon comparer running at http://localhost:${PORT}`);
});
