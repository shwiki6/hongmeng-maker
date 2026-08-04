<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireMethod('POST');
requireAdmin();
migrate();

$quantity = (int) ($_POST['quantity'] ?? 0);
$remark   = trim((string) ($_POST['remark'] ?? ''));
$rawExpires = trim((string) ($_POST['expires_at'] ?? ''));
$keyword  = trim((string) ($_POST['keyword'] ?? ''));

if ($quantity < 1 || $quantity > 1000) {
    jsonOut(['success' => false, 'message' => '数量必须在1-1000之间'], 400);
}

if (mb_strlen($remark) > 200) {
    jsonOut(['success' => false, 'message' => '备注不能超过200字'], 400);
}

if (mb_strlen($keyword) > 50) {
    jsonOut(['success' => false, 'message' => '关联关键词不能超过50字'], 400);
}

$expiresAt = null;
if ($rawExpires !== '') {
    $expiresAt = normalizeDateTime($rawExpires);
    if ($expiresAt === null) {
        jsonOut(['success' => false, 'message' => '过期时间格式无效，应为 YYYY-MM-DD HH:MM:SS'], 400);
    }
}

$chars    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
$charsLen = strlen($chars);
$pdo      = db();
$keys     = [];

$stmt = $pdo->prepare('INSERT INTO card_keys (key_code, remark, expires_at, keyword) VALUES (?, ?, ?, ?)');

$pdo->beginTransaction();
try {
    for ($i = 0; $i < $quantity; $i++) {
        $inserted = false;

        for ($attempt = 0; $attempt < 50 && !$inserted; $attempt++) {
            $raw = '';
            for ($j = 0; $j < 16; $j++) {
                $raw .= $chars[random_int(0, $charsLen - 1)];
            }
            $formatted = substr($raw, 0, 4) . '-' . substr($raw, 4, 4)
                . '-' . substr($raw, 8, 4) . '-' . substr($raw, 12, 4);

            try {
                $stmt->execute([$formatted, $remark, $expiresAt, $keyword !== '' ? $keyword : null]);
                $keys[]   = $formatted;
                $inserted = true;
            } catch (PDOException $e) {
                // 23000 = 唯一约束冲突，重试；其余错误直接抛出
                if ($e->getCode() !== '23000') {
                    throw $e;
                }
            }
        }

        if (!$inserted) {
            throw new RuntimeException('卡密生成失败：重复率过高，请重试');
        }
    }

    $pdo->commit();
    jsonOut(['success' => true, 'data' => $keys, 'count' => count($keys)]);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('generate failed: ' . $e->getMessage());
    $message = $e instanceof RuntimeException ? $e->getMessage() : '生成失败，请重试';
    jsonOut(['success' => false, 'message' => $message], 500);
}
