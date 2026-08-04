<?php
declare(strict_types=1);

/**
 * 公共引导文件：路径常量、JSON 输出、会话、鉴权、数据库连接。
 * 所有接口都应 require 本文件。
 */

define('DATA_DIR', __DIR__ . '/data');
define('DB_PATH', DATA_DIR . '/card_keys.db');
define('ADMIN_CONFIG_PATH', DATA_DIR . '/admin_config.json');
define('WECHAT_CONFIG_PATH', DATA_DIR . '/wechat_config.json');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');

/* ---------------------------------------------------------------- 兼容层 */

// 云端虚拟主机常见 PHP 7.x：补齐 PHP 8 函数，避免 Call to undefined function。
if (!function_exists('str_contains')) {
    function str_contains(string $haystack, string $needle): bool
    {
        return $needle === '' || strpos($haystack, $needle) !== false;
    }
}
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool
    {
        return $needle === '' || strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with(string $haystack, string $needle): bool
    {
        return $needle === '' || substr($haystack, -strlen($needle)) === $needle;
    }
}
// mbstring 扩展缺失时的 UTF-8 字符数兜底（按字符计，与 mb_strlen 语义一致）。
if (!function_exists('mb_strlen')) {
    function mb_strlen(string $string): int
    {
        if (preg_match_all('/./us', $string, $_m) === false) {
            return strlen($string);
        }
        return count($_m[0]);
    }
}

/* ---------------------------------------------------------------- 错误处理 */

// 关闭错误输出：PHP 警告/致命错误一律不打印 HTML，避免污染 JSON 响应。
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');

// 致命错误兜底：确保对外始终返回 JSON 而非空白/HTML（display_errors 已关闭）。
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err === null || !in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
        return;
    }
    if (headers_sent()) {
        return;
    }
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'success' => false,
        'message' => '服务器内部错误：' . $err['message'],
    ], JSON_UNESCAPED_UNICODE);
});

/** 输出 JSON 并终止请求。 */
function jsonOut(array $payload, int $status = 200)
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

/** 以 XML 终止请求（微信被动回复使用）。 */
function xmlOut(string $xml, int $status = 200)
{
    http_response_code($status);
    header('Content-Type: text/xml; charset=utf-8');
    echo $xml;
    exit;
}

/** 限定请求方法。 */
function requireMethod(string $method)
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) {
        jsonOut(['success' => false, 'message' => '仅支持 ' . $method . ' 请求'], 405);
    }
}

/** 启动会话（仅一次），并应用安全 cookie 参数。 */
function startSession()
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_set_cookie_params([
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    ]);
    session_start();
}

function isAdmin(): bool
{
    startSession();
    return !empty($_SESSION['admin_logged_in']);
}

/** 管理员专用接口守卫。 */
function requireAdmin()
{
    if (!isAdmin()) {
        jsonOut(['success' => false, 'message' => '未登录或登录已失效'], 401);
    }
}

function clientIp(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

function loginRateKey(string $username): string
{
    return hash('sha256', clientIp() . "\0" . strtolower(trim($username)));
}

/** @return array{allowed:bool,retry_after:int} */
function checkLoginRateLimit(string $username): array
{
    $stmt = db()->prepare('SELECT locked_until FROM login_rate_limits WHERE rate_key = ?');
    $stmt->execute([loginRateKey($username)]);
    $lockedUntil = (int) $stmt->fetchColumn();
    $now = time();
    return $lockedUntil > $now
        ? ['allowed' => false, 'retry_after' => $lockedUntil - $now]
        : ['allowed' => true, 'retry_after' => 0];
}

function recordLoginFailure(string $username): void
{
    $pdo = db();
    $key = loginRateKey($username);
    $now = time();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $stmt = $pdo->prepare('SELECT window_started_at, failures FROM login_rate_limits WHERE rate_key = ?');
        $stmt->execute([$key]);
        $state = $stmt->fetch();
        if (!$state || (int) $state['window_started_at'] + 900 <= $now) {
            $failures = 1;
            $windowStartedAt = $now;
        } else {
            $failures = (int) $state['failures'] + 1;
            $windowStartedAt = (int) $state['window_started_at'];
        }
        $lockedUntil = $failures >= 5 ? $now + 900 : 0;
        $upsert = $pdo->prepare('INSERT INTO login_rate_limits (rate_key, window_started_at, failures, locked_until)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(rate_key) DO UPDATE SET window_started_at = excluded.window_started_at, failures = excluded.failures, locked_until = excluded.locked_until');
        $upsert->execute([$key, $windowStartedAt, $failures, $lockedUntil]);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
        error_log('login rate limit update failed: ' . $e->getMessage());
    }
}

