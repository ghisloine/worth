const PRODUCT_LINK_SELECTOR = 'a[href*="/p/"], a[href*="/en/p/"], a[href*="/fr/p/"]';
const BADGE_CLASS = 'dc-tr-compare-badge';
const TR_BASE = 'https://www.decathlon.com.tr';

function extractItemIdFromUrl(href) {
  if (!href) return null;
  try {
    const url = new URL(href, location.origin);
    const segments = url.pathname.split('/').filter(Boolean);
    const pIndex = segments.lastIndexOf('p');
    if (pIndex >= 0 && segments[pIndex + 1]) {
      const candidate = segments[pIndex + 1].match(/\d{6,8}/);
      if (candidate) return candidate[0];
    }
    const all = url.pathname.match(/\d{6,8}/g);
    return all ? all[all.length - 1] : null;
  } catch {
    return null;
  }
}

function parsePrice(text) {
  if (text == null) return null;
  const raw = String(text).replace(/[^\d.,-]/g, '');
  if (!raw) return null;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized;
  if (lastComma > lastDot) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = raw.replace(/,/g, '');
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function normalizeTrUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, TR_BASE).href;
  } catch {
    return null;
  }
}

function findNearestProductContainer(link) {
  return link.closest('article, li, .product-card, [data-testid*="product" i], [class*="product" i]') || link.parentElement;
}

function findCaPrice(container) {
  const text = container?.innerText || '';
  const candidates = text.match(/\$\s?\d[\d.,]*/g);
  if (!candidates?.length) return null;
  return parsePrice(candidates[0]);
}

function ensureBadge(container) {
  let badge = container.querySelector(`.${BADGE_CLASS}`);
  if (!badge) {
    badge = document.createElement('a');
    badge.className = BADGE_CLASS;
    badge.target = '_blank';
    badge.rel = 'noopener noreferrer';
    container.appendChild(badge);
  }
  return badge;
}

function setBadge(badge, { text, tone = 'neutral', href = null, title = '' }) {
  badge.textContent = text;
  badge.setAttribute('data-tone', tone);
  badge.title = title || text;
  if (href) {
    badge.setAttribute('href', href);
  } else {
    badge.removeAttribute('href');
  }
}

function buildComparisonMessage(result, cadToTryRate, caFallbackPrice) {
  if (result.status === 'NOT_SELLING_IN_TURKEY') {
    return { text: 'TR: Satılmıyor', tone: 'warning' };
  }
  if (result.status === 'ACCESS_BLOCKED') {
    return {
      text: 'TR: doğrulama gerekiyor',
      tone: 'warning',
      title: 'Decathlon Türkiye erişimi doğrulamaya takıldı. Bir TR ürün sayfası açıp sayfayı yenileyin.'
    };
  }
  if (result.status === 'ERROR') {
    return { text: 'TR: API hatası', tone: 'warning', title: result.error || '' };
  }
  if (result.status !== 'MATCHED') {
    return { text: 'TR eşleşmesi bulunamadı', tone: 'neutral' };
  }

  const trPrice = parsePrice(result.turkey?.price);
  const trUrl = normalizeTrUrl(result.turkey?.url);

  if (!Number.isFinite(trPrice)) {
    return {
      text: result.turkey?.available === false ? 'TR: Stokta yok' : 'TR: fiyat bilgisi yok',
      tone: 'neutral',
      href: trUrl
    };
  }

  const caPrice = caFallbackPrice;
  if (!Number.isFinite(caPrice) || !cadToTryRate) {
    return { text: `TR: ${trPrice.toFixed(2)} TRY`, tone: 'neutral', href: trUrl };
  }

  const convertedCa = caPrice * cadToTryRate;
  const diff = trPrice - convertedCa;
  const caToTlText = `CA->TL: ${convertedCa.toFixed(2)} TRY`;
  const trText = `TR: ${trPrice.toFixed(2)} TRY`;
  const tooltip = `CA ${caPrice.toFixed(2)} CAD * ${cadToTryRate} = ${convertedCa.toFixed(2)} TRY  |  TR ${trPrice.toFixed(2)} TRY`;

  if (Math.abs(diff) / Math.max(convertedCa, 1) < 0.02) {
    return {
      text: `${caToTlText} | ${trText} (yaklaşık aynı)`,
      tone: 'neutral',
      href: trUrl,
      title: tooltip
    };
  }
  if (diff < 0) {
    return {
      text: `${caToTlText} | ${trText} • ${Math.abs(diff).toFixed(2)} TRY daha ucuz`,
      tone: 'good',
      href: trUrl,
      title: tooltip
    };
  }
  return {
    text: `${caToTlText} | ${trText} • +${diff.toFixed(2)} TRY daha pahalı`,
    tone: 'bad',
    href: trUrl,
    title: tooltip
  };
}

async function getSettings() {
  return chrome.storage.sync.get({ cadToTryRate: 33 });
}

async function annotateProducts() {
  const links = [...document.querySelectorAll(PRODUCT_LINK_SELECTOR)];
  const products = [];
  const seen = new Set();

  for (const link of links) {
    const itemId = extractItemIdFromUrl(link.href);
    if (!itemId || seen.has(itemId)) continue;

    const container = findNearestProductContainer(link);
    if (!container) continue;

    seen.add(itemId);
    const caPrice = findCaPrice(container);
    const badge = ensureBadge(container);
    if (!badge.dataset.loaded) {
      setBadge(badge, { text: 'TR fiyatı yükleniyor...', tone: 'neutral' });
    }
    products.push({ itemId, container, badge, caPrice });
  }

  if (!products.length) return;

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'compareItems', itemIds: products.map((p) => p.itemId) },
      resolve
    );
  });

  if (!response?.ok) {
    for (const p of products) {
      setBadge(p.badge, { text: `Hata: ${response?.error || 'TR sorgusu'}`, tone: 'warning' });
    }
    return;
  }

  const { cadToTryRate } = await getSettings();
  const resultMap = new Map((response.data?.results || []).map((r) => [r.itemId, r]));

  for (const p of products) {
    const result = resultMap.get(p.itemId);
    if (!result) {
      setBadge(p.badge, { text: 'TR eşleşmesi bulunamadı', tone: 'neutral' });
      continue;
    }
    const message = buildComparisonMessage(result, Number(cadToTryRate) || 0, p.caPrice);
    setBadge(p.badge, message);
    p.badge.dataset.loaded = '1';
  }
}

let annotateTimer;
function scheduleAnnotate() {
  window.clearTimeout(annotateTimer);
  annotateTimer = window.setTimeout(() => {
    annotateProducts().catch((error) => {
      console.error('[dc-tr-compare]', error);
    });
  }, 600);
}

const observer = new MutationObserver(scheduleAnnotate);
observer.observe(document.documentElement, { childList: true, subtree: true });

scheduleAnnotate();
