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

$pdo = db();
$now = date('Y-m-d H:i:s');

// IMMEDIATE 事务：立即取写锁，避免并发下两个请求同时读到可核销状态。
$pdo->exec('BEGIN IMMEDIATE');
try {
    $stmt = $pdo->prepare('SELECT * FROM card_keys WHERE key_code = ?');
    $stmt->execute([$keyCode]);
    $key = $stmt->fetch();

    if (!$key) {
        $pdo->exec('ROLLBACK');
        jsonOut(['success' => true, 'redeemed' => false, 'message' => '卡密不存在', 'data' => null]);
    }

    // 过期优先判定
    if (in_array($key['status'], ['unused', 'assigned'], true) && !empty($key['expires_at'])) {
        $normalized = normalizeDateTime((string) $key['expires_at']);
        if ($normalized !== null && $normalized <= $now) {
            $pdo->prepare("UPDATE card_keys SET status = 'expired' WHERE id = ? AND status IN ('unused', 'assigned')")
                ->execute([$key['id']]);
            $key['status'] = 'expired';
        }
    }

    if (!in_array($key['status'], ['unused', 'assigned'], true)) {
        $pdo->exec('COMMIT');
        jsonOut([
            'success'  => true,
            'redeemed' => false,
            'message'  => '卡密无法核销：' . (STATUS_TEXT[$key['status']] ?? $key['status']),
            'data'     => [
                'key_code'    => $key['key_code'],
                'status'      => $key['status'],
                'status_text' => STATUS_TEXT[$key['status']] ?? $key['status'],
                'used_at'     => $key['used_at'],
                'expires_at'  => $key['expires_at'],
            ],
        ]);
    }

    // 条件更新：仍处于可核销状态才生效，杜绝重复核销。
    $upd = $pdo->prepare(
        "UPDATE card_keys SET status = 'used', used_at = ? WHERE id = ? AND status IN ('unused', 'assigned')"
    );
    $upd->execute([$now, $key['id']]);

    if ($upd->rowCount() !== 1) {
        $pdo->exec('ROLLBACK');
        jsonOut(['success' => true, 'redeemed' => false, 'message' => '卡密已被核销'], 409);
    }

    $pdo->exec('COMMIT');

    jsonOut([
        'success'  => true,
        'redeemed' => true,
        'message'  => '核销成功',
        'data'     => [
            'key_code'    => $key['key_code'],
            'status'      => 'used',
            'status_text' => STATUS_TEXT['used'],
            'used_at'     => $now,
            'expires_at'  => $key['expires_at'],
            'remark'      => $key['remark'],
        ],
    ]);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->exec('ROLLBACK');
    }
    error_log('redeem failed: ' . $e->getMessage());
    jsonOut(['success' => false, 'message' => '核销失败，请重试'], 500);
}
