<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireAdmin();
migrate();

$status   = trim((string) ($_GET['status'] ?? ''));
$page     = max(1, (int) ($_GET['page'] ?? 1));
$pageSize = 20;
$offset   = ($page - 1) * $pageSize;

$allowed = ['', 'unused', 'assigned', 'used', 'expired', 'revoked'];
if (!in_array($status, $allowed, true)) {
    jsonOut(['success' => false, 'message' => '非法的状态筛选值'], 400);
}

$pdo    = db();
$where  = $status !== '' ? 'WHERE status = :status' : '';
$params = $status !== '' ? [':status' => $status] : [];

$countStmt = $pdo->prepare("SELECT COUNT(*) FROM card_keys $where");
$countStmt->execute($params);
$total = (int) $countStmt->fetchColumn();

$stmt = $pdo->prepare("SELECT * FROM card_keys $where ORDER BY id DESC LIMIT :limit OFFSET :offset");
if ($status !== '') {
    $stmt->bindValue(':status', $status, PDO::PARAM_STR);
}
$stmt->bindValue(':limit', $pageSize, PDO::PARAM_INT);
$stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
$stmt->execute();
$keys = $stmt->fetchAll();

foreach ($keys as &$key) {
    $key['status_text'] = STATUS_TEXT[$key['status']] ?? $key['status'];
}
unset($key);

jsonOut([
    'success' => true,
    'data'    => $keys,
    'pagination' => [
        'page'        => $page,
        'page_size'   => $pageSize,
        'total'       => $total,
        'total_pages' => $total > 0 ? (int) ceil($total / $pageSize) : 0,
    ],
]);
