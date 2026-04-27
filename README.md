# Decathlon Canada ↔ Turkey Item Comparer + Chrome Extension

Bu proje artık iki parçadan oluşuyor:

1. **Local API + web panel** (`server.mjs`, `public/`)  
   - CA ve TR katalog CSV yükleme
   - `item_id` bazlı karşılaştırma
   - `NOT_SELLING_IN_TURKEY` sonucu

2. **Chrome Extension** (`extension/`)  
   - `https://www.decathlon.ca/*` sayfalarında çalışır
   - Ürün kartlarını tarar, `item_id` çıkarır
   - Local compare API’ye sorar
   - Kart altına **TR fiyatı** ve **daha ucuz / daha pahalı** bilgisini ekler

---

## 1) Local compare API başlat

```bash
npm install
npm start
```

Açılan adres: `http://localhost:3000`

## 2) Katalog CSV formatı

Hem CA hem TR için başlıklar:

```csv
item_id,name,price,currency,url
8553203,Hiking Backpack 10L,9.99,CAD,https://www.decathlon.ca/en/p/8553203
```

TR örnek:

```csv
item_id,name,price,currency,url
8553203,10L Sırt Çantası,249.99,TRY,https://www.decathlon.com.tr/p/8553203
```

> Not: CSV’de `item_id` zorunludur. Fiyat karşılaştırması için `price` ve `currency` alanlarını doldurun.

## 3) Web panelden katalog yükle

`http://localhost:3000` sayfasında:
- Canada CSV upload
- Turkey CSV upload
- İstersen item id manuel karşılaştır

## 4) Chrome Extension kurulum (Developer Mode)

1. Chrome → `chrome://extensions`
2. Sağ üstten **Developer mode** aç
3. **Load unpacked**
4. Bu repodaki `extension/` klasörünü seç
5. Extension options sayfasında:
   - `API Base URL`: `http://127.0.0.1:3000`
   - `CAD → TRY`: güncel kur (örnek: 25.00)

## 5) Decathlon Canada kategori sayfasında kullanım

Örneğin:
`https://www.decathlon.ca/en/c/22547/bike-accessories`

Extension ürün kartlarının altına şu formatta etiket ekler:
- `TR: Satılmıyor`
- `TR: 499.90 TRY • daha ucuz (120.00 TRY)`
- `TR: 799.90 TRY • daha pahalı (+180.00 TRY)`

## API endpointleri

- `GET /api/catalog/status`
- `POST /api/catalog/ca` (multipart, field: `file`)
- `POST /api/catalog/tr` (multipart, field: `file`)
- `POST /api/compare`

Body:

```json
{
  "itemIds": ["8553203", "1234567"]
}
```

Status değerleri:
- `MATCHED`
- `NOT_SELLING_IN_TURKEY`
- `NOT_FOUND_IN_CANADA`

---

## Gerçek zamanlı canlı Decathlon sync (sonraki adım)

Bu sürüm CSV tabanlıdır (daha stabil MVP). Sonraki adımda canlı CA/TR feed entegrasyonu eklenebilir.
