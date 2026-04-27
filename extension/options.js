const cadToTryRateEl = document.getElementById('cadToTryRate');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

async function load() {
  const data = await chrome.storage.sync.get({ cadToTryRate: 33 });
  cadToTryRateEl.value = data.cadToTryRate;
}

async function save() {
  const rate = Number(cadToTryRateEl.value);
  await chrome.storage.sync.set({
    cadToTryRate: Number.isFinite(rate) && rate > 0 ? rate : 33
  });
  statusEl.textContent = 'Kaydedildi.';
  setTimeout(() => { statusEl.textContent = ''; }, 1800);
}

saveBtn.addEventListener('click', save);
load();
