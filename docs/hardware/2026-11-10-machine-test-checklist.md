# Gerçek makine testi: kontrol listesi (2026-11-10)

**Dal:** `claude/diy-machine-limits-xf2hg3` (hareket sınırları) + `main`'de olup makinede hiç denenmemiş işler.
**Makine:** ESP32 + FluidNC v4.0.1, `/dev/tty.usbserial-110`, 115200.

Bu belge test **öncesi** durumu gösterir: her satırın "Sonuç" sütunu boş, test sırasında doldurulacak. Aşağıdaki hiçbir madde gerçek makinede denenmedi; "Sahte kontrolcü" sütunu yalnızca simülatörde ne görüldüğünü söyler.

## Güvenlik

- Acil stop elinizin altında olsun. Kinetiq'in Hold ve Reset'i yazılım komutudur.
- Sınır şu an 200 mm, fiziksel kurs yaklaşık 400 / 410 mm. Yani sınırlama çalışmasa bile yaklaşık 200 mm pay var. Yine de ilk hareketleri **1 mm ve 10 mm adımla**, düşük hızla yapın.
- Hava testi: iş ve probe dışındaki tüm adımlarda Z yukarıda, takım boşta.
- İlk sürprizde durun, satıra not düşün, sonraki bölüme geçmeyin.

## Kurulum

```bash
git fetch origin claude/diy-machine-limits-xf2hg3
git checkout claude/diy-machine-limits-xf2hg3
npm install
npm run dev        # http://127.0.0.1:8000
```

Sorun çıkarsa konsol çıktısını ve `KINETIQ_LOG_LEVEL=silly npm run dev` ile alınan sunucu logunu saklayın.

---

## A. Hareketsiz kontroller (önce bunlar)

| # | Adım | Beklenen | Sahte kontrolcü | Sonuç |
|---|---|---|---|---|
| A1 | Bağlan | Idle veya Alarm, konumlar saniyede ~4 kez güncellenir | Geçti | |
| A2 | Position paneline bak (home öncesi) | Sarı satır: "X and Y not homed…". X ve Y jog tuşları pasif, Z tuşları aktif | Geçti | |
| A3 | X satırında "Go to" kutusu ve "Go to zero" | İkisi de pasif, sebep "not homed" | Go to zero denenmedi | |
| A4 | Bir program yükle, Start'a bak | Start pasif: "Home the machine first…" | Denenmedi | |
| A5 | Konsola `$J=G91 G21 X-1 F100` yaz | Makine **kıpırdamaz**; konsolda `[MSG:WARN: Kinetiq: jog not sent. X is not homed…]` | Geçti (jog tuşuyla) | |

## B. Homing ve "homed" durumu

Bu bölüm sınırlamanın temelidir: Kinetiq, homing'i durum raporundaki `Home` → `Idle` geçişinden anlar. FluidNC'nin `$H` sırasında `Home` durumunu raporladığı makinede hiç gözlenmedi.

| # | Adım | Beklenen | Sahte kontrolcü | Sonuç |
|---|---|---|---|---|
| B1 | Üst çubuktan Home (`$H`) | Makine sağ alta gider. Üstteki rozet homing sırasında **Home** yazar, sonra Idle | Geçti | |
| B2 | Home sonrası makine konumunu oku | **X ≈ −1.000, Y ≈ +1.000** (pulloff). Değerleri buraya yazın: X = ……, Y = …… | Fake 0, 0 verir | |
| B3 | Position paneli | Sarı uyarı gider; "X− 197.0 · X+ 0.0 · Y− 0.0 · Y+ 197.0 mm to the travel limits" benzeri satır. X+ ve Y− tuşları pasif | Geçti | |
| B4 | 3D görünüm (Top) | Kesikli dikdörtgen (tabla sınırı) görünür, takım sağ alt köşesinde | Çizgi göründü | |
| B5 | Yalnız X'i home et (X satırındaki Home, `$HX`) | Homing sırasında X "not homed" olur, bitince tekrar homed. Y etkilenmez | Denenmedi | |
| B6 | Üst çubuktan Reset (makine Idle iken) | Konum değişmez; X/Y **homed kalır**. Reset sonrası Alarm'a düşüyorsa not edin | Denenmedi | |
| B7 | ESP32'yi yeniden başlat (EN tuşu veya güç) | Kinetiq "not homed"a döner, X/Y jog yine kapanır | Denenmedi | |

**B2 kritik:** X artı çıkıyorsa veya sola jog X'i artırıyorsa testi durdurun; `HOME_END` sabiti ters demektir.

## C. Jog sınırlaması

Home edildikten sonra. Hız 500–1000 mm/dk.

