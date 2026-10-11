# Kadans

Açık kaynak, sunucusuz müzik çalar. Spotify gibi düşün: ara, bul, dinle — hesap yok, reklam yok, kurulum yok.

**Canlı:** https://syron01.github.io/kadans

## Nasıl çalışıyor

Kadans statik bir web uygulamasıdır. Arama ve ses akışını herkese açık Invidious örnekleri üzerinden yapar; bir örnek düşerse sıradaki otomatik devreye girer. Beğeniler ve çalma listeleri tarayıcının `localStorage`'ında durur — hiçbir veri toplanmaz.

```
index.html   tek sayfa
style.css    tema + düzen
app.js       API istemcisi, çalar, sıra, çalma listeleri
backend/     (isteğe bağlı) kendi proxy sunucun: FastAPI
```

## Çalıştır

```bash
# sadece aç — herhangi bir statik sunucu yeterli
python -m http.server 8080
# http://localhost:8080

# ya da kendi proxy'ni kullanmak istersen
pip install -r backend/requirements.txt
uvicorn backend.main:app --port 8000
```

## Mobil

Telefon tarayıcısından "Ana ekrana ekle" — uygulama gibi çalışır; kilit ekranı medya tuşları desteklenir.

## Kısayollar

`Boşluk` oynat/duraklat · `Shift+→` sonraki · `Shift+←` önceki

## Notlar

Ses kaynakları YouTube altyapısından gelir ve örnek sunucuların durumu değişkendir. Kadans hiçbir ses dosyasını barındırmaz; bir arayüz sağlar. MIT lisanslıdır.
