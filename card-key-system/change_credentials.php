<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireMethod('POST');
requireAdmin();

$config = loadAdminConfig();
$input  = json_decode((string) file_get_contents('php://input'), true);

if (!is_array($input)) {
    jsonOut(['success' => false, 'message' => '请求体格式错误'], 400);
}

$currentPassword = (string) ($input['current_password'] ?? '');

if (!password_verify($currentPassword, (string) $config['password_hash'])) {
    jsonOut(['success' => false, 'message' => '当前密码验证失败'], 403);
}

$newUsername = trim((string) ($input['new_username'] ?? ''));
$newPassword = (string) ($input['new_password'] ?? '');

if ($newUsername === '' || $newPassword === '') {
    jsonOut(['success' => false, 'message' => '用户名和新密码不能为空'], 400);
}

if (mb_strlen($newUsername) > 64) {
    jsonOut(['success' => false, 'message' => '用户名不能超过64字符'], 400);
}

if (strlen($newPassword) < 8) {
    jsonOut(['success' => false, 'message' => '新密码至少8位'], 400);
}

if (strtolower($newPassword) === strtolower($newUsername)) {
    jsonOut(['success' => false, 'message' => '密码不能与用户名相同'], 400);
}

$config['username']      = $newUsername;
$config['password_hash'] = password_hash($newPassword, PASSWORD_DEFAULT);

if (!saveAdminConfig($config)) {
    jsonOut(['success' => false, 'message' => '保存失败'], 500);
}

// 凭据变更后重建会话
startSession();
session_regenerate_id(true);
$_SESSION['admin_username'] = $newUsername;

jsonOut(['success' => true, 'message' => '修改成功']);