| # | Adım | Beklenen | Sahte kontrolcü | Sonuç |
|---|---|---|---|---|
| C1 | Adım 1 mm: X−, sonra Y+ | X sola, Y yukarı 1 mm gider. Makine konumu X azalır, Y artar | Geçti | |
| C2 | Adım 10 mm: X− birkaç kez, Y+ birkaç kez | Her basış 10 mm; "kalan mesafe" satırı azalır | Geçti | |
| C3 | Adım 100 mm: X−'ye **3 kez** bas (her biri bitince) | 1. basış 100 mm, 2. basış sınırda biter (**X = −198**), 3. basışta tuş pasif. Konsolda "Jog shortened to the travel limit" | Geçti | |
| C4 | C3'teki kısaltılmış satır | Konsolda `$J=G53 G90 G21 X-198 F…` ve ardından `ok`. **FluidNC `$J=` içinde G53'ü kabul ediyor mu** hiç denenmedi; `error:` gelirse yazın | Fake kabul etti | |
| C5 | Aynısı Y+ için | Y = +198'de durur | Geçti | |
| C6 | Home köşesine dön: X+ ve Y− 100 mm | X = −1, Y = +1'de durur, switch'e **basmaz** (hard limit alarmı yok) | Geçti | |
| C7 | Ortadayken X−'ye **hızlıca 3–4 kez** bas (kuyruk) | Toplam hareket sınırı aşmaz, X ≥ −198 | Geçti (2 basış) | |
| C8 | Konsola `$J=G91 G21 Y500 F1000` | Y = 198'de durur | Geçti | |
| C9 | X satırında Go to: sınır dışı bir iş koordinatı gir | Sınırda durur | Denenmedi | |
| C10 | Go to zero (iş sıfırı tabla içinde) | X0 Y0'a gider | Sınırsız modda geçti | |
| C11 | Uzun jog sırasında ortadaki Stop tuşu (jog cancel) | Hemen durur. Ardından yeni jog doğru yerden hesaplanır (sınır aşılmaz) | Sınırsız modda geçti | |
| C12 | Z+ / Z− | Sınırsız, her zamanki gibi çalışır | Geçti | |

C11 önceki PR'lardan da kalan bir maddedir: jog cancel porta `0xC2 0x85` olarak gidiyor ve FluidNC'de hiç gözlenmedi. Durmuyorsa **Hold**'a basın.

## D. Firmware soft limit (config değişikliği)

