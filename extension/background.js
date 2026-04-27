const DEFAULTS = {
  cadToTryRate: 25
};

const TR_BASE = 'https://www.decathlon.com.tr';
const POSITIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();
const inflight = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => existing[key] === undefined)
  );
  if (Object.keys(missing).length) {
    await chrome.storage.sync.set(missing);
  }
});

async function fetchVtex(query, itemId) {
  const url = `${TR_BASE}/api/catalog_system/pub/products/search?${query}${encodeURIComponent(itemId)}`;
  console.debug('[dc-tr-compare] VTEX', url);
  const response = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    console.debug('[dc-tr-compare] VTEX status', response.status, url);
    return null;
  }
  return response.json();
}

function pickVtexProduct(products) {
  if (!Array.isArray(products) || !products.length) return null;
  const product = products[0];
  const sku = product.items?.[0];
  const offer = sku?.sellers?.find((s) => s?.commertialOffer?.IsAvailable)?.commertialOffer
    || sku?.sellers?.[0]?.commertialOffer;
  if (!offer) return null;
  return {
    name: product.productName || sku?.name || '',
    price: typeof offer.Price === 'number' ? offer.Price : null,
    listPrice: typeof offer.ListPrice === 'number' ? offer.ListPrice : null,
    available: Boolean(offer.IsAvailable ?? offer.AvailableQuantity > 0),
    currency: 'TRY',
    url: product.link
      ? product.link
      : product.linkText
        ? `${TR_BASE}/${product.linkText}/p`
        : `${TR_BASE}/?_q=${encodeURIComponent(product.productReference || '')}`
  };
}

function parseJsonLdFromHtml(html) {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of scripts) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    let data;
    try {
      data = JSON.parse(inner);
    } catch {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const entry of candidates) {
      const types = Array.isArray(entry?.['@type']) ? entry['@type'] : [entry?.['@type']];
      if (!types.includes('Product')) continue;
      const offers = Array.isArray(entry.offers) ? entry.offers[0] : entry.offers;
      const price = Number(offers?.price ?? offers?.lowPrice);
      if (!Number.isFinite(price)) continue;
      return {
        name: entry.name || '',
        price,
        listPrice: null,
        available: (offers?.availability || '').toString().toLowerCase().includes('instock'),
        currency: offers?.priceCurrency || 'TRY',
        url: entry.url || offers?.url || ''
      };
    }
  }
  return null;
}

async function fetchTrHtml(itemId) {
  const url = `${TR_BASE}/?_q=${encodeURIComponent(itemId)}&map=ft`;
  console.debug('[dc-tr-compare] HTML', url);
  const response = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'text/html' }
  });
  if (!response.ok) {
    console.debug('[dc-tr-compare] HTML status', response.status);
    return null;
  }
  const html = await response.text();
  const product = parseJsonLdFromHtml(html);
  if (product) return product;

  const firstHref = html.match(/href=["']([^"']*\/p[^"']*)["']/i);
  if (firstHref) {
    const productUrl = firstHref[1].startsWith('http') ? firstHref[1] : `${TR_BASE}${firstHref[1]}`;
    const detailRes = await fetch(productUrl, { credentials: 'omit', headers: { Accept: 'text/html' } });
    if (detailRes.ok) {
      const detailHtml = await detailRes.text();
      const detailProduct = parseJsonLdFromHtml(detailHtml);
      if (detailProduct) return { ...detailProduct, url: detailProduct.url || productUrl };
    }
  }
  return null;
}

async function lookupTr(itemId) {
  const cached = cache.get(itemId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (inflight.has(itemId)) return inflight.get(itemId);

  const promise = (async () => {
    const queries = [
      'fq=alternateIds_RefId:',
      'fq=productReferenceCode:',
      'fq=alternateIds_Ean:',
      'ft='
    ];

    for (const q of queries) {
      const products = await fetchVtex(q, itemId);
      const picked = pickVtexProduct(products);
      if (picked) {
        return { itemId, status: 'MATCHED', source: `vtex:${q}`, turkey: picked };
      }
    }

    const fromHtml = await fetchTrHtml(itemId);
    if (fromHtml) {
      return { itemId, status: 'MATCHED', source: 'html', turkey: fromHtml };
    }

    return { itemId, status: 'NOT_SELLING_IN_TURKEY' };
  })().catch((error) => {
    console.warn('[dc-tr-compare] lookup error', itemId, error);
    return { itemId, status: 'ERROR', error: error.message };
  });

  inflight.set(itemId, promise);
  const value = await promise;
  inflight.delete(itemId);

  if (value.status === 'MATCHED') {
    cache.set(itemId, { value, expiresAt: Date.now() + POSITIVE_TTL_MS });
  } else if (value.status === 'NOT_SELLING_IN_TURKEY') {
    cache.set(itemId, { value, expiresAt: Date.now() + NEGATIVE_TTL_MS });
  }
  return value;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'compareItems') return;

  (async () => {
    try {
      const ids = (Array.isArray(message.itemIds) ? message.itemIds : [])
        .map((v) => String(v).trim())
        .filter(Boolean);
      const unique = [...new Set(ids)];
      const results = await Promise.all(unique.map(lookupTr));
      sendResponse({ ok: true, data: { results } });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});
