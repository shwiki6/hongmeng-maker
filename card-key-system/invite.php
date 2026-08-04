<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireAdmin();
migrate();

$method = $_SERVER['REQUEST_METHOD'];

/* ---------------------------------------------------------------- 按状态清理 */
if ($method === 'POST' && (($_GET['action'] ?? '') === 'clear')) {
    $input = json_decode((string) file_get_contents('php://input'), true);
    $status = (string) (is_array($input) ? ($input['status'] ?? '') : '');
    if (!in_array($status, ['unused', 'assigned', 'used', 'revoked'], true)) {
        jsonOut(['success' => false, 'message' => '非法的状态值'], 400);
    }
    $stmt = db()->prepare('DELETE FROM invite_codes WHERE status = ?');
    $stmt->execute([$status]);
    $text = ['unused' => '未发放', 'assigned' => '已发放', 'used' => '已使用', 'revoked' => '已作废'];
    jsonOut(['success' => true, 'message' => '已清理 ' . $stmt->rowCount() . ' 条「' . ($text[$status] ?? $status) . '」邀请码']);
}

/* ---------------------------------------------------------------- 删除 */
if ($method === 'POST' && (($_GET['action'] ?? '') === 'delete')) {
    $input = json_decode((string) file_get_contents('php://input'), true);
    $ids = is_array($input) ? ($input['ids'] ?? []) : [];
    if (!is_array($ids) || $ids === []) {
        jsonOut(['success' => false, 'message' => '请选择要删除的邀请码'], 400);
    }
    $ids = array_map('intval', $ids);
    $ids = array_values(array_filter($ids, static function ($id) {
        return $id > 0;
    }));
    if ($ids === []) {
        jsonOut(['success' => false, 'message' => '无效的 ID'], 400);
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = db()->prepare("DELETE FROM invite_codes WHERE id IN ($placeholders)");
    $stmt->execute($ids);
    jsonOut(['success' => true, 'message' => '已删除 ' . $stmt->rowCount() . ' 条邀请码']);
}

if ($method === 'POST') {
    $input = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($input)) {
        jsonOut(['success' => false, 'message' => '请求格式错误'], 400);
    }

    $website = trim((string) ($input['website'] ?? ''));
    $keyword = trim((string) ($input['keyword'] ?? ''));
    $codesRaw = (string) ($input['codes'] ?? '');

    if ($website === '' || mb_strlen($website) > 100) {
        jsonOut(['success' => false, 'message' => '网站名称不能为空且不超过 100 字符'], 400);
    }
    if ($keyword === '') {
        jsonOut(['success' => false, 'message' => '触发关键词不能为空'], 400);
    }
    if (mb_strlen($keyword) > 30 || !preg_match('/^[\p{Han}A-Za-z0-9]+$/u', $keyword)) {
        jsonOut(['success' => false, 'message' => '触发关键词仅限中文/字母/数字，最长 30 字符'], 400);
    }

    $codes = [];
    foreach (preg_split('/\r\n|\r|\n/', $codesRaw) ?: [] as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        if (mb_strlen($line) > 200) {
            jsonOut(['success' => false, 'message' => "邀请码「{$line}」过长（最多 200 字符）"], 400);
        }
        $codes[$line] = true;
    }
    if ($codes === []) {
        jsonOut(['success' => false, 'message' => '请至少粘贴一个邀请码（每行一个）'], 400);
    }

    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO invite_codes (website, keyword, code) VALUES (?, ?, ?)');
    $pdo->beginTransaction();
    $inserted = 0;
    $skipped = 0;
    try {
        foreach (array_keys($codes) as $code) {
            try {
                $stmt->execute([$website, $keyword, $code]);
                $inserted++;
            } catch (PDOException $e) {
                // 23000 = 唯一约束冲突（重复邀请码），跳过
                if ($e->getCode() !== '23000') {
                    throw $e;
                }
                $skipped++;
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('invite import failed: ' . $e->getMessage());
        jsonOut(['success' => false, 'message' => '导入失败'], 500);
    }

    jsonOut([
        'success'  => true,
        'message'  => "成功导入 {$inserted} 条邀请码" . ($skipped > 0 ? "（跳过重复 {$skipped} 条）" : ''),
        'inserted' => $inserted,
        'skipped'  => $skipped,
    ]);
}

/* ---------------------------------------------------------------- 列表 */
if ($method === 'GET') {
    $page = max(1, (int) ($_GET['page'] ?? 1));
    $pageSize = 20;
    $offset = ($page - 1) * $pageSize;

    $website = trim((string) ($_GET['website'] ?? ''));
    $status  = trim((string) ($_GET['status'] ?? ''));
    $allowed = ['', 'unused', 'assigned', 'used', 'revoked'];
    if (!in_array($status, $allowed, true)) {
        jsonOut(['success' => false, 'message' => '非法的状态筛选值'], 400);
    }

    $where = [];
    $params = [];
    if ($website !== '') {
        $where[] = 'website LIKE :website';
        $params[':website'] = '%' . $website . '%';
    }
    if ($status !== '') {
        $where[] = 'status = :status';
        $params[':status'] = $status;
    }
    $whereSql = $where !== [] ? 'WHERE ' . implode(' AND ', $where) : '';

    $pdo = db();
    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM invite_codes $whereSql");
    $countStmt->execute($params);
    $total = (int) $countStmt->fetchColumn();

    $stmt = $pdo->prepare("SELECT * FROM invite_codes $whereSql ORDER BY id DESC LIMIT :limit OFFSET :offset");
    foreach ($params as $k => $v) {
        $stmt->bindValue($k, $v, PDO::PARAM_STR);
    }
    $stmt->bindValue(':limit', $pageSize, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();

    $statusText = ['unused' => '未使用', 'assigned' => '已发放', 'used' => '已使用', 'revoked' => '已作废'];
    foreach ($rows as &$row) {
        $row['status_text'] = $statusText[$row['status']] ?? $row['status'];
    }
    unset($row);

    jsonOut([
        'success' => true,
        'data'    => $rows,
        'pagination' => [
            'page'        => $page,
            'page_size'   => $pageSize,
            'total'       => $total,
            'total_pages' => $total > 0 ? (int) ceil($total / $pageSize) : 0,
        ],
    ]);
}

jsonOut(['success' => false, 'message' => '无效请求'], 400);