Makine ayarları editöründen kaydetme + yeniden başlatma da makinede **ilk kez** çalışacak (önceki PR'dan kalan madde).

| # | Adım | Beklenen | Sahte kontrolcü | Sonuç |
|---|---|---|---|---|
| D1 | Ayarları oku | `config.yaml` gelir, fark yok | Makinede daha önce geçti (salt okuma) | |
| D2 | X ve Y: `max_travel_mm: 200`, `soft_limits: true` yap, kaydet | Yedek alınır, dosya yüklenir, geri okuma aynı | Fake'te geçti | |
| D3 | Yeniden başlat (`$Bye`) | Kart yeniden açılır, çalışan config kaydedilenle aynı; boot logunda yeni uyarı yok. Kinetiq "not homed"a döner | Fake'te geçti | |
| D4 | Home et, sonra konsola `G53 G0 X-205` yaz | Makine **hareket etmez**; `ALARM:2` veya `error`. (Fiziksel kurs 400 olduğundan yanlış gitse bile güvenli) | Yok | |
| D5 | D4'ten sonra Unlock | Idle; X/Y homed kalır (alarm 2 konumu korur) | Denenmedi | |
| D6 | Konsola `G53 G0 Y-5` | Reddedilir (home tarafı) | Yok | |

D4 hareket ederse hemen Hold: soft limit devrede değildir, `$CD` çıktısını saklayın.

## E. İş sığma kontrolü

Küçük bir test dosyası (örneğin 50 × 50 mm kare) ile, Z yukarıda.

| # | Adım | Beklenen | Sahte kontrolcü | Sonuç |
|---|---|---|---|---|
| E1 | Tablanın ortasına git, X ve Y'yi sıfırla, dosyayı yükle | Job panelinde "Fits the travel limits", Start aktif | Hesap doğrulandı, arayüz denenmedi | |
| E2 | Home köşesinde X/Y sıfırla (iş sağa/aşağı taşar) | Start pasif; "Outside travel limits: X+ by … mm" gibi yön ve mesafe. 3D'de dikdörtgen **kırmızı** | Hesap doğrulandı, arayüz denenmedi | |
| E3 | Uzak köşeye yakın sıfırla | Start pasif; X− ve/veya Y+ taşması yazar | Aynı | |
| E4 | Sıfırı tekrar ortaya al | Uyarı kendiliğinden kalkar, Start açılır | Denenmedi | |
| E5 | İçinde `G28` veya `G92` olan bir dosya yükle | Sarı "Fits, partly unchecked"; Start açık kalır | Hesap doğrulandı | |
| E6 | Yükseklik haritası: ızgarayı sınır dışına taşır | Probe başlat pasif, sebep "The area leaves the travel limits…" | Denenmedi | |

## F. Önceki PR'lardan kalanlar (TypeScript backend, `REWRITE_HARDWARE_CHECK.md` satır 2–10)

Backend TypeScript'e çevrildikten sonra `main`'e, hareketli satırlar denenmeden alındı. Bunlar hâlâ açık.

| # | Adım | Beklenen | Sonuç |
|---|---|---|---|
| F1 | Unlock / Home (satır 2) | B1 ile birlikte kapanır | |
| F2 | Her adım boyuyla X/Y/Z jog (satır 3) | Komut edilen mesafe ve yön. C1–C2 ile birlikte | |
| F3 | Jog cancel (satır 4) | C11 ile birlikte | |
| F4 | İş sırasında feed / spindle override +10, −10, +1, −1, reset (satır 5) | Job panelindeki değerler her adımı izler | |
| F5 | M0 veya M6 içeren kısa hava işi (satır 6) | M0/M6'da durur, Resume ile devam eder, iş biter, yol grileşir | |
| F6 | İş ortasında Pause / Resume (satır 7) | Feed hold, sonra devam; satır kaybı yok | |
| F7 | İş ortasında Stop (satır 8) | Hold, sonra soft reset; workflow idle; konum doğru. **Yeni:** X/Y homed kalmalı; Alarm'a düşüp "not homed" oluyorsa not edin | |
| F8 | Dokunma plakasıyla Probe Z (satır 9) | Dokunur, geri çekilir, Z sıfırı ayarlanır | |
| F9 | Ayar kaydet + yeniden başlat (satır 10) | D2–D3 ile birlikte | |
| F10 | Mutlak jog `$J=G90` | C9–C10 ile birlikte | |

Tümü geçerse `docs/BACKEND_REWRITE_PLAN.md`'de faz 6 "tamam" işaretlenir.

## G. Diğer açık maddeler

| # | Kaynak | Adım | Beklenen | Sonuç |
|---|---|---|---|---|
| G1 | Yükseklik haritası (`BED_LEVELING.md`) | Küçük bir ızgara (3 × 3, 20 × 20 mm) probe et | Her noktada temas, harita dolar; hiç gerçek makinede çalışmadı | |
| G2 | Aynı | Haritalı (leveled) işi yükle ve çalıştır | Z haritaya göre düzeltilir; iş sıfırı değişirse Start kapanır | |
| G3 | Kalan süre tahmini (PR #6) | 2–5 dakikalık bir işte tahmini ve gerçek süreyi karşılaştır | Başlangıç tahmini ……, gerçek ……. Fake'te %1 içindeydi; gerçek ivmeyle hiç ölçülmedi | |
| G4 | Aynı | Feed override değiştir | Kalan süre buna göre güncellenir | |
| G5 | Bağlantı | Sayfayı yenile / ikinci sekme aç | Port yeniden açılmadan bağlanır; "homed" durumu ve sınırlar yeni sekmede de doğru gelir | |

---

## Test öncesi bilinen eksikler

- Kinetiq konsoldan yazılan `G0` / `G1` satırlarını ve çalışan işin satırlarını sınırlamaz. Bunları yalnızca D bölümündeki firmware soft limit durdurur; D geçmeden gerçek iş çalıştırmayın.
- Sığma kontrolü `G28`, `G92`, `G10` ve iş koordinat sistemi değişimini hesaplayamaz; uyarı verir, engellemez.
- 200 mm geçicidir. Gerçek ölçüler gelince `TRAVEL_LIMIT_MM` ve config'teki `max_travel_mm` birlikte güncellenecek; o zaman C3, C5 ve D4 yeni değerlerle tekrarlanmalı (bu kez pay yalnızca 2 mm olacak).
- Home tarafındaki 1 mm boşluk `pulloff_mm: 1` varsayımına dayanır; B2'de okunan değer farklıysa güncellenmeli.

## Test sonrası bana iletilecekler

1. B2'deki X ve Y değerleri ve sola/yukarı jog'da işaretler.
2. C4: `$J=G53 …` satırına gelen yanıt.
3. B6 ve F7: Reset / Stop sonrası durum (Idle mi Alarm mı) ve konum.
4. Geçmeyen her satırın numarası ve konsol çıktısı.
5. Ölçtüyseniz gerçek kurs boyları (X, Y).
