const apiBaseUrlEl = document.getElementById('apiBaseUrl');
const cadToTryRateEl = document.getElementById('cadToTryRate');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

async function load() {
  const data = await chrome.storage.sync.get({
    apiBaseUrl: 'http://127.0.0.1:3000',
    cadToTryRate: 25
  });

  apiBaseUrlEl.value = data.apiBaseUrl;
  cadToTryRateEl.value = data.cadToTryRate;
}

async function save() {
  await chrome.storage.sync.set({
    apiBaseUrl: apiBaseUrlEl.value.trim() || 'http://127.0.0.1:3000',
    cadToTryRate: Number(cadToTryRateEl.value) || 25
  });

  statusEl.textContent = 'Kaydedildi.';
  setTimeout(() => {
    statusEl.textContent = '';
  }, 1800);
}

saveBtn.addEventListener('click', save);
load();
