import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;
const FX_FALLBACK = 25;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

let fxCache = {
  rate: FX_FALLBACK,
  fetchedAt: 0
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

function parsePrice(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = String(value).replace(/[^\d.,-]/g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLdJsonBlocks(html) {
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let match;

  while ((match = regex.exec(html)) !== null) {
    blocks.push(match[1]);
  }

  return blocks;
}

function flattenJson(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap(flattenJson);
  }

  if (typeof input === 'object') {
    const nested = [];
    if (input.itemListElement) nested.push(...flattenJson(input.itemListElement));
    if (input.mainEntity) nested.push(...flattenJson(input.mainEntity));
    if (input.hasPart) nested.push(...flattenJson(input.hasPart));
    if (input['@graph']) nested.push(...flattenJson(input['@graph']));
    if (input.item) nested.push(...flattenJson(input.item));
    if (input.offers) nested.push(...flattenJson(input.offers));
    return [input, ...nested];
  }

  return [];
}

function pickProductFromLdJson(html, itemId) {
  const blocks = extractLdJsonBlocks(html);

  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw);
      const nodes = flattenJson(parsed);

      for (const node of nodes) {
        const textIndex = [
          node.productID,
          node.sku,
          node.mpn,
          node.identifier,
          node.url,
          node.name
        ]
          .filter(Boolean)
          .join(' ');

        const looksLikeMatch = textIndex.includes(itemId);
        const hasOffer = Boolean(node.offers?.price || node.price || node.lowPrice);
        if (!looksLikeMatch || !hasOffer) {
          continue;
        }

        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
        return {
          item_id: itemId,
          name: node.name || offer.name || '',
          price: parsePrice(offer.price ?? node.price ?? node.lowPrice),
          currency: offer.priceCurrency || node.priceCurrency || '',
          url: node.url || offer.url || ''
        };
      }
    } catch {
      // ignore malformed ld+json block
    }
  }

  return null;
}

function fallbackPriceFromHtml(html) {
  const priceMatch = html.match(/"price"\s*:\s*"?([\d.,]+)"?/i);
  const currencyMatch = html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/i);

  return {
    price: priceMatch ? parsePrice(priceMatch[1]) : null,
    currency: currencyMatch ? currencyMatch[1] : ''
  };
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DecathlonCompare/1.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}) for ${url}`);
  }

  return response.text();
}

async function findCanadaProduct(itemId) {
  const url = `https://www.decathlon.ca/en/search?query=${encodeURIComponent(itemId)}`;
  const html = await fetchHtml(url);
  const product = pickProductFromLdJson(html, itemId);

  if (product) {
    return { ...product, source: url };
  }

  const fallback = fallbackPriceFromHtml(html);
  if (fallback.price) {
    return {
      item_id: itemId,
      name: '',
      price: fallback.price,
      currency: fallback.currency || 'CAD',
      url,
      source: url
    };
  }

  return null;
}

async function findTurkeyProduct(itemId) {
  const candidateUrls = [
    `https://www.decathlon.com.tr/search?Ntt=${encodeURIComponent(itemId)}`,
    `https://www.decathlon.com.tr/search?query=${encodeURIComponent(itemId)}`
  ];

  for (const url of candidateUrls) {
    try {
      const html = await fetchHtml(url);
      const product = pickProductFromLdJson(html, itemId);
      if (product) {
        return { ...product, source: url };
      }

      const fallback = fallbackPriceFromHtml(html);
      if (fallback.price) {
        return {
          item_id: itemId,
          name: '',
          price: fallback.price,
          currency: fallback.currency || 'TRY',
          url,
          source: url
        };
      }
    } catch {
      // try next URL
    }
  }

  return null;
}

async function getCadTryRate() {
  const now = Date.now();
  const cacheTtlMs = 12 * 60 * 60 * 1000;
  if (now - fxCache.fetchedAt < cacheTtlMs) {
    return fxCache.rate;
  }

  try {
    const response = await fetch('https://open.er-api.com/v6/latest/CAD');
    const data = await response.json();
    const rate = data?.rates?.TRY;
    if (Number.isFinite(rate) && rate > 0) {
      fxCache = { rate, fetchedAt: now };
      return rate;
    }
  } catch {
    // use fallback
  }

  fxCache = { rate: FX_FALLBACK, fetchedAt: now };
  return fxCache.rate;
}

async function compareLiveItem(itemId, cadTryRate) {
  let canada = null;
  let turkey = null;

  try {
    canada = await findCanadaProduct(itemId);
  } catch {
    canada = null;
  }

  try {
    turkey = await findTurkeyProduct(itemId);
  } catch {
    turkey = null;
  }

  if (!canada) {
    return {
      itemId,
      status: 'NOT_FOUND_IN_CANADA',
      message: 'Kanada sitesinde ürün bulunamadı.'
    };
  }

  if (!turkey) {
    return {
      itemId,
      status: 'NOT_SELLING_IN_TURKEY',
      message: 'Bu ürün Türkiye Decathlon sitesinde satılmıyor.',
      canada
    };
  }

  const canadaPriceCad = parsePrice(canada.price);
  const turkeyPriceTry = parsePrice(turkey.price);
  const convertedCanadaTry = Number.isFinite(canadaPriceCad) ? canadaPriceCad * cadTryRate : null;
  const diffTry = Number.isFinite(convertedCanadaTry) && Number.isFinite(turkeyPriceTry)
    ? turkeyPriceTry - convertedCanadaTry
    : null;

  return {
    itemId,
    status: 'MATCHED',
    message: 'Ürün iki ülkede de bulundu.',
    canada,
    turkey,
    comparison: {
      cadTryRate,
      convertedCanadaTry,
      diffTry,
      trend: diffTry === null ? 'UNKNOWN' : diffTry <= 0 ? 'TR_CHEAPER_OR_EQUAL' : 'TR_MORE_EXPENSIVE'
    }
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
    (url.pathname === '/' || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html'))
  ) {
    return serveStatic(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const cadTryRate = await getCadTryRate();
    return json(res, 200, { ok: true, cadTryRate });
  }

  if (req.method === 'POST' && url.pathname === '/api/compare-live') {
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

      const cadTryRate = await getCadTryRate();
      const results = await Promise.all(itemIds.map((itemId) => compareLiveItem(itemId, cadTryRate)));
      return json(res, 200, {
        asOf: new Date().toISOString(),
        cadTryRate,
        results
      });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  return json(res, 404, { error: 'Route not found' });
});

server.listen(PORT, () => {
  console.log(`Decathlon live comparer running at http://localhost:${PORT}`);
});
