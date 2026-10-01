# Remote Help — کلاینت (Host / Viewer)

پیاده‌سازی سمت کاربر برای Remote Assistance شبیه Quick Assist:
**Signaling با Long-Polling** روی بک‌اند PHP + **انتقال واقعی تصویر/کنترل روی WebRTC (P2P)**.

> بک‌اند هرگز یک فریم تصویر یا یک رویداد ورودی را نمی‌بیند؛ فقط Control Plane است.

---

## ساختار

```text
client/
├── src/core/                 ← هستهٔ isomorphic (بدون API مرورگر/Node اختصاصی)
│   ├── protocol.js           ← پروتکل v1: state machine، matrix نقش‌ها، اعتبارسنجی input
│   ├── frame.js              ← کدک فریم (هدر ۱۶ بایتی big-endian + JPEG)
│   ├── FrameChannel.js       ← FrameSender/FrameReceiver روی DataChannel (drop-on-congestion)
│   ├── InputPolicy.js        ← سه دروازهٔ ورودی: تأیید صریح + schema + rate limit
│   ├── Negotiator.js         ← offer/answer/ice با محافظ نقش، timeout، ICE restart
│   ├── Peer.js               ← پوشش یکسان روی werift (Node) و RTCPeerConnection (مرورگر)
│   ├── SessionClient.js      ← REST کلاینت (create/join/approve/reject/close)
│   ├── iceConfig.js http.js logger.js emitter.js
│   └── signaling/            ← SignalingTransport + LongPollingTransport
├── src/host/
│   ├── HostSession.js        ← چرخهٔ عمر هاست + گیت ورودی
│   ├── FramePump.js          ← حلقهٔ FPS-ثابت کپچر→JPEG→ارسال
│   ├── capture/ScreenCapture.js  ← GDI BitBlt (koffi) + JPEG (jpeg-js)
│   ├── input/InputInjector.js    ← SendInput (koffi) با Plan خالص و تست‌پذیر
│   └── host_cli.js
├── src/viewer/
│   ├── ViewerSession.js      ← چرخهٔ عمر بیننده (answer + دریافت فریم + ارسال ورودی)
│   ├── InputSender.js        ← تولید پیام ورودی با rate limit و رد محلی کلیدهای ممنوع
│   └── viewer_cli.js
├── src/net/NetworkInterfaces.js  ← انتخاب صریح Interface (بدون failover پنهان)
├── test/                     ← unit_core / unit_input / unit_capture / unit_pump / integration_loopback
└── tools/                    ← smoke_cli.mjs + probe های Win32/GDI/close
```

---

## پیش‌نیازها

- Node.js 20+ (تست‌شده روی 24)
- **Windows 10/11** برای کپچر و تزریق ورودی (بقیهٔ هسته cross-platform است)
- وابستگی‌ها: `werift` (WebRTC در Node)، `koffi` (Win32 بدون build native)، `jpeg-js`

```powershell
cd client
npm install
```

---

## اجرای سریع

```powershell
# ۱) بک‌اند (ترمینال ۱)
php -S 127.0.0.1:8080 -t server/public server/public/router.php

# ۲) هاست — کد را نشان می‌دهد (ترمینال ۲)
node src/host/host_cli.js --server http://127.0.0.1:8080 --auto-approve

# ۳) بیننده با همان کد (ترمینال ۳)
node src/viewer/viewer_cli.js --server http://127.0.0.1:8080 --code 123-456 --frames-dir .\received
```

یک ابزار یکپارچه که کل این مسیر را خودکار می‌سنجد:

```powershell
npm run smoke      # بک‌اند موقت + host_cli + viewer_cli + ۳ فریم JPEG روی دیسک
```

---

## دستورهای هاست

```text
--server <url>      آدرس بک‌اند            (پیش‌فرض http://127.0.0.1:8080)
--monitor <n>       شمارهٔ مانیتور         (پیش‌فرض: primary)
--virtual-desktop   کل مانیتورها به‌صورت یک سطح
--max-width <px>    کوچک‌سازی پیش از JPEG  (پیش‌فرض 1280)
--quality <1-100>   کیفیت JPEG             (پیش‌فرض 60)
--fps <1-30>        نرخ هدف فریم           (پیش‌فرض 8)
--interface <name>  قفل کردن روی یک Interface (هرگز failover نمی‌کند)
--auto-approve      تأیید خودکار اولین بیننده
--allow-input       شروع با کنترل از راه دور فعال (پیش‌فرض: خاموش)
--no-input          هیچ‌گاه ورودی تزریق نکن (فقط تماشا)
--list / --help     فهرست مانیتورها و Interfaceها / راهنما
```

کلیدهای زمان اجرا: `i` روشن/خاموش کردن ورودی، `p` توقف/ادامهٔ ارسال، `d` diagnostics، `q` خروج.

## دستورهای بیننده

```text
--server <url>      آدرس بک‌اند            (پیش‌فرض http://127.0.0.1:8080)
--code <123-456>    کد جلسه (الزامی)
--interface <name>  قفل روی یک Interface
--frames-dir <dir>  ذخیرهٔ فریم‌های دریافتی به‌صورت JPEG
--max-frames <n>    توقف پس از n فریم
--stats <sec>       چاپ آمار دریافتی هر n ثانیه
--input-script <f>  اجرای پیام‌های ورودی از یک فایل JSON-lines
```

دستورهای تعاملی: `m <x> <y>` حرکت، `c` کلیک چپ، `r` راست، `b` میانی، `d` دوبار کلیک،
`w <delta>` اسکرول، `k <key>` کلید، `C <key>` با Ctrl، `S <key>` با Shift، `s` آمار، `q` خروج.


