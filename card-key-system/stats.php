<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireAdmin();
migrate();

$pdo = db();

/* 卡密状态分布 */
$cardStatus = ['unused' => 0, 'assigned' => 0, 'used' => 0, 'expired' => 0, 'revoked' => 0];
$cardTotal = 0;
foreach ($pdo->query("SELECT status, COUNT(*) AS c FROM card_keys GROUP BY status") as $row) {
    $cardStatus[$row['status']] = (int) $row['c'];
    $cardTotal += (int) $row['c'];
}

/* 按关键词统计卡密 */
$cardByKeyword = [];
foreach ($pdo->query("
    SELECT COALESCE(keyword, '') AS kw,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unused,
           SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) AS assigned,
           SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used,
           SUM(CASE WHEN status IN ('expired', 'revoked') THEN 1 ELSE 0 END) AS invalid
    FROM card_keys
    GROUP BY keyword
    ORDER BY total DESC
") as $row) {
    $cardByKeyword[] = [
        'keyword'  => $row['kw'] !== '' ? $row['kw'] : '（未关联）',
        'total'    => (int) $row['total'],
        'unused'   => (int) $row['unused'],
        'assigned' => (int) $row['assigned'],
        'used'     => (int) $row['used'],
        'invalid'  => (int) $row['invalid'],
    ];
}

/* 最近 7 天核销趋势（按 used_at） */
$trend = [];
for ($i = 6; $i >= 0; $i--) {
    $day = date('Y-m-d', strtotime("-{$i} day"));
    $trend[$day] = 0;
}
$usedStmt = $pdo->prepare("SELECT DATE(used_at) AS d, COUNT(*) AS c FROM card_keys
    WHERE used_at IS NOT NULL AND used_at >= ?
    GROUP BY d");
$usedStmt->execute([date('Y-m-d 00:00:00', strtotime('-6 day'))]);
foreach ($usedStmt->fetchAll() as $row) {
    if (isset($trend[$row['d']])) {
        $trend[$row['d']] = (int) $row['c'];
    }
}
$usedTrend = [];
foreach ($trend as $day => $count) {
    $usedTrend[] = ['date' => $day, 'count' => $count];
}

/* 邀请码统计 */
$inviteStatus = ['unused' => 0, 'assigned' => 0, 'used' => 0, 'revoked' => 0];
$inviteTotal = 0;
foreach ($pdo->query("SELECT status, COUNT(*) AS c FROM invite_codes GROUP BY status") as $row) {
    $inviteStatus[$row['status']] = (int) $row['c'];
    $inviteTotal += (int) $row['c'];
}
// 邀请码由第三方网站生成，本系统只负责发放，是否真正使用无从得知。
// 统计口径：总数 / 已发放(assigned+used) / 未发放(unused)。
$inviteByWebsite = [];
foreach ($pdo->query("
    SELECT website,
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('assigned', 'used') THEN 1 ELSE 0 END) AS issued,
           SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unissued
    FROM invite_codes
    GROUP BY website
    ORDER BY total DESC
") as $row) {
    $inviteByWebsite[] = [
        'website'  => $row['website'],
        'total'    => (int) $row['total'],
        'issued'   => (int) $row['issued'],
        'unissued' => (int) $row['unissued'],
    ];
}

jsonOut([
    'success' => true,
    'card'    => [
        'total'      => $cardTotal,
        'status'     => $cardStatus,
        'by_keyword' => $cardByKeyword,
        'used_trend' => $usedTrend,
    ],
    'invite'  => [
        'total'      => $inviteTotal,
        'issued'     => $inviteStatus['assigned'] + $inviteStatus['used'],
        'unissued'   => $inviteStatus['unused'],
        'by_website' => $inviteByWebsite,
    ],
]);
