# Remote Help Project

ابزار Remote Assistance برای ویندوز، شبیه Quick Assist — با تمرکز بر شبکه‌های داخلی ایران
و استقرار **روی هاست اشتراکی** (بدون Docker/Node/WebSocket/UDP).

```text
Shared Hosting (PHP + MySQL, فقط Signaling)
        │
   Session Code + Approve
        │
   ┌────┴────┐
Host (Windows) ↔ WebRTC P2P ↔ Viewer (Windows)
   Screen ↓ Input            ↑ نمایش + کنترل
```

**Backend تصویر یا Input را عبور نمی‌دهد** — فقط Control Plane:
ساخت جلسه، تأیید، و پیام‌های Signaling (offer/answer/ice). انتقال واقعی داده P2P/WebRTC است.

مخزن: <https://github.com/PersianPl/Remote-help-project>

---

## وضعیت فعلی

| مرحله | وضعیت |
|---|---|
| Backend / Control Plane (Session + Signaling Long-Polling) | ✅ پیاده‌سازی‌شده — **۸۸ تست سبز** |
| WebRTC Client (abstraction ها + Long-Polling Transport) | ✅ پیاده‌سازی‌شده — **۲۸ تست سبز کلاینت** |
| Windows Screen Capture / Remote Input / انتخاب Interface | ✅ پیاده‌سازی‌شده (GDI + SendInput + انتخاب Interface) |
| تست استقرار روی هاست واقعی (DirectAdmin/LiteSpeed/HTTPS) | ⏳ نیازمند هاست + دامنه |

## ساختار مخزن

```text
remote-help-project/
├── .gitignore / .gitattributes  ← نادیده‌گرفتن config.php و دادهٔ محلی، نرمال‌سازی LF
├── server/                  ← Backend (PHP 8.1+)
│   ├── public/              ← document root دامنه
│   ├── api/ signaling/ session/ auth/ storage/
│   ├── config/config.example.php
│   ├── tests/run_tests.php  ← تست‌های یکپارچه (php tests/run_tests.php) → PASSED: 88
│   ├── tools/host_probe.php ← سنجش هاست قبل از استقرار
│   └── README.md            ← راهنمای استقرار ۷ گامی
├── client/                  ← کلاینت Host/Viewer (Node 20+)
│   ├── src/core/            ← protocol، frame، Negotiator، Peer، InputPolicy، signaling
│   ├── src/host/            ← HostSession + کپچر GDI + تزریق SendInput + FramePump + host_cli
│   ├── src/viewer/          ← ViewerSession + InputSender + viewer_cli
│   ├── src/net/             ← انتخاب صریح Interface (بدون failover)
│   ├── test/                ← ۲۸ تست (unit + integration loopback واقعی)
│   ├── tools/smoke_cli.mjs  ← smoke کامل مسیر CLI
│   └── README.md            ← راهنمای کلاینت، دستورها، امنیت، محدودیت‌ها
└── shared/protocol/         ← قرارداد پروتکل (v1.md + v1.schema.json)
```

## شروع سریع (توسعه محلی)

```powershell
# نیاز: PHP 8.1+ با pdo_sqlite / pdo_mysql
php -S 127.0.0.1:8080 -t server/public server/public/router.php   # اجرا
php server/tests/run_tests.php                                    # تست‌ها → PASSED: 88

# کلاینت (Node 20+، ویندوز برای کپچر/ورودی)
cd client; npm install
node src/host/host_cli.js   --server http://127.0.0.1:8080 --auto-approve   # هاست + کد جلسه
node src/viewer/viewer_cli.js --server http://127.0.0.1:8080 --code 123-456 # بیننده
npm test        # ۲۸ تست کلاینت
npm run smoke   # مسیر کامل CLI (بک‌اند موقت + هاست + بیننده + فریم روی دیسک)
```

## مستندات

- **پروتکل:** [`shared/protocol/v1.md`](shared/protocol/v1.md) — endpointها، state machine، matrix نقش‌ها، کدهای خطا (به‌همراه `v1.schema.json`)
- **کلاینت:** [`client/README.md`](client/README.md) — نصب، دستورها، تست‌ها، تضمین‌های امنیتی، محدودیت‌ها، عیب‌یابی
- **استقرار بک‌اند:** [`server/README.md`](server/README.md) — ۷ گام تا production روی هاست اشتراکی

## مخزن گیت

```powershell
git clone <repo-url>; cd remote-help-project
# فایل‌های بیرون از گیت (باید دستی ساخته شوند):
Copy-Item server/config/config.example.php server/config/config.php   # سپس مقادیر را پر کنید
cd client; npm ci
```

`.gitignore` عمداً اینها را رد می‌کند: `server/config/config.php` (کلیدها/رمز دیتابیس)،
`server/storage/*.sqlite*`، `server/storage/logs/`، `node_modules/`، `client/received/`، `*.log`.
هیچ توکن، رمز یا دادهٔ جلسه‌ای در تاریخچهٔ مخزن وجود ندارد.

## امنیت — چه چیزهایی عمداً وجود ندارد

این ابزار برای **کمک داوطلبانه با اطلاع کاربر** طراحی شده و عمداً فاقد اینهاست:
Unattended access، Stealth/Persistence، Keylogging، Remote shell، اجرای دلخواه فرمان،
Recording یا ذخیره Screen/Clipboard روی سرور.

کد جلسه تصادفی CSPRNG، توکن‌ها فقط به‌صورت hash ذخیره می‌شوند، TTL و Rate Limit فعال است،
و Signaling فقط پس از تأیید Host با matrix نقش‌ها مجاز است.

سمت کلاینت هم: کنترل از راه دور **پیش‌فرض خاموش** است و فقط با تأیید صریح اپراتور فعال می‌شود،
کلیدهای خطرناک (Win/Alt+F4/Ctrl+Alt+Del) در blocklist دائمی هستند و تصویر هرگز از سرور عبور نمی‌کند.

