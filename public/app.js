const compareBtn = document.getElementById('compareBtn');
const itemIdsInput = document.getElementById('itemIds');
const resultsEl = document.getElementById('results');

function parseInputIds(raw) {
  return raw
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function card(result) {
  const el = document.createElement('article');
  el.className = `result ${result.status.toLowerCase()}`;

  const canada = result.canada || {};
  const turkey = result.turkey || {};
  const cmp = result.comparison || {};

  let compareLabel = 'Karşılaştırma hesaplanamadı';
  if (Number.isFinite(cmp.diffTry)) {
    compareLabel = cmp.diffTry <= 0
      ? `TR daha düşük (${Math.abs(cmp.diffTry).toFixed(2)} TRY)`
      : `TR daha yüksek (+${cmp.diffTry.toFixed(2)} TRY)`;
  }

  el.innerHTML = `
    <h3>Item ID: ${result.itemId}</h3>
    <p><strong>Status:</strong> ${result.status}</p>
    <p>${result.message || ''}</p>
    <p><strong>Compare:</strong> ${compareLabel}</p>
    <div class="meta-grid">
      <div>
        <h4>Canada</h4>
        <p>${canada.name || '—'}</p>
        <p>${canada.price || '—'} ${canada.currency || ''}</p>
      </div>
      <div>
        <h4>Turkey</h4>
        <p>${turkey.name || '—'}</p>
        <p>${turkey.price || '—'} ${turkey.currency || ''}</p>
      </div>
    </div>
  `;

  return el;
}

async function compareItems() {
  const ids = parseInputIds(itemIdsInput.value);
  if (!ids.length) {
    alert('En az bir item id gir.');
    return;
  }

  const response = await fetch('/api/compare-live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds: ids })
  });

  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Compare failed');
    return;
  }

  resultsEl.innerHTML = '';
  for (const result of data.results || []) {
    resultsEl.appendChild(card(result));
  }
}

compareBtn.addEventListener('click', compareItems);
