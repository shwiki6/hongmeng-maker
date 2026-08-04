<?php
/**
 * php 内置服务器（php -S）路由脚本。
 * 用法：php -S 0.0.0.0:8080 router.php
 *
 * 作用：阻止直接下载 data/ 目录内容及任意 .db / .json 文件，
 *      其余请求交由内置服务器默认处理。
 */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$path = urldecode((string) $path);

// 归一化：统一分隔符、剥离前导斜杠，并解析 . 与 .. 段防目录穿越
$path = str_replace('\\', '/', $path);
$segments = [];
foreach (explode('/', $path) as $segment) {
    if ($segment === '' || $segment === '.') {
        continue;
    }
    if ($segment === '..') {
        array_pop($segments);
        continue;
    }
    $segments[] = $segment;
}
$rel = implode('/', $segments);

$blocked = false;
if ($segments && strcasecmp($segments[0], 'data') === 0) {
    $blocked = true;                       // 整个 data/ 目录
} elseif (preg_match('/\.(db|db-wal|db-shm|sqlite|json|tmp)$/i', $rel)) {
    $blocked = true;                       // 敏感扩展名
} elseif ($segments && strcasecmp(end($segments), '.htaccess') === 0) {
    $blocked = true;
}

if ($blocked) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "403 Forbidden\n";
    return true;
}

// false = 交给内置服务器默认处理（静态文件或 PHP 脚本）
return false;
