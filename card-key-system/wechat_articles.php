<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireAdmin();

/** WeChat article management is intentionally isolated from the passive callback. */
function articleConfig(): array
{
    if (!is_file(WECHAT_CONFIG_PATH)) {
        jsonOut(['success' => false, 'message' => '公众号配置缺失'], 500);
    }
    $cfg = json_decode((string) file_get_contents(WECHAT_CONFIG_PATH), true);
    if (!is_array($cfg)) {
        jsonOut(['success' => false, 'message' => '公众号配置损坏'], 500);
    }
    return $cfg;
}

function articleAccessToken(array $cfg): string
{
    $appid = trim((string) ($cfg['appid'] ?? ''));
    $secret = trim((string) ($cfg['secret'] ?? ''));
    if ($appid === '' || $secret === '') {
        jsonOut(['success' => false, 'message' => '请先在接口参数中配置 AppID 和 AppSecret'], 400);
    }

    $ch = curl_init('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' . rawurlencode($appid) . '&secret=' . rawurlencode($secret));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_SSL_VERIFYPEER => true]);
    $raw = curl_exec($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if ($raw === false || $raw === '') {
        jsonOut(['success' => false, 'message' => '获取微信 access_token 失败' . ($error !== '' ? '：' . $error : '')], 502);
    }
    $data = json_decode((string) $raw, true);
    if (!is_array($data) || empty($data['access_token'])) {
        jsonOut(['success' => false, 'message' => '微信鉴权失败：' . (string) ($data['errmsg'] ?? '未知错误')], 502);
    }
    return (string) $data['access_token'];
}

function articleWechatJson(string $url, array $payload, string $method = 'POST'): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json; charset=utf-8'],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
    ]);
    $raw = curl_exec($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if ($raw === false || $raw === '') {
        jsonOut(['success' => false, 'message' => '请求微信接口失败' . ($error !== '' ? '：' . $error : '')], 502);
    }
    $data = json_decode((string) $raw, true);
    if (!is_array($data)) {
        jsonOut(['success' => false, 'message' => '微信接口返回格式无效'], 502);
    }
    if ((int) ($data['errcode'] ?? 0) !== 0) {
        jsonOut(['success' => false, 'message' => '微信接口错误：' . (string) ($data['errmsg'] ?? $data['errcode'])], 502);
    }
    return $data;
}

function articleUploadCover(string $token, array $file): string
{
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        jsonOut(['success' => false, 'message' => '封面上传失败，请重新选择图片'], 400);
    }
    if ((int) ($file['size'] ?? 0) > 2 * 1024 * 1024) {
        jsonOut(['success' => false, 'message' => '封面图片不能超过 2MB'], 400);
    }
    $tmp = (string) ($file['tmp_name'] ?? '');
    $mime = function_exists('mime_content_type') ? (string) mime_content_type($tmp) : '';
    if (!in_array($mime, ['image/jpeg', 'image/png', 'image/gif'], true)) {
        jsonOut(['success' => false, 'message' => '封面仅支持 JPG、PNG 或 GIF'], 400);
    }

    $ch = curl_init('https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=' . rawurlencode($token) . '&type=image');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ['media' => new CURLFile($tmp, $mime, 'cover.' . ($mime === 'image/png' ? 'png' : 'jpg'))],
    ]);
    $raw = curl_exec($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if ($raw === false || $raw === '') {
        jsonOut(['success' => false, 'message' => '上传封面到微信失败' . ($error !== '' ? '：' . $error : '')], 502);
    }
    $data = json_decode((string) $raw, true);
    if (!is_array($data) || empty($data['media_id'])) {
        jsonOut(['success' => false, 'message' => '微信封面素材上传失败：' . (string) ($data['errmsg'] ?? '未知错误')], 502);
    }
    return (string) $data['media_id'];
}

function articleText(string $key, int $max, bool $required = false): string
{
    $value = trim((string) ($_POST[$key] ?? ''));
    if ($required && $value === '') {
        jsonOut(['success' => false, 'message' => $key . '不能为空'], 400);
    }
    if (mb_strlen($value) > $max) {
        jsonOut(['success' => false, 'message' => $key . '不能超过 ' . $max . ' 个字符'], 400);
    }
    return $value;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonOut(['success' => false, 'message' => '仅支持 POST 请求'], 405);
}

$cfg = articleConfig();
$token = articleAccessToken($cfg);
$action = (string) ($_POST['action'] ?? '');

if ($action === 'upload_cover') {
    $mediaId = articleUploadCover($token, $_FILES['cover'] ?? []);
    jsonOut(['success' => true, 'media_id' => $mediaId, 'message' => '封面素材上传成功']);
}

if ($action !== 'create_draft' && $action !== 'publish') {
    jsonOut(['success' => false, 'message' => '无效操作'], 400);
}

if ($action === 'create_draft') {
    $title = articleText('title', 64, true);
    $author = articleText('author', 32);
    $digest = articleText('digest', 120);
    $content = trim((string) ($_POST['content'] ?? ''));
    if ($content === '' || mb_strlen($content) > 200000) {
        jsonOut(['success' => false, 'message' => '正文不能为空且不能超过 200000 个字符'], 400);
    }
    $contentSourceUrl = articleText('content_source_url', 512);
    if ($contentSourceUrl !== '' && !preg_match('#^https?://[^\s]+$#i', $contentSourceUrl)) {
        jsonOut(['success' => false, 'message' => '原文链接必须是 http:// 或 https:// 地址'], 400);
    }
    $thumbMediaId = articleText('thumb_media_id', 128);
    if ($thumbMediaId === '' && isset($_FILES['cover'])) {
        $thumbMediaId = articleUploadCover($token, $_FILES['cover']);
    }
    if ($thumbMediaId === '') {
        jsonOut(['success' => false, 'message' => '请上传封面或填写 thumb_media_id'], 400);
    }
    $data = articleWechatJson(
        'https://api.weixin.qq.com/cgi-bin/draft/add?access_token=' . rawurlencode($token),
        ['articles' => [[
            'title' => $title,
            'author' => $author,
            'digest' => $digest,
            'content' => $content,
            'content_source_url' => $contentSourceUrl,
            'thumb_media_id' => $thumbMediaId,
            'need_open_comment' => 0,
            'only_fans_can_comment' => 0,
        ]]]
    );
    jsonOut(['success' => true, 'media_id' => (string) ($data['media_id'] ?? ''), 'message' => '草稿创建成功，请确认后发布']);
}

$draftMediaId = articleText('draft_media_id', 128);
if ($draftMediaId === '') {
    jsonOut(['success' => false, 'message' => '请填写草稿 media_id'], 400);
}
articleWechatJson('https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=' . rawurlencode($token), ['media_id' => $draftMediaId]);
jsonOut(['success' => true, 'message' => '文章已提交发布']);
