<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireMethod('POST');
requireAdmin();

$sql = <<<SQL
CREATE TABLE IF NOT EXISTS card_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_code TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'unused' CHECK(status IN ('unused', 'assigned', 'used', 'expired', 'revoked')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME,
    expires_at DATETIME,
    remark TEXT,
    owner_openid TEXT
);
CREATE INDEX IF NOT EXISTS idx_key_code ON card_keys(key_code);
CREATE INDEX IF NOT EXISTS idx_status ON card_keys(status);
SQL;

try {
    $pdo = db();
    $pdo->exec($sql);
    migrate();
    jsonOut(['success' => true, 'message' => '数据库初始化成功']);
} catch (PDOException $e) {
    jsonOut(['success' => false, 'message' => '初始化失败: ' . $e->getMessage()], 500);
}