function clearLoginFailures(string $username): void
{
    db()->prepare('DELETE FROM login_rate_limits WHERE rate_key = ?')->execute([loginRateKey($username)]);
}

/** Public app activation has its own small IP rate limit to deter card guessing. */
function appActivationRateKey(): string
{
    return hash('sha256', "app-activation\0" . clientIp());
}

/** @return array{allowed:bool,retry_after:int} */
function checkAppActivationRateLimit(): array
{
    $stmt = db()->prepare('SELECT locked_until FROM activation_rate_limits WHERE rate_key = ?');
    $stmt->execute([appActivationRateKey()]);
    $lockedUntil = (int) $stmt->fetchColumn();
    $now = time();
    return $lockedUntil > $now
        ? ['allowed' => false, 'retry_after' => $lockedUntil - $now]
        : ['allowed' => true, 'retry_after' => 0];
}

function recordAppActivationFailure(): void
{
    $pdo = db();
    $key = appActivationRateKey();
    $now = time();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $stmt = $pdo->prepare('SELECT window_started_at, failures FROM activation_rate_limits WHERE rate_key = ?');
        $stmt->execute([$key]);
        $state = $stmt->fetch();
        $windowStartedAt = !$state || (int) $state['window_started_at'] + 600 <= $now ? $now : (int) $state['window_started_at'];
        $failures = !$state || $windowStartedAt === $now ? 1 : (int) $state['failures'] + 1;
        $lockedUntil = $failures >= 20 ? $now + 600 : 0;
        $upsert = $pdo->prepare('INSERT INTO activation_rate_limits (rate_key, window_started_at, failures, locked_until)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(rate_key) DO UPDATE SET window_started_at = excluded.window_started_at, failures = excluded.failures, locked_until = excluded.locked_until');
        $upsert->execute([$key, $windowStartedAt, $failures, $lockedUntil]);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->exec('ROLLBACK');
        error_log('activation rate limit update failed: ' . $e->getMessage());
    }
}

function clearAppActivationFailures(): void
{
    db()->prepare('DELETE FROM activation_rate_limits WHERE rate_key = ?')->execute([appActivationRateKey()]);
}

/** 从请求头中取出 API Token。 */
function readApiToken(): string
{
    if (!empty($_SERVER['HTTP_X_API_TOKEN'])) {
        return trim((string) $_SERVER['HTTP_X_API_TOKEN']);
    }

    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($authHeader === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $authHeader = $value;
                break;
            }
        }
    }
    if (is_string($authHeader) && preg_match('/^Bearer\s+(\S+)$/i', $authHeader, $m)) {
        return $m[1];
    }
    return '';
}

/**
 * 对外业务接口守卫：管理员会话 或 有效 API Token 均放行。
 */
function requireApiAccess()
{
    if (isAdmin()) {
        return;
    }

    $config   = loadAdminConfig();
    $expected = (string) ($config['api_token'] ?? '');
    $provided = readApiToken();

    if ($expected !== '' && $provided !== '' && hash_equals($expected, $provided)) {
        return;
    }

    jsonOut(['success' => false, 'message' => '鉴权失败：需要有效的 API Token 或管理员登录'], 401);
}

function loadAdminConfig(): array
{
    if (!is_file(ADMIN_CONFIG_PATH)) {
        jsonOut(['success' => false, 'message' => '配置文件缺失'], 500);
    }
    $config = json_decode((string) file_get_contents(ADMIN_CONFIG_PATH), true);
    if (!is_array($config) || !isset($config['username'], $config['password_hash'])) {
        jsonOut(['success' => false, 'message' => '配置文件损坏'], 500);
    }
    return $config;
}

