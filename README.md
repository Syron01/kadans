# Kadans

Açık kaynak müzik çalar. Sunucusuz, anahtar gerektirmez, hızlı.

**Canlı:** https://syron01.github.io/kadans

## Nasıl çalışıyor

Tek dosyalık statik web uygulaması. Arama ve ses akışı [Audius](https://audius.co) açık ağı üzerinden yapılır: anahtar yok, vekil sunucu kumarı yok, ses Audius'un kendi CDN'inden 320 kbps doğrudan gelir. Beğeniler ve çalma listeleri tarayıcının `localStorage`'ında durur — hiçbir veri toplanmaz.

```
index.html   tek sayfa: arayüz + mantık
backend/     (isteğe bağlı, kullanılmıyor) eski YouTube proxy denemesi
```

## Çalıştır

```bash
python -m http.server 8080
# http://localhost:8080
```

## Notlar

- Audius bağımsız sanatçı ağıdır; Spotify kadrosunun tamamı yoktur ama arama ve akış hızlı ve stabildir.
- Ses kaynağı Audius'tur; Kadans hiçbir ses dosyasını barındırmaz.

MIT lisanslıdır.
