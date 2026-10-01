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
| Backend / Control Plane (Session + Signaling Long-Polling) | ✅ پیاده‌سازی‌شده — **۷۷ تست سبز** |
| تست استقرار روی هاست واقعی (DirectAdmin/LiteSpeed/HTTPS) | ⏳ نیازمند هاست + دامنه |
| WebRTC Client (abstraction ها) | ⏳ پس از تأیید Backend روی هاست |
| Windows Screen Capture / Remote Input / انتخاب Interface | ⏳ مراحل ۱۵-۱۷ |

## ساختار مخزن

```text
remote-help-project/
├── remote-help-project.md   ← معماری کامل پروژه (۶۷ بخش)
├── پرامپت.md                ← قوانین توسعه و ترتیب اجرا
├── server/                  ← Backend (PHP 8.1+)
│   ├── public/              ← document root دامنه
│   ├── api/ signaling/ session/ auth/ storage/
│   ├── config/config.example.php
│   ├── tests/run_tests.php  ← تست‌های یکپارچه (php tests/run_tests.php)
│   ├── tools/host_probe.php ← سنجش هاست قبل از استقرار
│   └── README.md            ← راهنمای استقرار ۷ گامی
└── shared/protocol/         ← قرارداد پروتکل (v1.md + v1.schema.json)
```

## شروع سریع (توسعه محلی)

```powershell
# نیاز: PHP 8.1+ با pdo_sqlite / pdo_mysql
php -S 127.0.0.1:8080 -t server/public server/public/router.php   # اجرا
php server/tests/run_tests.php                                    # تست‌ها → PASSED: 77
```

## استقرار روی هاست اشتراکی

مراحل کامل: [`server/README.md`](server/README.md) — خلاصه:
سنجش با `host_probe.php` → ساخت MySQL → آپلود → `config/config.php` →
Document Root روی `public/` → HTTPS → تست `GET /api/v1/health`.

## مستندات

- **معماری:** [`remote-help-project.md`](remote-help-project.md) (بخش ۶۷ = استقرار هاست اشتراکی)
- **پروتکل:** [`shared/protocol/v1.md`](shared/protocol/v1.md) — endpointها، state machine، matrix نقش‌ها، کدهای خطا
- **قانون توسعه:** [`پرامپت.md`](پرامپت.md) — ترتیب مراحل و محدودیت‌ها

## امنیت — چه چیزهایی عمداً وجود ندارد

این ابزار برای **کمک داوطلبانه با اطلاع کاربر** طراحی شده و عمداً فاقد اینهاست:
Unattended access، Stealth/Persistence، Keylogging، Remote shell، اجرای دلخواه فرمان،
Recording یا ذخیره Screen/Clipboard روی سرور.

کد جلسه تصادفی CSPRNG، توکن‌ها فقط به‌صورت hash ذخیره می‌شوند، TTL و Rate Limit فعال است،
و Signaling فقط پس از تأیید Host با matrix نقش‌ها مجاز است.
