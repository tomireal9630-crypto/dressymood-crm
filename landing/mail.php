<?php
/* =========================================================================
   mail.php — кладётся на КАЖДЫЙ лендинг (drop-in замена старого файла).
   Отправляет заявку в CRM (dressymood-crm) + в Telegram-группу.

   ВАЖНО, чем отличается от старой версии:
   сначала посетителя СРАЗУ отправляем на страницу «спасибо» и закрываем
   соединение, и только потом шлём заказ в CRM и Telegram. Раньше браузер
   ждал оба внешних запроса (до 15 сек) — кнопка «висела».
   --------------------------------------------------------------------------
   НАСТРОЙ ПОД КОНКРЕТНЫЙ ЛЕНДИНГ (только этот блок):
   ========================================================================= */

$ARTICLE   = '№67';        // Артикул товара — ТОЧНО как в CRM (Склад), без лишних точек/пробелов
$PRODUCT   = 'Сукня';      // Название товара
$PRICE     = '990';        // Цена
$SUPPLIER  = 'Демкина';    // Поставщик

// Адрес CRM и секретный ключ (ключ = значение LANDING_API_KEY на сервере CRM)
$CRM_URL   = 'https://crm.viollini.store/api/landing/order';
$API_KEY   = 'ВСТАВЬ_СЮДА_LANDING_API_KEY';

// Telegram (как и раньше — шлёт сам этот файл)
$TG_TOKEN  = 'ВСТАВЬ_ТОКЕН_БОТА';
$TG_CHAT   = '-1001889026396';

/* ========================================================================= */

date_default_timezone_set('Europe/Kiev');

$name  = trim($_POST['name'] ?? '');
$phone = trim($_POST['phone'] ?? '');
$size  = trim($_POST['size'] ?? '');
$color = trim($_POST['color'] ?? '');

// Пустая заявка — ничего не делаем
if ($name === '' || $phone === '') {
    echo 'success';
    exit;
}

$from = $_SERVER['HTTP_REFERER'] ?? '';
$ip   = $_SERVER['REMOTE_ADDR'] ?? '';
$date = date('Y-m-d / H:i:s');

/* --- 1. СРАЗУ отпускаем браузер на страницу «спасибо» --------------------
   Всё, что ниже, выполняется уже без ожидания посетителем.               */
$success_url = 'send.php?name=' . urlencode($name) . '&phone=' . urlencode($phone);

ignore_user_abort(true);          // не обрывать скрипт, когда браузер ушёл
@set_time_limit(60);

while (ob_get_level() > 0) { ob_end_clean(); }
ob_start();
header('Location: ' . $success_url, true, 302);
header('Content-Length: 0');
header('Connection: close');
ob_end_flush();
flush();

if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();          // PHP-FPM
} elseif (function_exists('litespeed_finish_request')) {
    litespeed_finish_request();        // LiteSpeed
}

/* --- 2. Вспомогательные функции ----------------------------------------- */
function crm_log($msg) {
    @file_put_contents(__DIR__ . '/order_errors.log',
        date('Y-m-d H:i:s') . ' ' . $msg . PHP_EOL, FILE_APPEND);
}

function http_post($url, $fields, $timeout = 10) {
    if (!function_exists('curl_init')) return [0, '', 'curl недоступен'];
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => 1,
        CURLOPT_POST           => 1,
        CURLOPT_POSTFIELDS     => http_build_query($fields),
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_FOLLOWLOCATION => 1,
    ]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);
    return [$code, $body, $err];
}

/* --- 3. Заказ в CRM (с одной повторной попыткой) ------------------------- */
$payload = [
    'key'      => $API_KEY,
    'name'     => $name,
    'phone'    => $phone,
    'size'     => $size,
    'color'    => $color,
    'article'  => $ARTICLE,
    'product'  => $PRODUCT,
    'price'    => $PRICE,
    'supplier' => $SUPPLIER,
    'source'   => $from,
    'ip'       => $ip,
];

list($code, $body, $err) = http_post($CRM_URL, $payload);
if ($code !== 200) {
    sleep(2);
    list($code, $body, $err) = http_post($CRM_URL, $payload);
}
if ($code !== 200) {
    // Заявка НЕ дошла до CRM — пишем в лог рядом с mail.php, чтобы не потерять
    crm_log("CRM FAIL http={$code} err={$err} resp=" . substr((string) $body, 0, 200)
        . " | {$name} {$phone} {$size} {$color}");
}

/* --- 4. Уведомление в Telegram ------------------------------------------ */
$lines = [
    '<b>Замовлення на -</b> ' . $PRODUCT,
    '***********************',
    '<b>Артикул:</b> ' . $ARTICLE,
    '<b>Розмір:</b> ' . $size,
    '<b>Колір:</b> ' . $color,
    '<b>Постачальник:</b> ' . $SUPPLIER,
    '***************************',
    '<b>Імя:</b> ' . $name,
    '<b>Телефон:</b> +' . str_replace(' ', '', $phone),
    '************************',
    '<b>З сайту:</b> ' . $from,
    '<b>IP клієнта:</b> ' . $ip,
    '<b>Дата:</b> ' . $date,
];
if ($code !== 200) {
    $lines[] = '⚠️ <b>УВАГА:</b> заявка не потрапила в CRM — внеси вручну';
}

list($tgCode, , $tgErr) = http_post(
    "https://api.telegram.org/bot{$TG_TOKEN}/sendMessage",
    ['chat_id' => $TG_CHAT, 'parse_mode' => 'html', 'text' => implode("\n", $lines)],
    8
);
if ($tgCode !== 200) {
    crm_log("TG FAIL http={$tgCode} err={$tgErr}");
}

exit;
