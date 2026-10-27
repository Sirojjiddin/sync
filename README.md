# SyncCast

Bir nechta qurilmada **bir vaqtda** (sinxron) musiqa yoki film chalish. Kahoot kabi: Transmitter xona yaratadi, Receiverlar 6 xonali kod (yoki QR) bilan kiradi.

- **Transmitter** — xona yaratadi, fayl yuklaydi (yoki havola qo'shadi), play / pauza / suradi. Hammada bir vaqtda ishlaydi.
- **Receiver** — kod bilan kiradi, o'z dinamigidan eshitadi / videoni ko'radi.

## 1. Lokal rejim (bitta Wi-Fi, internet shart emas)

```bash
npm install
npm start
```

Terminalda manzillar chiqadi:

```
Shu kompyuterda:   http://localhost:3000
Wi-Fi tarmog'ida:  http://192.168.1.23:3000
```

1. Serverni ishga tushirgan kompyuterda `http://localhost:3000` ni oching → **Transmitter**. (Transmitter telefondan ham bo'lishi mumkin: telefonda `http://192.168.1.23:3000` ni ochib, **Transmitter**ni tanlang.)
2. Ekranda kod va QR chiqadi. Telefonlar **bir xil Wi-Fi'da** QR'ni skanerlaydi yoki `http://192.168.1.23:3000` ni ochib kodni kiritadi → **Receiver**.
3. Fayl yuklang, ▶ bosing.

Lokal rejimda fayllar Wi-Fi orqali uzatiladi, shuning uchun juda tez va internet sarflanmaydi.

## 2. Global rejim (internet orqali, har qayerdan)

Server internetda ochiq turishi kerak. Ikki yo'l bor:

### A) Tez sinov: tunnel (o'z kompyuteringizdan)

```bash
npm start
# boshqa terminalda (cloudflared yoki ngrok o'rnatilgan bo'lsa):
cloudflared tunnel --url http://localhost:3000
# yoki
ngrok http 3000
```

Chiqqan `https://....` havolani Transmitter ochadi, Receiverlar ham shu havola + kod bilan kiradi.
**Eslatma:** bepul Cloudflare tunnelida bitta so'rov hajmi ~100 MB bilan cheklanadi, katta fayl yuklanmaydi. Katta fayllar uchun lokal rejim yoki "havola qo'shish" (pastga qarang).

### B) Doimiy hosting (Render, Railway, Fly.io, VPS)

1. Loyihani GitHub'ga yuklang.
2. Render/Railway'da "Web Service" yarating: Build `npm install`, Start `npm start`. `PORT` ni platforma o'zi beradi.
3. Berilgan `https://...` manzil — global manzilingiz. WebSocket va HTTPS avtomatik ishlaydi.

Bepul tariflarda server uxlab qolishi (birinchi ochilish sekin) va disk vaqtinchalik ekanligini unutmang — xonalar baribir vaqtinchalik.

## Qo'llab-quvvatlanadigan fayllar

| Tur | Formatlar | Receiverda qanday ko'rinadi |
|---|---|---|
| Audio | mp3, wav, ogg, m4a, aac, flac, opus | sinxron chaladi |
| Video | mp4, webm, mov, m4v, ogv | sinxron chaladi |
| Rasm | jpg, png, gif, webp, avif, bmp | ekranda ko'rsatiladi |
| PDF | pdf | ekranda ko'rsatiladi (+ "Ochish" / "Yuklab olish") |
| Matn | txt, csv, md | ekranda ko'rsatiladi |
| Hujjat | doc/docx, xls/xlsx, ppt/pptx, rtf, odt/ods/odp | fayl kartasi + "Yuklab olish" (brauzer Word/Excel'ni ochib ko'rsata olmaydi) |

Xavfsizlik uchun SVG, HTML, JS, EXE, ZIP kabi turlar qabul qilinmaydi.

## Barqaror chalish uchun maslahat

- Transmitter o'zi yuklagan faylni **o'z qurilmasidan** chaladi (serverdan qayta yuklamaydi), shuning uchun u qotmaydi.
- Katta `.mp4` fayl Receiverlarda tez boshlanishi uchun "faststart" bilan saqlangan bo'lsin: `ffmpeg -i kirish.mp4 -c copy -movflags +faststart chiqish.mp4`. Aks holda brauzer butun faylni yuklab olmaguncha boshlay olmaydi.
- Eng barqarori: hamma bitta Wi-Fi'da (lokal rejim).

## Fayl o'rniga havola

Transmitter "havola qo'shish" maydoniga to'g'ridan-to'g'ri `.mp3` / `.mp4` havolasini qo'ysa, fayl serverga yuklanmaydi, Receiverlar uni o'sha manbadan oladi. Global rejimda katta filmlar uchun eng qulay yo'l.
YouTube/Netflix havolalari ishlamaydi (ular to'g'ridan-to'g'ri fayl bermaydi). Sayt HTTPS bo'lsa, havola ham HTTPS bo'lishi kerak.

## Sozlamalar (muhit o'zgaruvchilari)

| O'zgaruvchi | Standart | Ma'no |
|---|---|---|
| `PORT` | 3000 | Server porti |
| `MAX_MB` | 1024 | Bitta fayl hajmi chegarasi (MB) |

## Qanday sinxronlaydi

1. Har bir qurilma server bilan soat farqini o'lchaydi (har 5 soniyada qayta, eng kichik kechikishli o'lchov olinadi).
2. Transmitter ▶ bosganda server "boshlanish vaqti"ni (hozir + 1,5 s) belgilaydi, hamma qurilma shu aniq lahzada chala boshlaydi.
3. Chalish paytida har 300 ms da farq tekshiriladi: kichik farq tezlikni ±8% gacha o'zgartirib, katta farq (0,5 s dan ortiq) surib to'g'rilanadi.
4. Xonaga keyin kirgan Receiver darhol hozirgi joydan davom etadi.

## Yangi imkoniyatlar (v3)

**Transmitter paneli:**
- 👁 Receiverlar fayllarni (rasm / PDF / hujjat) ko'ra olsin — yoqish/o'chirish (server ham rad etadi)
- ⬇ Yuklab olishga ruxsat — yoqish/o'chirish
- 🔇 **Hammaning dinamigini o'chirish** tugmasi + har bir receiver uchun alohida 🔊/🔇 va ✕ (chiqarib yuborish)
- Umumiy ovoz slayderi (hamma receiverda bir xil) va "receiver ovozini o'zgartira olmasin" qulfi
- ⏮ ⏭ ⏹ tugmalari, takrorlash (bitta / hammasi), hammaga xabar yuborish, xona qulfi (yangi receiver kira olmaydi)

**🎙 Jonli efir (WebRTC):**
- 🎤 Mikrofon — Transmitter gapiradi, hamma receiver eshitadi. Mikrofon paytida musiqa avtomatik pasayadi (ducking).
- 🖥 Ekranni ko'rsatish (cast) — receiverlarda ekran paydo bo'ladi, to'liq ekran tugmasi bor. Ixtiyoriy: brauzer/tizim ovozi bilan.
- Mikrofon va ekran uchun Transmitter sahifasini **http://localhost** yoki **HTTPS** orqali oching (brauzer talabi).
  Telefonda ekranni ulashish ko'p brauzerlarda yo'q — ekran uzatishni kompyuterdan qiling.
- Bir vaqtda ~20 receivergacha to'g'ridan-to'g'ri efir (undan ko'prog'i uchun SFU server kerak).
- Internet orqali (turli tarmoqlar) ishlashi uchun ba'zan TURN server kerak bo'ladi; bitta Wi-Fi'da muammo yo'q.

**Ovozni 1:1 tenglashtirish:** fayl balandligi LUFS (ITU-R BS.1770, K-vazn + gate) bo'yicha Transmitterda **bir marta** o'lchanadi
(yuklash paytida; katta fayllarda ijroning birinchi ~8 soniyasida) va hisoblangan tuzatma (dB) server orqali **hamma qurilmaga bir xil** yuboriladi.
Har qurilma aynan shu statik kuchaytirishni qo'llaydi, oxirida limiter turadi — shuning uchun fayllar orasida sakrash yo'q va Transmitter
bilan receiverlar bir xil balandlikda chaladi. Mikrofon ovozi Transmitterning o'zida tenglashtiriladi, receiverlarda qo'shimcha ishlov yo'q.
(Qurilmaning o'z dinamik/Bluetooth ovozini dastur o'zgartira olmaydi.)

**Mikrofon (aks-sado va chiyillashga qarshi):** brauzer echo-cancellation + shovqin kamaytirish, 100 Hz–7.5 kHz filtr, shovqin darvozasi
(jim paytda mikrofon yopiladi), chiyillashni (feedback) aniqlab, o'sha chastotani avtomatik kesuvchi filtrlar, avto-balandlik va limiter.
Mikrofon yoqilganda Transmitter dinamigi ham pasayadi (sozlanadi). Eng yaxshi natija uchun quloqchin taqing.

**Ekran uzatish sifati (Zoom kabi):** ekran asl o'lchamida (1080p–1440p) olinadi, "Matn" rejimida aniqlik afzal (`contentHint=detail`,
`maintain-resolution`), "Video" rejimida silliqlik. VP9/H264 kodek tanlanadi, bitreyt har receiver uchun tarmoq yo'qotishiga qarab
avtomatik oshadi/kamayadi (har 2 soniyada). Receiverda: to'liq ekran (iPhone uchun zaxira rejim bilan), sig'dirish/to'ldirish, ikki marta bosish.