/** 原子写入配置：先写临时文件再 rename，避免并发/中断损坏。
 *  不使用 LOCK_EX：部分运行环境（如某些 stream wrapper）不支持排他锁会抛警告。 */
function saveAdminConfig(array $config): bool
{
    $json = json_encode($config, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false) {
        return false;
    }
    $tmp = ADMIN_CONFIG_PATH . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (file_put_contents($tmp, $json) === false) {
        return false;
    }
    @chmod($tmp, 0600);
    if (!rename($tmp, ADMIN_CONFIG_PATH)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/** 原子写入公众号配置（独立文件，避免覆盖管理员凭据）。 */
function saveWechatConfig(array $config): bool
{
    $json = json_encode($config, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false) {
        return false;
    }
    $tmp = WECHAT_CONFIG_PATH . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (file_put_contents($tmp, $json) === false) {
        return false;
    }
    @chmod($tmp, 0600);
    if (!rename($tmp, WECHAT_CONFIG_PATH)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/**
 * 解析并规范化日期时间，兼容 datetime-local 的 "Y-m-d\TH:i"。
 * 返回 "Y-m-d H:i:s"，非法输入返回 null。
 */
function normalizeDateTime(string $value): ?string
{
    $value = trim($value);
    if ($value === '') {
        return null;
    }
    $formats = ['!Y-m-d H:i:s', '!Y-m-d\TH:i:s', '!Y-m-d\TH:i', '!Y-m-d H:i', '!Y-m-d'];
    foreach ($formats as $format) {
        $dt = DateTimeImmutable::createFromFormat($format, $value);
        if ($dt === false) {
            continue;
        }
        // PHP >= 8.2 返回 false 表示无错误，更早版本返回计数数组。
        $errors = DateTimeImmutable::getLastErrors();
        if ($errors === false || ($errors['warning_count'] === 0 && $errors['error_count'] === 0)) {
            return $dt->format('Y-m-d H:i:s');
        }
    }
    return null;
}

/** 惰性获取数据库连接。 */
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    if (!is_dir(DATA_DIR) && !@mkdir(DATA_DIR, 0700, true) && !is_dir(DATA_DIR)) {
        jsonOut(['success' => false, 'message' => '数据目录不可用'], 500);
    }

    try {
        $pdo = new PDO('sqlite:' . DB_PATH, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $pdo->exec('PRAGMA journal_mode=WAL');
        $pdo->exec('PRAGMA foreign_keys=ON');
        $pdo->exec('PRAGMA busy_timeout=5000');
        $pdo->exec('CREATE TABLE IF NOT EXISTS login_rate_limits (
            rate_key TEXT PRIMARY KEY,
            window_started_at INTEGER NOT NULL,
            failures INTEGER NOT NULL,
            locked_until INTEGER NOT NULL DEFAULT 0
        )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS activation_rate_limits (
            rate_key TEXT PRIMARY KEY,
            window_started_at INTEGER NOT NULL,
            failures INTEGER NOT NULL,
            locked_until INTEGER NOT NULL DEFAULT 0
        )');
    } catch (PDOException $e) {
        error_log('DB connect failed: ' . $e->getMessage());
        jsonOut(['success' => false, 'message' => '数据库连接失败'], 500);
    }

    return $pdo;
}

const STATUS_TEXT = [
    'unused'  => '未使用',
    'assigned' => '已发放',
    'used'    => '已使用',
    'expired' => '已过期',
    'revoked' => '已作废',
];

/**
 * 递增式表迁移：补齐 owner_openid，并将旧 CHECK 约束迁移为含 assigned 的状态集合。
 */
function migrate(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;

    $pdo = db();
    // 表不存在时直接创建，避免新部署/DB 未上传时后续 CREATE INDEX 报 "no such table"。
    $pdo->exec("CREATE TABLE IF NOT EXISTS card_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_code TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused', 'assigned', 'used', 'expired', 'revoked')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used_at DATETIME,
        expires_at DATETIME,
        remark TEXT,
        owner_openid TEXT,
        keyword TEXT
    )");
    // 注意：PRAGMA table_info 的第 0 列是 cid（整数），列名在 'name' 字段
    $cols = $pdo->query('PRAGMA table_info(card_keys)')->fetchAll(PDO::FETCH_ASSOC);
    $names = array_column($cols, 'name');

    if ($names && !in_array('owner_openid', $names, true)) {
        $pdo->exec('ALTER TABLE card_keys ADD COLUMN owner_openid TEXT');
    }
    if ($names && !in_array('keyword', $names, true)) {
        $pdo->exec('ALTER TABLE card_keys ADD COLUMN keyword TEXT');
    }
    $tableSql = (string) $pdo->query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'card_keys'")->fetchColumn();
    if ($tableSql !== '' && !str_contains($tableSql, "'assigned'")) {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $pdo->exec("ALTER TABLE card_keys RENAME TO card_keys_legacy");
            $pdo->exec("CREATE TABLE card_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key_code TEXT UNIQUE NOT NULL,
                status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused', 'assigned', 'used', 'expired', 'revoked')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                used_at DATETIME,
                expires_at DATETIME,
                remark TEXT,
                owner_openid TEXT,
                keyword TEXT
            )");
            $pdo->exec('INSERT INTO card_keys (id, key_code, status, created_at, used_at, expires_at, remark, owner_openid, keyword)
                SELECT id, key_code, status, created_at, used_at, expires_at, remark, owner_openid, keyword FROM card_keys_legacy');
            $pdo->exec('DROP TABLE card_keys_legacy');
            $pdo->exec('COMMIT');
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->exec('ROLLBACK');
            }
            throw $e;
        }
    }
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_key_code ON card_keys(key_code)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_status ON card_keys(status)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_owner ON card_keys(owner_openid)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_card_keyword ON card_keys(keyword)');

    // 邀请码表：按网站批量导入，每个网站可配置独立触发关键词。
    $pdo->exec("CREATE TABLE IF NOT EXISTS invite_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        website TEXT NOT NULL,
        keyword TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused', 'assigned', 'used', 'revoked')),
        owner_openid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used_at DATETIME,
        remark TEXT
    )");
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_invite_keyword ON invite_codes(keyword)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_invite_status ON invite_codes(status)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_invite_owner ON invite_codes(owner_openid)');
}

/**
 * 为某个用户（openid）原子地发放一张卡密——每用户一张。
 *
 * - 若该 openid 已领取过，直接返回原卡（含已核销/过期状态）。
 * - 否则在 BEGIN IMMEDIATE 事务中认领一张 unused 卡，并发下仅一个请求成功，
 *   且认领与名下已有卡互斥，杜绝重复发放。
 *
 * @return array{ok:bool, reason:string, key:?array}
 *   reason: claimed | already_owned | empty | expired | used | error
 */
function dispatchKeyForUser(string $openid, string $trigger): array
{
    $openid = trim($openid);
    if ($openid === '') {
        return ['ok' => false, 'reason' => 'error', 'key' => null];
    }

    $pdo = db();
    $now = date('Y-m-d H:i:s');

    // 名下是否已有卡：按状态返回真实原因，便于回复文案
    $owned = $pdo->prepare('SELECT * FROM card_keys WHERE owner_openid = ?');
    $owned->execute([$openid]);
    if ($row = $owned->fetch()) {
        switch ($row['status']) {
            case 'unused':
            case 'assigned':
                $reason = 'already_owned';
                break;
            case 'used':
                $reason = 'used';
                break;
            case 'expired':
                $reason = 'expired';
                break;
            default:
                $reason = 'already_owned';
        }
        return ['ok' => true, 'reason' => $reason, 'key' => $row];
    }

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // 锁定后重新检查，避免两个并发请求均在事务外看到“未领取”。
        $owned->execute([$openid]);
        if ($row = $owned->fetch()) {
            $pdo->exec('COMMIT');
            return ['ok' => true, 'reason' => $row['status'] === 'expired' ? 'expired' : ($row['status'] === 'used' ? 'used' : 'already_owned'), 'key' => $row];
        }

        // 认领一张 unused 卡；领取不等于核销，保持为可验证/核销状态。
        // 优先从与触发关键词同名的卡池认领；同关键词卡不足时回退到未关联关键词的通用卡池。
        $stmt = $pdo->prepare(
            "UPDATE card_keys
                SET status = 'assigned', owner_openid = ?
              WHERE id = (
                  SELECT id FROM card_keys
                   WHERE status = 'unused'
                     AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?)
                     AND (? = '' OR keyword = ? OR keyword IS NULL OR keyword = '')
                   ORDER BY CASE WHEN keyword = ? THEN 0 ELSE 1 END
                   LIMIT 1
              )
              AND status = 'unused'"
        );
        $stmt->execute([$openid, $now, $trigger, $trigger, $trigger]);

        if ($stmt->rowCount() === 1) {
            $card = $pdo->prepare('SELECT * FROM card_keys WHERE owner_openid = ?');
            $card->execute([$openid]);
            $pdo->exec('COMMIT');
            return ['ok' => true, 'reason' => 'claimed', 'key' => $card->fetch()];
        }

        // 无可发放卡：区分是否已耗尽 / 全部过期
        if ($trigger !== '') {
            $kwCount = $pdo->prepare('SELECT COUNT(*) FROM card_keys WHERE keyword = ? OR keyword IS NULL OR keyword = ?');
            $kwCount->execute([$trigger, '']);
            $has = (int) $kwCount->fetchColumn() > 0;
            $pdo->exec('COMMIT');
            return ['ok' => false, 'reason' => $has ? 'expired' : 'empty', 'key' => null];
        }
        $any = $pdo->query("SELECT COUNT(*) FROM card_keys")->fetchColumn();
        $pdo->exec('COMMIT');
        return ['ok' => false, 'reason' => $any > 0 ? 'expired' : 'empty', 'key' => null];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
        error_log('dispatch failed: ' . $e->getMessage());
        return ['ok' => false, 'reason' => 'error', 'key' => null];
    }
}

/**
 * 为某个用户（openid）原子地发放一张指定关键词的邀请码——每用户每关键词一张。
 *
 * @return array{ok:bool, reason:string, invite:?array, website:string}
 *   reason: claimed | already_owned | empty | error
 */
function dispatchInviteCodeForUser(string $openid, string $keyword): array
{
    $openid  = trim($openid);
    $keyword = trim($keyword);
    if ($openid === '' || $keyword === '') {
        return ['ok' => false, 'reason' => 'error', 'invite' => null, 'website' => ''];
    }

    $pdo = db();
    // 名下是否已领取过该关键词的邀请码
    $owned = $pdo->prepare('SELECT * FROM invite_codes WHERE owner_openid = ? AND keyword = ?');
    $owned->execute([$openid, $keyword]);
    if ($row = $owned->fetch()) {
        return ['ok' => true, 'reason' => 'already_owned', 'invite' => $row, 'website' => (string) $row['website']];
    }

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // 锁定后复查，防并发重复发放
        $owned->execute([$openid, $keyword]);
        if ($row = $owned->fetch()) {
            $pdo->exec('COMMIT');
            return ['ok' => true, 'reason' => 'already_owned', 'invite' => $row, 'website' => (string) $row['website']];
        }

        $stmt = $pdo->prepare(
            "UPDATE invite_codes
                SET status = 'assigned', owner_openid = ?
              WHERE id = (
                  SELECT id FROM invite_codes
                   WHERE keyword = ? AND status = 'unused'
                   LIMIT 1
              )
              AND status = 'unused'"
        );
        $stmt->execute([$openid, $keyword]);

        if ($stmt->rowCount() === 1) {
            $row = $pdo->prepare('SELECT * FROM invite_codes WHERE owner_openid = ? AND keyword = ?');
            $row->execute([$openid, $keyword]);
            $invite = $row->fetch();
            $pdo->exec('COMMIT');
            return ['ok' => true, 'reason' => 'claimed', 'invite' => $invite, 'website' => (string) ($invite['website'] ?? '')];
        }

        $pdo->exec('COMMIT');
        return ['ok' => false, 'reason' => 'empty', 'invite' => null, 'website' => ''];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
        error_log('invite dispatch failed: ' . $e->getMessage());
        return ['ok' => false, 'reason' => 'error', 'invite' => null, 'website' => ''];
    }
}
