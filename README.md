# Decathlon Canada → Turkey Live Price Compare (Chrome Extension)

Tam olarak istediğin akış için güncellendi:

- Decathlon Canada kategori/listeme sayfasına giriyorsun.
- Extension ürün kartlarından **item id** çıkarıyor.
- Backend aynı item id ile **Decathlon Türkiye** tarafında fiyat arıyor.
- Kartın altına canlı olarak:
  - `TR: Satılmıyor`
  - `TR: ... TRY • daha düşük`
  - `TR: ... TRY • daha yüksek`
  yazıyor.

## Kurulum

### 1) Local backend çalıştır

```bash
npm install
npm start
```

Backend: `http://127.0.0.1:3000`

### 2) Extension yükle

1. Chrome: `chrome://extensions`
2. **Developer mode** aç
3. **Load unpacked**
4. Bu repodaki `extension/` klasörünü seç
5. Extension options'ta API URL kontrol et: `http://127.0.0.1:3000`

### 3) Kullanım

Örnek kategori:
`https://www.decathlon.ca/en/c/22547/bike-accessories`

Sayfadaki ürün kartlarının altına TR fiyat etiketleri gelir.

## Nasıl çalışıyor?

### Extension
- `content.js`: ürün linklerinden item id çıkarır, badge basar.
- `background.js`: backend `/api/compare-live` endpointine item id listesi gönderir.

### Backend
- `POST /api/compare-live`:
  - CA search sayfasından item verisini çeker,
  - TR search sayfasından item verisini çeker,
  - Fiyat karşılaştırması yapar (`TRY` bazında),
  - Status döner: `MATCHED`, `NOT_SELLING_IN_TURKEY`, `NOT_FOUND_IN_CANADA`.
- `GET /api/health`:
  - servis ayakta mı + CAD/TRY kur bilgisi.

## Önemli not

Bu sürüm artık **CSV upload kullanmıyor**.
Canlı web verisi üzerinden çalışacak şekilde düzenlendi.

## Limitler

Decathlon siteleri HTML/API yapısını değiştirirse parser güncellemesi gerekebilir.
