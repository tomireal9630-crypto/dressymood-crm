<?php
/* =========================================================================
   mail.php — кладётся на КАЖДЫЙ лендинг (drop-in замена старого файла).
   Отправляет заявку в CRM (dressymood-crm) + в Telegram-группу.
   Google-форма больше НЕ используется.
   --------------------------------------------------------------------------
   НАСТРОЙ ПОД КОНКРЕТНЫЙ ЛЕНДИНГ (только этот блок):
   ========================================================================= */

$ARTICLE   = '№67';        // Артикул товара этого лендинга
$PRODUCT   = 'Сукня';      // Название товара
$PRICE     = '990';        // Цена
$SUPPLIER  = 'Демкина';    // Поставщик

// Адрес CRM и секретный ключ (ключ = значение LANDING_API_KEY в Render)
$CRM_URL   = 'https://dressymood-crm.onrender.com/api/landing/order';
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

/* --- 1. Отправка заказа в CRM --- */
$payload = http_build_query([
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
]);

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $CRM_URL);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
curl_setopt($ch, CURLOPT_POST, 1);
curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_TIMEOUT, 15);
curl_exec($ch);
curl_close($ch);

/* --- 2. Уведомление в Telegram --- */
$arr = [
    'Замовлення на -'           => $PRODUCT,
    '***********************'   => '',
    'Артикул:'                  => $ARTICLE,
    'Розмір:'                   => $size,
    'Колір:'                    => $color,
    'Постачальник:'             => $SUPPLIER,
    '***************************' => '',
    'Імя:'                      => $name,
    'Телефон:'                  => urlencode('+') . str_replace(' ', '', $phone),
    '************************'  => '',
    'З сайту:'                  => $from,
    'IP клієнта:'               => $ip,
    'Дата:'                     => $date,
];

$txt = '';
foreach ($arr as $key => $value) {
    $txt .= '<b>' . $key . '</b> ' . $value . '%0A';
}

@fopen("https://api.telegram.org/bot{$TG_TOKEN}/sendMessage?chat_id={$TG_CHAT}&parse_mode=html&text={$txt}", 'r');

/* --- 3. Редирект на страницу «спасибо» --- */
$success_url = 'send.php?name=' . urlencode($name) . '&phone=' . urlencode($phone);
header('Location: ' . $success_url);
exit;
