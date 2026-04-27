# Decathlon CA -> TR Price Compare (Chrome Extension)

Decathlon urun referanslari (R3, 7 haneli ref id) tum bolgelerde aynidir. Bu Chrome eklentisi, `decathlon.ca` listeleme ve urun sayfalarinda her urun karti icin ayni ref id'yi kullanarak `decathlon.com.tr`'den TR fiyatini cekip karta yapistirir.

Lokal sunucu, CSV upload, manuel eslestirme **yoktur**. Eklenti tamamen istemci tarafinda calisir; sorgular dogrudan kullanicinin tarayicisindan `decathlon.com.tr`'ye gider.

## Ozellikler

- `decathlon.ca/*` sayfalarinda urun kartlari altina TR fiyat etiketi ekler.
- TR fiyati ile (CAD x kullanici tanimli kur) karsilastirir, sonucu **daha ucuz / yaklasik ayni / daha pahali** olarak isaretler.
- TR'de satilmayan urunler icin `TR: Satilmiyor` gosterir.
- Sonuclar bellek-ici cache'lenir; ayni urun ayni oturumda tekrar sorgulanmaz.

## Kurulum (Developer Mode)

1. Chrome -> `chrome://extensions`
2. Sag ust **Developer mode** acik
3. **Load unpacked** -> bu repodaki `extension/` klasorunu sec
4. Eklenti **Options** sayfasini ac, `CAD -> TRY` kurunu gir (orn. 33.00)

## Kullanim

1. `https://www.decathlon.ca/` uzerinde herhangi bir kategori veya arama sayfasina git, orn:
   `https://www.decathlon.ca/en/c/22547/bike-accessories`
2. Sayfa yuklendikten kisa bir sure sonra her urun kartinin altinda TR durumu cikar:
   - `TR: 499.90 TRY · daha ucuz (120.00 TRY)`
   - `TR: 799.90 TRY · daha pahali (+180.00 TRY)`
   - `TR: 499.90 TRY (yaklasik ayni)`
   - `TR: Satilmiyor`
3. Etikete tiklamak yeni sekmede TR urun sayfasini acar.

## TR fiyati nasil bulunuyor?

Eklenti `decathlon.com.tr`'nin VTEX katalog API'sini sirayla dener:

1. `GET /api/catalog_system/pub/products/search?fq=alternateIds_RefId:<id>`
2. `GET /api/catalog_system/pub/products/search?fq=productReferenceCode:<id>`
3. `GET /api/catalog_system/pub/products/search?fq=alternateIds_Ean:<id>`
4. `GET /api/catalog_system/pub/products/search?ft=<id>`
5. Hepsi bos donerse `/?_q=<id>&map=ft` HTML'inden ilk urunu cekip JSON-LD `Product` semasindan fiyati okur.

Her cagri `console.debug('[dc-tr-compare] ...')` satiri uretir; service worker konsoluna bakarak tam URL'yi gorebilirsin.

## Sorun giderme

- **Hicbir urunun yaninda etiket yok**: Sayfa SPA olarak gec yukleniyor olabilir. Mutation observer 600 ms throttling ile yeniden deneyecek; sayfayi kaydir veya yenile.
- **`TR: API hatasi`**: VTEX API 4xx/5xx donmus. `chrome://extensions` -> bu eklentinin **service worker**'ini ac, konsoldaki son `[dc-tr-compare]` satirina bak.
- **Ref id yanlis algilaniyor**: `extractItemIdFromUrl` URL path'indeki `p` segmentinden sonraki 6-8 haneli sayiyi alir. Decathlon CA URL formati degistiyse `extension/content.js` icindeki regexi guncelle.
- **Tum urunler `TR: Satilmiyor`**: CA URL'sindeki ID, TR VTEX'inde `RefId` olarak indekslenmemis olabilir. Service worker konsolunda hangi sorgunun ne dondugunu gor; gerekirse `background.js` icindeki sorgu listesine yeni bir `fq` alani ekle.

## Yapi

```
extension/
  manifest.json        MV3, host_permissions: decathlon.ca + decathlon.com.tr
  background.js        VTEX lookup + HTML fallback + cache
  content.js           Karta badge ekleme, ref id cikarma, CA fiyati scrape
  content.css          Badge stilleri
  options.html         Sadece CAD->TRY kuru ayari
  options.js
```
