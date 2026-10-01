<?php
declare(strict_types=1);

/**
 * Remote Help — shared hosting capability probe (architecture doc, section 67.5).
 *
 * Upload this single file to your hosting (e.g. public_html/host_probe.php),
 * open it in a browser, run the tests, then DELETE the file.
 * Standalone by design: it does not load the backend bootstrap.
 *
 * حالت API: ?hold=N → اتصال را N ثانیه نگه می‌دارد و گزارش می‌دهد.
 */

if (isset($_GET['hold'])) {
    $hold = max(0.0, min((float) $_GET['hold'], 60.0));
    $start = microtime(true);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no');
    while ((microtime(true) - $start) < $hold) {
        if (connection_aborted()) {
            break;
        }
        usleep(200000);
    }
    echo json_encode([
        'ok' => true,
        'held' => round(microtime(true) - $start, 3),
        'php' => PHP_VERSION,
        'sapi' => PHP_SAPI,
    ]);
    exit;
}

// MySQL اگر ست شده باشد تست می‌شود (اینجا پر کنید یا بعداً در config.php):
$mysql = ['host' => '', 'name' => '', 'user' => '', 'pass' => ''];

$checks = [];
foreach (['pdo', 'pdo_mysql', 'json', 'openssl'] as $ext) {
    $checks[$ext] = extension_loaded($ext);
}
?>
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>Remote Help — سنجش هاست</title>
<style>
 body { font-family: Tahoma, sans-serif; direction: rtl; margin: 2rem auto; max-width: 720px; color: #222; }
 table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
 td, th { border: 1px solid #ccc; padding: .45rem .7rem; text-align: right; }
 .ok { color: #087f23; font-weight: bold; } .bad { color: #c0392b; font-weight: bold; }
 button { font-size: 1rem; padding: .5rem 1.2rem; cursor: pointer; }
 #result { margin-top: 1rem; padding: .8rem; background: #f5f5f5; border-radius: 6px; white-space: pre-line; }
</style>
</head>
<body>
<h1>سنجش زیرساخت هاست برای Remote Help</h1>
<p>این صفحه بررسی می‌کند آیا هاست شرایط اجرای Long-Polling را دارد (بخش 67.5 معماری).
 بعد از اتمام، این فایل را حذف کنید.</p>

<h2>۱. محیط PHP</h2>
<table>
 <tr><th>نسخه PHP</th><td><?= htmlspecialchars(PHP_VERSION) ?></td></tr>
 <tr><th>SAPI</th><td><?= htmlspecialchars(PHP_SAPI) ?></td></tr>
 <tr><th>max_execution_time</th><td><?= (int) ini_get('max_execution_time') ?> ثانیه</td></tr>
 <tr><th>memory_limit</th><td><?= htmlspecialchars((string) ini_get('memory_limit')) ?></td></tr>
 <tr><th>output_buffering</th><td><?= htmlspecialchars((string) ini_get('output_buffering')) ?></td></tr>
</table>

<h2>۲. ماژول‌های لازم</h2>
<table>
<?php foreach ($checks as $name => $loaded): ?>
 <tr><th><?= htmlspecialchars($name) ?></th>
     <td class="<?= $loaded ? 'ok' : 'bad' ?>"><?= $loaded ? 'فعال ✓' : 'غیرفعال ✗' ?></td></tr>
<?php endforeach; ?>
</table>

<h2>۳. تست Long-Polling (مهم‌ترین تست)</h2>
<p>یک درخواست HTTP باز می‌ماند و <b>۸ ثانیه</b> بعد جواب می‌گیرد. اگر هاست اتصال را زود قطع کند، این تست شکست می‌خورد.</p>
<button onclick="runHold()">شروع تست ۸ ثانیه‌ای</button>
<div id="result">در انتظار…</div>

<h2>۴. تست MySQL (اختیاری)</h2>
<p>مقادیر را داخل فایل پر کنید و صفحه را رفرش کنید.</p>
<div id="mysql" class="<?= $mysql['host'] !== '' ? ($mysqlResult ? 'ok' : 'bad') : '' ?>">
<?php
$mysqlResult = false;
if ($mysql['host'] !== '') {
    try {
        $pdo = new PDO(
            'mysql:host=' . $mysql['host'] . ';dbname=' . $mysql['name'] . ';charset=utf8mb4',
            $mysql['user'],
            $mysql['pass'],
            [PDO::ATTR_TIMEOUT => 5]
        );
        $mysqlResult = true;
        echo '<span class="ok">اتصال MySQL برقرار شد ✓</span>';
    } catch (Throwable $e) {
        echo '<span class="bad">خطای MySQL: ' . htmlspecialchars($e->getMessage()) . '</span>';
    }
} else {
    echo 'تست نشده (مقادیر خالی است).';
}
?>
</div>

<script>
async function runHold() {
  const box = document.getElementById('result');
  box.textContent = 'در حال تست… اتصال باید ۸ ثانیه باز بماند.';
  const t0 = performance.now();
  try {
    const r = await fetch('host_probe.php?hold=8', { cache: 'no-store' });
    const data = await r.json();
    const elapsed = (performance.now() - t0) / 1000;
    const pass = data.held >= 7.5 && elapsed >= 7.5;
    box.textContent = (pass ? '✓ موفق — ' : '✗ ناموفق — ')
      + 'اتصال ' + elapsed.toFixed(1) + ' ثانیه نگه داشته شد (سرور گزارش: '
      + data.held + 's). PHP ' + data.php + ' / ' + data.sapi
      + (pass ? '\nهاست برای Long-Polling مناسب است.' : '\nهاست احتمالاً اتصال را زود قطع می‌کند؛ پشتیبانی بگیرید.');
  } catch (e) {
    box.textContent = '✗ خطا: ' + e.message;
  }
}
</script>
</body>
</html>
