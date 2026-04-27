const PRODUCT_LINK_SELECTOR = 'a[href*="/p/"]';
const BADGE_CLASS = 'dc-tr-compare-badge';

function extractItemIdFromUrl(href) {
  const clean = href.split('?')[0];
  const match = clean.match(/(\d{6,})/g);
  if (!match?.length) return null;
  return match[match.length - 1];
}

function findNearestProductContainer(link) {
  return link.closest('article, li, .product-card, [data-testid*="product" i], [class*="product" i]') || link.parentElement;
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

function formatPrice(price, currency) {
  if (price === null || price === undefined || Number.isNaN(Number(price))) return '?';
  return `${Number(price).toFixed(2)} ${currency || ''}`.trim();
}

function buildComparisonMessage(result) {
  if (result.status === 'NOT_SELLING_IN_TURKEY') {
    return { text: 'TR: Satılmıyor', tone: 'warning' };
  }

  if (result.status !== 'MATCHED') {
    return { text: 'TR: Bulunamadı', tone: 'neutral' };
  }

  const tr = result.turkey;
  const cmp = result.comparison || {};

  if (!Number.isFinite(cmp.diffTry)) {
    return {
      text: `TR: ${formatPrice(tr?.price, tr?.currency || 'TRY')}`,
      tone: 'neutral'
    };
  }

  if (Math.abs(cmp.diffTry) < 0.5) {
    return {
      text: `TR: ${formatPrice(tr?.price, 'TRY')} • yaklaşık aynı`,
      tone: 'neutral'
    };
  }

  if (cmp.diffTry < 0) {
    return {
      text: `TR: ${formatPrice(tr?.price, 'TRY')} • daha düşük (${Math.abs(cmp.diffTry).toFixed(2)} TRY)`,
      tone: 'good'
    };
  }

  return {
    text: `TR: ${formatPrice(tr?.price, 'TRY')} • daha yüksek (+${cmp.diffTry.toFixed(2)} TRY)`,
    tone: 'bad'
  };
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
    const badge = ensureBadge(container);
    setBadgeText(badge, 'TR fiyatı alınıyor...', 'neutral');
    products.push({ itemId, badge });
  }

  if (!products.length) return;

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'compareItems',
      itemIds: products.map((p) => p.itemId)
    }, resolve);
  });

  if (!response?.ok) {
    for (const p of products) {
      setBadgeText(p.badge, `Hata: ${response?.error || 'API erişilemedi'}`, 'warning');
    }
    return;
  }

  const resultMap = new Map((response.data?.results || []).map((r) => [r.itemId, r]));
  for (const p of products) {
    const result = resultMap.get(p.itemId);
    if (!result) {
      setBadgeText(p.badge, 'TR: Bulunamadı', 'neutral');
      continue;
    }

    const msg = buildComparisonMessage(result);
    setBadgeText(p.badge, msg.text, msg.tone);
  }
}

let annotateTimer;
function scheduleAnnotate() {
  window.clearTimeout(annotateTimer);
  annotateTimer = window.setTimeout(() => {
    annotateProducts().catch((error) => {
      console.error('[dc-tr-compare]', error);
    });
  }, 900);
}

const observer = new MutationObserver(scheduleAnnotate);
observer.observe(document.documentElement, { childList: true, subtree: true });

scheduleAnnotate();
