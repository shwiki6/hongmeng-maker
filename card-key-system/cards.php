<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireAdmin();
requireMethod('POST');

$action = (string) ($_GET['action'] ?? '');
$input  = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input)) {
    jsonOut(['success' => false, 'message' => '请求格式错误'], 400);
}

/* ---------------------------------------------------------------- 按 ID 删除 */
if ($action === 'delete') {
    $ids = $input['ids'] ?? [];
    if (!is_array($ids) || $ids === []) {
        jsonOut(['success' => false, 'message' => '请选择要删除的卡密'], 400);
    }
    $ids = array_values(array_filter(array_map('intval', $ids), static function ($id) {
        return $id > 0;
    }));
    if ($ids === []) {
        jsonOut(['success' => false, 'message' => '无效的 ID'], 400);
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = db()->prepare("DELETE FROM card_keys WHERE id IN ($placeholders)");
    $stmt->execute($ids);
    jsonOut(['success' => true, 'message' => '已删除 ' . $stmt->rowCount() . ' 张卡密']);
}

/* ---------------------------------------------------------------- 按状态批量清理 */
if ($action === 'clear') {
    $status = (string) ($input['status'] ?? '');
    if (!in_array($status, ['unused', 'assigned', 'used', 'expired', 'revoked'], true)) {
        jsonOut(['success' => false, 'message' => '非法的状态值'], 400);
    }
    $stmt = db()->prepare('DELETE FROM card_keys WHERE status = ?');
    $stmt->execute([$status]);
    jsonOut([
        'success' => true,
        'message' => '已清理 ' . $stmt->rowCount() . ' 张「' . (STATUS_TEXT[$status] ?? $status) . '」卡密',
    ]);
}

jsonOut(['success' => false, 'message' => '无效请求'], 400);
