<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

// This endpoint is intentionally separate from validate.php: the app must not
// embed the administrator API token that protects the management endpoints.
requireMethod('POST');
migrate();

$rate = checkAppActivationRateLimit();
if (!$rate['allowed']) {
    header('Retry-After: ' . $rate['retry_after']);
    jsonOut(['success' => false, 'activated' => false, 'message' => '请求过于频繁，请稍后再试'], 429);
}

$keyCode = strtoupper(trim((string) ($_POST['key_code'] ?? '')));
if (!preg_match('/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/', $keyCode)) {
    jsonOut(['success' => true, 'activated' => false, 'message' => '卡密格式无效'], 400);
}

$pdo = db();
$now = date('Y-m-d H:i:s');

// A public App cannot hold the administrator token required by redeem.php.
// Consume the key here with the same conditional-update semantics, so the
// management backend records activation without exposing credentials.
$pdo->exec('BEGIN IMMEDIATE');
try {
    $stmt = $pdo->prepare('SELECT id, status, expires_at FROM card_keys WHERE key_code = ?');
    $stmt->execute([$keyCode]);
    $key = $stmt->fetch();

    if (!$key) {
        $pdo->exec('ROLLBACK');
        recordAppActivationFailure();
        jsonOut(['success' => true, 'activated' => false, 'message' => '卡密无效']);
    }

    if (in_array($key['status'], ['unused', 'assigned'], true) && !empty($key['expires_at'])) {
        $expiresAt = normalizeDateTime((string) $key['expires_at']);
        if ($expiresAt !== null && $expiresAt <= $now) {
            $pdo->prepare("UPDATE card_keys SET status = 'expired' WHERE id = ? AND status IN ('unused', 'assigned')")
                ->execute([$key['id']]);
            $key['status'] = 'expired';
        }
    }

    if (!in_array($key['status'], ['unused', 'assigned'], true)) {
        $pdo->exec('COMMIT');
        recordAppActivationFailure();
        $message = $key['status'] === 'used' ? '卡密已使用' : '卡密已失效';
        jsonOut(['success' => true, 'activated' => false, 'message' => $message]);
    }

    $redeem = $pdo->prepare(
        "UPDATE card_keys SET status = 'used', used_at = ? WHERE id = ? AND status IN ('unused', 'assigned')"
    );
    $redeem->execute([$now, $key['id']]);
    if ($redeem->rowCount() !== 1) {
        $pdo->exec('ROLLBACK');
        recordAppActivationFailure();
        jsonOut(['success' => true, 'activated' => false, 'message' => '卡密已被使用']);
    }

    $pdo->exec('COMMIT');
    clearAppActivationFailures();

    // Return only the countdown contract; never reveal key, owner, or usage details.
    $expiresAtUnix = null;
    if (!empty($key['expires_at'])) {
        $expiresAt = normalizeDateTime((string) $key['expires_at']);
        if ($expiresAt !== null) {
            $timestamp = strtotime($expiresAt);
            $expiresAtUnix = $timestamp === false ? null : $timestamp;
        }
    }
    jsonOut([
        'success' => true,
        'activated' => true,
        'redeemed' => true,
        'message' => '激活成功',
        'expires_at_unix' => $expiresAtUnix,
        'server_time_unix' => time(),
    ]);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->exec('ROLLBACK');
    }
    error_log('app activation failed: ' . $e->getMessage());
    jsonOut(['success' => false, 'activated' => false, 'message' => '激活服务异常，请重试'], 500);
}
