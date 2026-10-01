# Remote Help — Backend (هاست اشتراکی)

پیاده‌سازی Control Plane مطابق **بخش ۶۷** `remote-help-project.md`:
REST API + Signaling با **Long-Polling** روی PHP 8.1+ / MySQL (یا SQLite برای توسعه).

> چرا Long-Polling؟ هاست‌های اشتراکی WebSocket و UDP (برای STUN/TURN) ندارند.
> تصویر و کنترل از مسیر WebRTC می‌رود؛ این سرور فقط هماهنگ‌کننده است.

---

## ساختار

```text
server/
├── public/            ← document root دامنه (index.php + .htaccess + router.php)
├── api/               ← Request/Response/Router + کنترلر Session
├── signaling/         ← صف پیام + کنترلر Long-Polling
├── session/           ← State Machine، کد جلسه، Rate Limiter
├── auth/              ← توکن‌ها (SHA-256 hashed) + Guard
├── storage/           ← PDO + schema.mysql.sql / schema.sqlite.sql
├── config/            ← config.example.php (کپی به config.php)
├── tools/host_probe.php  ← سنجش هاست قبل از استقرار (فاز ۰)
└── tests/run_tests.php   ← تست‌های یکپارچه (۴۸ سناریو)
```

---

## اجرای محلی

```powershell
php -S 127.0.0.1:8080 -t public public/router.php
```

پیش‌فرض با SQLite اجرا می‌شود (بدون تنظیم).

### تست‌ها

```powershell
php tests/run_tests.php
```

سرور موقت می‌سازد، کل چرخه Session/Signaling را روی HTTP واقعی تست می‌کند و پاک می‌کند.
خروجی موفق: `PASSED: 48   FAILED: 0`.

---

## استقرار روی هاست اشتراکی (گام‌به‌گام)

1. **سنجش هاست:** فایل `tools/host_probe.php` را آپلود و در مرورگر باز کنید.
   سه چیز باید سبز باشد: ماژول `pdo_mysql`، تست Long-Polling ۸ ثانیه، اتصال MySQL.
   سپس فایل را **حذف کنید**.
2. **دیتابیس:** در پنل هاست یک MySQL بسازید (نام/کاربر/رمز را یادداشت کنید).
3. **کد:** محتوای این پوشه را آپلود کنید (مثلاً در `~/remote-help/`).
4. **تنظیم:** `config/config.example.php` را به `config/config.php` کپی و در آن:
   - `db.driver = mysql` و اطلاعات دیتابیس
   - در صورت نیاز `code_ttl` / `session_ttl` / `max_hold`
5. **دامنه:** Document Root دامنه/زیردامنه (مثلاً `api.example.ir`) را روی
   پوشه `public/` تنظیم کنید. TLS رایگان (Let's Encrypt) را فعال کنید.
6. **تست نهایی:**
   ```text
   GET https://api.example.ir/api/v1/health          → {"ok":true,"service":"remote-help-server",
                                                          "version":"1","database":"ok",...}
   GET https://api.example.ir/api/v1/health?hold=8   → پاسخ بعد از ~8 ثانیه
   POST https://api.example.ir/api/v1/sessions       → 201 + code
   ```
   اگر `database` مقدار `error` یا HTTP 503 برگشت، اطلاعات دیتابیس در `config/config.php` را چک کنید.
7. پس از استقرار، `config/config.php` هرگز از طریق وب قابل دسترسی نیست
   (بیرون از `public/` است) و `.htaccess` ریشه هم پوشه‌های حساس را مسدود می‌کند.

### بدون rewrite (اگر .htaccess کار نکرد)

مسیرها را با کوئری‌استرینگ بفرستید: `/index.php?r=/api/sessions`

---

## خلاصه API

مسیر کاننیکال `/api/v1/...` است؛ نسخه `/api/...` هم به‌عنوان alias کار می‌کند.

| متد و مسیر | نقش | خروجی |
|---|---|---|
| `GET /api/v1/health` | همه | `{ok, service, version, database, ...}` |
| `POST /api/v1/sessions` | — | `201` + `code` + `host_token` |
| `POST /api/v1/sessions/{کد}/join` | — | `viewer_token` (یک‌بارمصرف) |
| `POST /api/v1/sessions/{id}/approve` | host | `state=approved` |
| `POST /api/v1/sessions/{id}/reject` | host | `state=closed` |
| `POST /api/v1/sessions/{id}/close` | هر دو | `state=closed` |
| `GET /api/v1/sessions/{id}` | participant | وضعیت + نقش |
| `GET /api/v1/signal?since=&hold=` | participant | `{messages[], state}` (نگه‌داشته می‌شود) |
| `POST /api/v1/signal` | participant | `201 {id}` — فقط پس از approve؛ matrix نقش‌ها اجرا می‌شود |

نمونه پاسخ Health:

```json
{"ok": true, "service": "remote-help-server", "version": "1",
 "database": "ok", "db_latency_ms": 1.2, "time": 1790800000,
 "php": "8.3.3", "held": 0.0, "max_hold": 20}
```

قرارداد کامل پیام‌ها: **`shared/protocol/v1.md`** و `shared/protocol/v1.schema.json`.

---

## ملاحظات امنیتی

- توکن‌ها فقط به‌صورت hash (SHA-256) در DB نگه داشته می‌شوند؛ در Log نمی‌آیند.
- کد جلسه با CSPRNG ساخته می‌شود + Rate Limit روی `join` (هر IP و هر کد).
- Signaling (offer/answer/ice) فقط پس از `approve` مجاز است.
- حداکثر اندازه پیام Signal: `max_payload_bytes` (پیش‌فرض 256KB).
- Security headers روی همه پاسخ‌ها: `X-Content-Type-Options: nosniff`، `X-Frame-Options: DENY`، `Referrer-Policy: no-referrer`.
- State machine سخت‌گیرانه: هر انتقال خارج از جدول `SessionState::ALLOWED` رد می‌شود.
- Matrix نقش‌ها در Signaling: `offer` فقط host، `answer` فقط viewer (پاسخ 403 در غیر این صورت).
- Expiration تنبل (lazy) انجام می‌شود — هر درخواست وضعیت انقضا را چک می‌کند.
- TURN/STUN در این حالت وجود ندارد؛ پس از Decision Gate (بخش 67.4) اضافه شود.

## توسعه بعدی

اگر VPS تهیه شد، فقط کافی است در کلاینت `transport` از `long_polling`
به `websocket` عوض شود — پیام‌ها و State Machine تغییری نمی‌کنند.
