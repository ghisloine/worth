const DEFAULTS = {
  cadToTryRate: 33
};

const TR_BASE = 'https://www.decathlon.com.tr';
const POSITIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const TAB_WARMUP_TIMEOUT_MS = 20 * 1000;
const TAB_POLL_INTERVAL_MS = 1200;
const CHALLENGE = Symbol('challenge');

const cache = new Map();
const inflight = new Map();
let trSessionPromise = null;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => existing[key] === undefined)
  );
  if (Object.keys(missing).length) {
    await chrome.storage.sync.set(missing);
  }
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTrUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `${TR_BASE}${raw}`;
  return `${TR_BASE}/${raw.replace(/^\.?\//, '')}`;
}

function extractNumericTokens(value) {
  return String(value || '').match(/\d{6,8}/g) || [];
}

function collectProductCandidateIds(product, sku) {
  const refs = new Set();
  const add = (value) => {
    for (const token of extractNumericTokens(value)) {
      refs.add(token);
    }
  };

  add(product?.productReference);
  add(product?.productReferenceCode);
  add(product?.link);
  add(product?.linkText);
  add(product?.productName);
  add(sku?.ean);
  add(sku?.itemId);
  add(sku?.name);

  for (const ref of sku?.referenceId || []) {
    add(ref?.Value);
    add(ref?.value);
    add(ref?.KeyValue);
  }

  return refs;
}

function isCloudflareChallenge(text) {
  const html = String(text || '');
  return (
    html.includes('Just a moment...') ||
    html.includes('Enable JavaScript and cookies to continue') ||
    html.includes('/cdn-cgi/challenge-platform/') ||
    html.includes('__cf_chl_')
  );
}

async function fetchText(url, accept) {
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: accept }
  });
  const text = await response.text();

  if (isCloudflareChallenge(text)) {
    console.debug('[dc-tr-compare] challenge', response.status, url);
    return CHALLENGE;
  }

  if (!response.ok) {
    console.debug('[dc-tr-compare] status', response.status, url);
    return null;
  }

  return text;
}

async function fetchVtex(query, itemId) {
  const url = `${TR_BASE}/api/catalog_system/pub/products/search?${query}${encodeURIComponent(itemId)}`;
  console.debug('[dc-tr-compare] VTEX', url);
  const text = await fetchText(url, 'application/json, text/plain, */*');
  if (text === CHALLENGE) return CHALLENGE;
  if (text == null) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    console.debug('[dc-tr-compare] VTEX invalid json', url, error?.message || error);
    return null;
  }
}

function pickVtexProduct(products, itemId) {
  if (!Array.isArray(products) || !products.length) return null;
  const selected = products.find((product) => {
    const sku = product.items?.[0];
    return collectProductCandidateIds(product, sku).has(itemId);
  });
  if (!selected) return null;

  const product = selected;
  const sku = product.items?.[0];
  const offer = sku?.sellers?.find((s) => s?.commertialOffer?.IsAvailable)?.commertialOffer
    || sku?.sellers?.[0]?.commertialOffer;
  if (!offer) return null;
  const productLink = product.link
    ? normalizeTrUrl(product.link)
    : null;
  return {
    name: product.productName || sku?.name || '',
    price: typeof offer.Price === 'number' ? offer.Price : null,
    listPrice: typeof offer.ListPrice === 'number' ? offer.ListPrice : null,
    available: Boolean(offer.IsAvailable ?? offer.AvailableQuantity > 0),
    currency: 'TRY',
    url: productLink
      ? productLink
      : product.linkText
        ? normalizeTrUrl(product.linkText)
        : `${TR_BASE}/?_q=${encodeURIComponent(product.productReference || '')}`
  };
}

function parseJsonLdFromHtml(html, itemId) {
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
      if (itemId) {
        const refs = new Set([
          ...extractNumericTokens(entry?.sku),
          ...extractNumericTokens(entry?.mpn),
          ...extractNumericTokens(entry?.productID),
          ...extractNumericTokens(entry?.url),
          ...extractNumericTokens(entry?.offers?.url)
        ]);
        if (refs.size && !refs.has(itemId)) {
          continue;
        }
      }
      const offers = Array.isArray(entry.offers) ? entry.offers[0] : entry.offers;
      const price = Number(offers?.price ?? offers?.lowPrice);
      if (!Number.isFinite(price)) continue;
      return {
        name: entry.name || '',
        price,
        listPrice: null,
        available: (offers?.availability || '').toString().toLowerCase().includes('instock'),
        currency: offers?.priceCurrency || 'TRY',
        url: normalizeTrUrl(entry.url || offers?.url || '')
      };
    }
  }
  return null;
}

