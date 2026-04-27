const PRODUCT_LINK_SELECTOR = 'a[href*="/p/"]';
const BADGE_CLASS = 'dc-tr-compare-badge';

function extractItemIdFromUrl(href) {
  const clean = href.split('?')[0];
  const match = clean.match(/(\d{6,})/g);
  if (!match?.length) {
    return null;
  }
  return match[match.length - 1];
}

function parsePrice(text) {
  if (!text) return null;
  const normalized = text.replace(/[^\d.,]/g, '').replace(',', '.');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function findNearestProductContainer(link) {
  return link.closest('article, li, .product-card, [data-testid*="product" i], [class*="product" i]') || link.parentElement;
}

function findCaPrice(container) {
  const text = container?.innerText || '';
  const candidates = text.match(/\$\s?\d+[\d.,]*/g);
  if (!candidates?.length) return null;
  return parsePrice(candidates[0]);
}

function ensureBadge(container) {
  let badge = container.querySelector(`.${BADGE_CLASS}`);
  if (!badge) {
    badge = document.createElement('div');
    badge.className = BADGE_CLASS;
    container.appendChild(badge);
  }
  return badge;
}

function setBadgeText(badge, text, tone = 'neutral') {
  badge.textContent = text;
  badge.setAttribute('data-tone', tone);
}

function buildComparisonMessage(result, cadToTryRate, caFallbackPrice) {
  if (result.status === 'NOT_SELLING_IN_TURKEY') {
    return { text: 'TR: Satılmıyor', tone: 'warning' };
  }

  if (result.status !== 'MATCHED') {
    return { text: 'Karşılaştırma bulunamadı', tone: 'neutral' };
  }

  const caPrice = parsePrice(result.canada?.price) ?? caFallbackPrice;
  const trPrice = parsePrice(result.turkey?.price);

  if (!Number.isFinite(caPrice) || !Number.isFinite(trPrice)) {
    return {
      text: `TR: ${result.turkey?.price || '?'} ${result.turkey?.currency || ''}`,
      tone: 'neutral'
    };
  }

  const convertedCa = caPrice * cadToTryRate;
  const diff = trPrice - convertedCa;

  if (Math.abs(diff) < 0.5) {
    return {
      text: `TR: ${trPrice.toFixed(2)} TRY (yaklaşık aynı)` ,
      tone: 'neutral'
    };
  }

  if (diff < 0) {
    return {
      text: `TR: ${trPrice.toFixed(2)} TRY • daha ucuz (${Math.abs(diff).toFixed(2)} TRY)`,
      tone: 'good'
    };
  }

  return {
    text: `TR: ${trPrice.toFixed(2)} TRY • daha pahalı (+${diff.toFixed(2)} TRY)`,
    tone: 'bad'
  };
}

async function getSettings() {
  return chrome.storage.sync.get({
    cadToTryRate: 25
  });
}

async function annotateProducts() {
  const links = [...document.querySelectorAll(PRODUCT_LINK_SELECTOR)];
  const products = [];
  const seen = new Set();

  for (const link of links) {
    const itemId = extractItemIdFromUrl(link.href);
    if (!itemId || seen.has(itemId)) {
      continue;
    }

    const container = findNearestProductContainer(link);
    if (!container) {
      continue;
    }

    seen.add(itemId);
    const caPrice = findCaPrice(container);
    const badge = ensureBadge(container);
    setBadgeText(badge, 'TR fiyatı yükleniyor...', 'neutral');
    products.push({ itemId, container, badge, caPrice });
  }

  if (!products.length) {
    return;
  }

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'compareItems',
      itemIds: products.map((p) => p.itemId)
    }, resolve);
  });

  if (!response?.ok) {
    for (const p of products) {
      setBadgeText(p.badge, `Hata: ${response?.error || 'sunucuya bağlanamadı'}`, 'warning');
    }
    return;
  }

  const { cadToTryRate } = await getSettings();
  const resultMap = new Map((response.data?.results || []).map((r) => [r.itemId, r]));

  for (const p of products) {
    const result = resultMap.get(p.itemId);
    if (!result) {
      setBadgeText(p.badge, 'TR eşleşmesi bulunamadı', 'neutral');
      continue;
    }

    const message = buildComparisonMessage(result, Number(cadToTryRate) || 25, p.caPrice);
    setBadgeText(p.badge, message.text, message.tone);
  }
}

let annotateTimer;
function scheduleAnnotate() {
  window.clearTimeout(annotateTimer);
  annotateTimer = window.setTimeout(() => {
    annotateProducts().catch((error) => {
      console.error('[dc-tr-compare]', error);
    });
  }, 800);
}

const observer = new MutationObserver(scheduleAnnotate);
observer.observe(document.documentElement, { childList: true, subtree: true });

scheduleAnnotate();