---

## تست‌ها

```powershell
npm test                 # همه: ۲۸ تست (۲۷ pass + ۱ skip اختیاری)
npm run test:unit        # protocol/frame/input/injector/capture/pump — بدون شبکه
npm run test:integration # بک‌اند واقعی php -S + دو peer واقعی werift (loopback)
npm run smoke            # مسیر کامل CLI با پروسه‌های جدا
```

پوشش:

| فایل | چه چیزی را تضمین می‌کند |
|---|---|
| `unit_core.test.js` | نسخهٔ پروتکل، جدول انتقال state، matrix نقش‌ها، اعتبارسنجی ورودی، کدک فریم، ICE، InputPolicy، ماسک لاگ |
| `unit_input.test.js` | نگاشت کلید→VK مستقل از Layout، رمزگذاری مختصات مطلق (VIRTUALDESK)، ترتیب فشردن/رهاکردن modifier، رد کلیدهای ممنوع، batch `SendInput` |
| `unit_capture.test.js` | BGRA→RGBA، کوچک‌سازی box-filter، JPEG معتبر، شمارش واقعی مانیتورها، کپچر واقعی + آزادسازی هندل‌های GDI |
| `unit_pump.test.js` | نرخ ارسال، drop-on-congestion، pause/resume، توقف کامل |
| `integration_loopback.test.js` | create→join→approve→offer/answer/ICE روی Long-Polling واقعی، فریم بایت‌به‌بایت، سه دروازهٔ ورودی، فیلتر echo خودی، auto-approve بدون race، بدون نشت توکن در diagnostics |

تزریق واقعی ورودی (اختیاری و **قابل مشاهده** — ماوس را جابه‌جا می‌کند):

```powershell
$env:RH_INJECT_SMOKE='1'; node --test test/unit_input.test.js
```

---

## تضمین‌های امنیتی

- **سه دروازهٔ ورودی:** (۱) تأیید صریح اپراتور (`allowRemoteInput`، پیش‌فرض خاموش)، (۲) اعتبارسنجی schema و محدودهٔ مختصات، (۳) rate limit token-bucket. تزریق فقط پس از عبور از هر سه انجام می‌شود.
- **Blocklist دائمی:** `lwin`/`meta`/`Alt+F4`/`Ctrl+Alt+Del` و مانند آن هرگز ساخته یا تزریق نمی‌شود (لایهٔ چهارم در `InputInjector`).
- **بدون دسترسی خودکار:** هیچ endpoint یا گزینه‌ای برای کنترل بدون تأیید وجود ندارد.
- **تصویر هرگز از سرور عبور نمی‌کند:** مسیر فریم فقط DataChannel است.
- **بدون توکن در لاگ/diagnostics:** `logger` کلیدهای حساس را ماسک می‌کند و `diagnostics()` هیچ توکنی برنمی‌گرداند (تست شده).
- **کنترل congestion با drop:** فریم‌ها در صف نمی‌مانند؛ حافظهٔ نامحدود ترجیح داده نمی‌شود.
- **بدون failover پنهان Interface:** اگر Interface انتخاب‌شده از بین برود، خطا گزارش می‌شود.
- **نگاشت کلید بر اساس VK ثابت US:** مستقل از Layout سیستم (روی Layout غیرلاتین `VkKeyScanW` مقدار -1 می‌دهد و بی‌سروصدا می‌شکند).

---

## محدودیت‌های شناخته‌شده

- **کپچر با GDI BitBlt** است، نه Desktop Duplication/DXGI (COM کامل با koffi امن نیست).
  روی 1920×1080 حدود ۳۸ms اندازه‌گیری شد — برای ۵–۱۰ fps کافی است، برای 60fps نه.
- **رندر بیننده در CLI ذخیره روی دیسک است.** در محصول واقعی همان فریم‌ها در canvas مرورگر رندر می‌شوند؛ مسیر انتقال یکی است.
- **کپچر و تزریق ورودی فقط Windows.** بقیهٔ هسته روی هر پلتفرمی import می‌شود (تست‌های pure بدون OS اجرا می‌شوند).
- **بدون STUN/TURN پیش‌فرض.** کانفیگ پیش‌فرض host-candidates-only است (LAN یا peer با IP عمومی). TURN فقط از مسیر config اضافه می‌شود، بدون تغییر کد.
- **بدون WebSocket.** حمل فعلی Long-Polling است؛ افزودن WebSocket فقط جایگزینی `SignalingTransport` است.
- `PHP_CLI_SERVER_WORKERS` روی Windows کار نمی‌دهد (fork پشتیبانی نمی‌شود)؛ به همین دلیل در محیط توسعه/تست `max_hold` کوچک نگه داشته می‌شود.

---

## عیب‌یابی

| نشانه | علت/راه‌حل |
|---|---|
| `Fatal: input injection is only supported on Windows` | `InputInjector` روی غیرویندوز یا بدون `koffi` — با `--no-input` اجرا کنید |
| `Fatal: monitor N does not exist` | `node src/host/host_cli.js --list` و انتخاب شمارهٔ درست |
| `Fatal: selected network interface ... is unavailable` | نام Interface اشتباه است؛ `--list` نام‌ها را نشان می‌دهد |
| فریم نمی‌رسد ولی اتصال برقرار است | در هاست `d` را بزنید و `dropped`/`errors` را ببینید (congestion یا BitBlt ناموفق) |
| قطع تصویر روی صفحهٔ UAC/قفل | Desktop امن است؛ BitBlt شکست می‌خورد و به‌صورت خطای قابل‌مشاهده گزارش می‌شود |