async function fetchTrHtml(itemId) {
  const url = `${TR_BASE}/?_q=${encodeURIComponent(itemId)}&map=ft`;
  console.debug('[dc-tr-compare] HTML', url);
  const html = await fetchText(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
  if (html === CHALLENGE) return CHALLENGE;
  if (html == null) return null;

  const product = parseJsonLdFromHtml(html, itemId);
  if (product) return product;

  const firstHref = html.match(/href=["']([^"']*\/_\/R-p-\d[^"']*)["']/i);
  if (firstHref) {
    const productUrl = normalizeTrUrl(firstHref[1]);
    const detailHtml = await fetchText(productUrl, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
    if (detailHtml === CHALLENGE) return CHALLENGE;
    if (detailHtml == null) return null;

    const detailProduct = parseJsonLdFromHtml(detailHtml, itemId);
    if (detailProduct) return { ...detailProduct, url: detailProduct.url || productUrl };
  }
  return null;
}

async function runTabSnapshot(tabId, itemId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (targetItemId) => {
        const PRODUCT_PATH_RE = /\/_\/R-p-\d/i;

        const normalizeUrl = (href) => {
          if (!href) return '';
          try {
            return new URL(href, location.origin).href;
          } catch {
            return '';
          }
        };

        const bodyText = document.body?.innerText || '';
        const screenText = `${document.title}\n${bodyText}`;
        if (
          /Just a moment/i.test(screenText) ||
          /Enable JavaScript and cookies to continue/i.test(screenText) ||
          screenText.includes('/cdn-cgi/challenge-platform/') ||
          screenText.includes('__cf_chl_')
        ) {
          return { challenge: true };
        }

        const parsePrice = (text) => {
          if (text == null) return null;
          const raw = String(text).replace(/[^\d.,-]/g, '');
          if (!raw) return null;
          const lastComma = raw.lastIndexOf(',');
          const lastDot = raw.lastIndexOf('.');
          const normalized = lastComma > lastDot
            ? raw.replace(/\./g, '').replace(',', '.')
            : raw.replace(/,/g, '');
          const value = Number.parseFloat(normalized);
          return Number.isFinite(value) ? value : null;
        };

        const parseJsonLdProduct = () => {
          const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
          for (const script of scripts) {
            let data;
            try {
              data = JSON.parse(script.textContent || '');
            } catch {
              continue;
            }
            const entries = Array.isArray(data) ? data : [data];
            for (const entry of entries) {
              const types = Array.isArray(entry?.['@type']) ? entry['@type'] : [entry?.['@type']];
              if (!types.includes('Product')) continue;
              const refs = new Set(
                [entry?.sku, entry?.mpn, entry?.productID, entry?.url, entry?.offers?.url]
                  .flatMap((value) => String(value || '').match(/\d{6,8}/g) || [])
              );
              if (refs.size && !refs.has(targetItemId)) continue;
              const offers = Array.isArray(entry?.offers) ? entry.offers[0] : entry?.offers;
              const price = Number(offers?.price ?? offers?.lowPrice);
              if (!Number.isFinite(price)) continue;
              return {
                name: entry?.name || document.querySelector('h1')?.textContent?.trim() || '',
                price,
                listPrice: null,
                available: (offers?.availability || '').toString().toLowerCase().includes('instock'),
                currency: offers?.priceCurrency || 'TRY',
                url: normalizeUrl(entry?.url || offers?.url || location.href)
              };
            }
          }
          return null;
        };

        const isProductPage = PRODUCT_PATH_RE.test(location.pathname);
        if (isProductPage) {
          const fromJsonLd = parseJsonLdProduct();
          if (fromJsonLd) {
            return { product: fromJsonLd };
          }

          const refMatch = bodyText.match(/Ref\.\s*:\s*(\d{6,8})/i);
          if (refMatch?.[1] === targetItemId) {
            const priceSelectors = [
              '[data-testid*="price" i]',
              '[class*="price" i]',
              'aside'
            ];
            let priceToken = '';
            for (const selector of priceSelectors) {
              const nodes = [...document.querySelectorAll(selector)];
              const match = nodes
                .map((node) => node.textContent || '')
                .join('\n')
                .match(/₺\s*\d[\d.,]*/);
              if (match?.[0]) {
                priceToken = match[0];
                break;
              }
            }
            if (!priceToken) {
              priceToken = bodyText.match(/₺\s*\d[\d.,]*/)?.[0] || '';
            }

            const unavailableText = /Tükendi|Stokta yok|Ürün stokta yok|Mevcut değil/i.test(bodyText);
            const available = /\bSepete Ekle\b/i.test(bodyText) ? true : !unavailableText;
            return {
              product: {
                name: document.querySelector('h1')?.textContent?.trim() || '',
                price: parsePrice(priceToken),
                listPrice: null,
                available,
                currency: 'TRY',
                url: location.href
              }
            };
          }
        }

        const candidates = [...document.querySelectorAll('a[href]')]
          .map((anchor) => {
            const href = normalizeUrl(anchor.getAttribute('href'));
            if (!href) return null;
            let pathname = '';
            try {
              pathname = new URL(href).pathname;
            } catch {
              return null;
            }
            if (!PRODUCT_PATH_RE.test(pathname)) return null;
            const context = anchor.closest('article, li, section, div');
            return {
              href,
              text: `${anchor.textContent || ''}\n${context?.textContent || ''}`
            };
          })
          .filter(Boolean);

        const exactByMc = candidates.find(({ href }) => {
          try {
            return new URL(href).searchParams.get('mc') === targetItemId;
          } catch {
            return false;
          }
        });
        if (exactByMc) {
          return { candidateUrl: exactByMc.href };
        }

        const exactByText = candidates.find(({ text }) => text.includes(targetItemId));
        if (exactByText) {
          return { candidateUrl: exactByText.href };
        }

        const exactByHref = candidates.find(({ href }) => href.includes(targetItemId));
        if (exactByHref) {
          return { candidateUrl: exactByHref.href };
        }

        const refMatch = bodyText.match(/Ref\.\s*:\s*(\d{6,8})/i);
        if (isProductPage && refMatch?.[1] === targetItemId) {
          const topText = bodyText.split('\n').slice(0, 120).join('\n');
          const priceToken = topText.match(/₺\s*\d[\d.,]*/)?.[0] || bodyText.match(/₺\s*\d[\d.,]*/)?.[0] || '';
          const available = /\bSepete Ekle\b/i.test(bodyText)
            ? true
            : /Tükendi|Stokta yok|Ürün stokta yok|Mevcut değil/i.test(bodyText)
              ? false
              : true;
          return {
            product: {
              name: document.querySelector('h1')?.textContent?.trim() || '',
              price: parsePrice(priceToken),
              listPrice: null,
              available,
              currency: 'TRY',
              url: location.href
            }
          };
        }

        return { ready: true };
      },
      args: [itemId]
    });
    return results?.[0]?.result || null;
  } catch (error) {
    console.debug('[dc-tr-compare] tab snapshot failed', error?.message || error);
    return null;
  }
}

