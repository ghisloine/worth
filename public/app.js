const caFileInput = document.getElementById('caFile');
const trFileInput = document.getElementById('trFile');
const uploadCaBtn = document.getElementById('uploadCa');
const uploadTrBtn = document.getElementById('uploadTr');
const catalogStatus = document.getElementById('catalogStatus');
const compareBtn = document.getElementById('compareBtn');
const itemIdsInput = document.getElementById('itemIds');
const resultsEl = document.getElementById('results');

async function refreshStatus() {
  const response = await fetch('/api/catalog/status');
  const data = await response.json();
  catalogStatus.textContent = `Canada items: ${data.canadaCount} | Turkey items: ${data.turkeyCount}`;
}

async function uploadCatalog(country, fileInput) {
  const file = fileInput.files?.[0];
  if (!file) {
    alert(`Please select a ${country.toUpperCase()} CSV file first.`);
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`/api/catalog/${country}`, {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Upload failed');
    return;
  }

  await refreshStatus();
  alert(`${country.toUpperCase()} catalog uploaded (${data.itemCount} items).`);
}

function parseInputIds(raw) {
  return raw
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function renderResultCard(result) {
  const card = document.createElement('article');
  card.className = `result ${result.status.toLowerCase()}`;

  const canadaName = result.canada?.name || '—';
  const turkeyName = result.turkey?.name || '—';

  card.innerHTML = `
    <h3>Item ID: ${result.itemId}</h3>
    <p><strong>Status:</strong> ${result.status}</p>
    <p>${result.message}</p>
    <div class="meta-grid">
      <div>
        <h4>Canada</h4>
        <p>Name: ${canadaName}</p>
        <p>Price: ${result.canada?.price || '—'} ${result.canada?.currency || ''}</p>
      </div>
      <div>
        <h4>Turkey</h4>
        <p>Name: ${turkeyName}</p>
        <p>Price: ${result.turkey?.price || '—'} ${result.turkey?.currency || ''}</p>
      </div>
    </div>
  `;

  return card;
}

async function compareItems() {
  const ids = parseInputIds(itemIdsInput.value);
  if (!ids.length) {
    alert('Please enter at least one item ID.');
    return;
  }

  const response = await fetch('/api/compare', {
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
  for (const result of data.results) {
    resultsEl.appendChild(renderResultCard(result));
  }
}

uploadCaBtn.addEventListener('click', () => uploadCatalog('ca', caFileInput));
uploadTrBtn.addEventListener('click', () => uploadCatalog('tr', trFileInput));
compareBtn.addEventListener('click', compareItems);

refreshStatus();
