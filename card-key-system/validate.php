<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireMethod('POST');
requireApiAccess();
migrate();

$keyCode = strtoupper(trim((string) ($_POST['key_code'] ?? '')));

if ($keyCode === '') {
    jsonOut(['success' => false, 'message' => '卡密不能为空'], 400);
}

$pdo  = db();
$stmt = $pdo->prepare('SELECT * FROM card_keys WHERE key_code = ?');
$stmt->execute([$keyCode]);
$key = $stmt->fetch();

if (!$key) {
    jsonOut([
        'success' => true,
        'valid'   => false,
        'message' => '卡密不存在',
        'data'    => null,
    ]);
}

// 惰性过期：未发放和已发放但未核销的卡均可过期。
if (in_array($key['status'], ['unused', 'assigned'], true) && !empty($key['expires_at'])) {
    $normalized = normalizeDateTime((string) $key['expires_at']);
    if ($normalized !== null && $normalized <= date('Y-m-d H:i:s')) {
        $pdo->prepare("UPDATE card_keys SET status = 'expired' WHERE id = ? AND status IN ('unused', 'assigned')")
            ->execute([$key['id']]);
        $key['status'] = 'expired';
    }
}

$valid = in_array($key['status'], ['unused', 'assigned'], true);

jsonOut([
    'success' => true,
    'valid'   => $valid,
    'message' => $valid ? '卡密有效' : '卡密无效',
    'data'    => [
        'key_code'    => $key['key_code'],
        'status'      => $key['status'],
        'status_text' => STATUS_TEXT[$key['status']] ?? $key['status'],
        'created_at'  => $key['created_at'],
        'used_at'     => $key['used_at'],
        'expires_at'  => $key['expires_at'],
        'remark'      => $key['remark'],
    ],
]);