async function warmupAndScrapeTr(itemId) {
  const tab = await chrome.tabs.create({
    url: `${TR_BASE}/?_q=${encodeURIComponent(itemId)}&map=ft`,
    active: false
  });

  try {
    const deadline = Date.now() + TAB_WARMUP_TIMEOUT_MS;
    let followedCandidate = false;

    while (Date.now() < deadline) {
      const currentTab = await chrome.tabs.get(tab.id);
      if (currentTab.status !== 'complete') {
        await wait(TAB_POLL_INTERVAL_MS);
        continue;
      }

      const snapshot = await runTabSnapshot(tab.id, itemId);
      if (snapshot?.product) {
        return snapshot.product;
      }
      if (snapshot?.candidateUrl && !followedCandidate) {
        followedCandidate = true;
        await chrome.tabs.update(tab.id, { url: snapshot.candidateUrl });
        await wait(TAB_POLL_INTERVAL_MS);
        continue;
      }
      if (snapshot?.ready) {
        return null;
      }

      await wait(TAB_POLL_INTERVAL_MS);
    }

    return null;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function ensureTrSession(itemId) {
  if (trSessionPromise) return trSessionPromise;

  trSessionPromise = warmupAndScrapeTr(itemId)
    .finally(() => {
      trSessionPromise = null;
    });

  return trSessionPromise;
}

async function lookupTrOnce(itemId) {
  const queries = [
    'fq=alternateIds_RefId:',
    'fq=productReferenceCode:',
    'fq=alternateIds_Ean:',
    'ft='
  ];

  for (const q of queries) {
    const products = await fetchVtex(q, itemId);
    if (products === CHALLENGE) {
      return CHALLENGE;
    }

    const picked = pickVtexProduct(products, itemId);
    if (picked) {
      return { itemId, status: 'MATCHED', source: `vtex:${q}`, turkey: picked };
    }
  }

  const fromHtml = await fetchTrHtml(itemId);
  if (fromHtml === CHALLENGE) {
    return CHALLENGE;
  }
  if (fromHtml) {
    return { itemId, status: 'MATCHED', source: 'html', turkey: fromHtml };
  }

  return { itemId, status: 'NOT_SELLING_IN_TURKEY' };
}

async function lookupTr(itemId) {
  const cached = cache.get(itemId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (inflight.has(itemId)) return inflight.get(itemId);

  const promise = (async () => {
    const direct = await lookupTrOnce(itemId);
    if (direct !== CHALLENGE) {
      return direct;
    }

    const fromTab = await ensureTrSession(itemId);
    if (fromTab) {
      return { itemId, status: 'MATCHED', source: 'tab', turkey: fromTab };
    }

    const retried = await lookupTrOnce(itemId);
    if (retried !== CHALLENGE) {
      return retried;
    }

    return { itemId, status: 'ACCESS_BLOCKED' };
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
