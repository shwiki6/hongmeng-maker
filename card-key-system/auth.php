<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'POST' && $action === 'login') {
    $input    = json_decode((string) file_get_contents('php://input'), true);
    $username = trim((string) ($input['username'] ?? ''));
    $password = (string) ($input['password'] ?? '');

    $rate = checkLoginRateLimit($username);
    if (!$rate['allowed']) {
        header('Retry-After: ' . $rate['retry_after']);
        jsonOut(['success' => false, 'message' => '登录尝试过多，请稍后再试'], 429);
    }

    $config = loadAdminConfig();

    if ($username === $config['username'] && password_verify($password, (string) $config['password_hash'])) {
        clearLoginFailures($username);
        startSession();
        session_regenerate_id(true);          // 防会话固定
        $_SESSION['admin_logged_in'] = true;
        $_SESSION['admin_username']  = $config['username'];
        jsonOut(['success' => true, 'message' => '登录成功']);
    }

    recordLoginFailure($username);
    jsonOut(['success' => false, 'message' => '用户名或密码错误'], 401);
}

if ($method === 'POST' && $action === 'logout') {
    startSession();
    session_unset();
    session_destroy();
    jsonOut(['success' => true, 'message' => '已退出']);
}

if ($method === 'GET' && $action === 'check') {
    $loggedIn = isAdmin();
    jsonOut([
        'success'   => true,
        'logged_in' => $loggedIn,
        'username'  => $loggedIn ? ($_SESSION['admin_username'] ?? null) : null,
    ]);
}

jsonOut(['success' => false, 'message' => '无效请求'], 400);
