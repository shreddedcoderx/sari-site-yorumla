# Sarı Site Yorumla

Sarı Site Yorumla, ilan numaraları etrafında kullanıcı deneyimlerini bir araya getiren bağımsız bir topluluk uygulamasıdır. Bu depo, projenin yerelde çalıştırılabilir kaynak kodunu içerir. Canlı ortamın verileri, erişim bilgileri ve dağıtım ayarları burada bulunmaz. Herhangi bir ilan platformunun resmî projesi değildir.

## Yerelde çalıştırma

Node.js 22.13 veya üzeri gerekir. Üretim bağımlılığı yoktur.

```sh
git clone https://github.com/shreddedcoderx/sari-site-yorumla.git
cd sari-site-yorumla
npm start
```

Tarayıcıda `http://localhost:4180` adresini açın. Uygulama verileri yerel `data/` klasöründe tutulur; bu klasör Git'e eklenmez. İsterseniz `.env.example` dosyasını örnek alarak kendi `.env` dosyanızı oluşturup `node --env-file=.env server.mjs` ile başlatabilirsiniz. `.env` otomatik yüklenmez.

Örnek içerikle denemek için yalnızca yerelde `DEMO_DATA=true npm start` kullanın. Gerçek kullanıcı veya ilan verisi depoda yoktur. Yönetici işlemlerini denemek isteyenler önce yerelde bir hesap oluşturup ardından `node admin.mjs kendi-epostaniz@example.com` komutunu çalıştırabilir.

## Geliştirme ve test

```sh
npm test
```

Uygulama Node.js HTTP sunucusu, SQLite veritabanı ve bağımsız bir tarayıcı arayüzü kullanır. Üyelik, ilan sayfaları, yorumlar, fiyat bildirimleri, takip listesi ve yönetici incelemesi bulunur. Bazı özellikler yerel örnek veriye ihtiyaç duyar.

## Lisans

Kod [MIT lisansı](LICENSE) ile paylaşılır. Kullanılan üçüncü taraf görsel öğelere ilişkin bilgiler [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) dosyasındadır.