**Eslatma:** "Yuklab olish"ni o'chirish tugmalarni yashiradi va serverda yuklab olish so'rovini rad etadi, lekin ko'rsatilayotgan
faylni brauzer baribir oladi — skrinshot/ekran yozishni to'liq to'sib bo'lmaydi.
Tashqi havola (add-url) orqali qo'shilgan fayllarda ovoz tenglashtirish ishlamaydi (brauzer CORS cheklovi), faqat umumiy ovoz/mute ishlaydi.

## v5: YouTube, barqaror sinxron, tarmoq holati

- **YouTube:** "Havola" maydoniga YouTube havolasini (watch, youtu.be, shorts, live) qo'ysangiz, video hamma qurilmada sinxron ijro etiladi
  (jonli efirlar ham). Internet va YouTube'ga kirish kerak; YouTube ovozida tenglashtirish ishlamaydi (faqat umumiy ovoz/mute).
  YouTube tezlikni o'zgartirishga imkon bermagani uchun sinxron bu yerda surish orqali to'g'rilanadi (fayllarga nisbatan ~0.3–0.6 s aniqlik).
- **Kattalashtirish:** video, YouTube, rasm va ekran efirida 🔍 (katta/kichik), ⤢ (sig'dirish/to'ldirish), ⛶ (to'liq ekran) tugmalari.
- **1:1 sinxron:** PI-boshqaruv (tezlik ±5%, ovoz balandligi o'zgarmaydi), Transmitter ham receiverlar bilan bir xil algoritmda serverdagi vaqtga tortiladi;
  qurilmaning ovoz chiqarish kechikishi (Bluetooth) avtomatik hisobga olinadi va qo'lda ham sozlanadi (±500 ms).
- **Yomon internet/Wi-Fi:** fayllar (≤64 MB) receiverlarga oldindan to'liq yuklab olinadi (ijro paytida uzilish yo'q), keyingi fayl fonda yuklanadi;
  "Play" hamma tayyor bo'lguncha (maks. 6 s) kutadi; boshlanish kechikishi receiverlarning pingiga qarab avtomatik moslanadi;
  uzilgan receiver hammani to'xtatmaydi — tezda o'zi yetib oladi; yarim uzilgan WebSocket aniqlanib, eksponensial kutish bilan qayta ulanadi.
- **Tarmoq holati:** yuqorida 📶 ko'rsatkich (ping, jitter, paket yo'qotish, sinxron farqi, bufer, efir sifati). Transmitter har bir receiverning
  ping va sinxron farqini "Receiverlar" bo'limida ko'radi.

## Cheklovlar

- Telefon brauzerlari ovozga faqat foydalanuvchi bosgandan keyin ruxsat beradi, shuning uchun Receiver "Qo'shilish" tugmasini bosishi shart.
- Bluetooth dinamiklarning o'z kechikishi (50–300 ms) bor, dastur buni bilmaydi. Natijada ikki qurilma orasida biroz farq bo'lishi mumkin.
- Xona va yuklangan fayllar vaqtinchalik: xona yopilganda yoki server qayta yoqilganda o'chadi.
- Telefon ekrani o'chsa, ba'zi brauzerlar chalishni to'xtatadi. Dastur ekranni yoniq tutishga urinadi.
# sync
