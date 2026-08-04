<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

migrate();

/* ---------------------------------------------------------------- 配置 */

/**
 * 归一化的关键词规则列表：每条为 {keyword, reply, action}，action ∈ issue|text。
 * - issue：发放一张卡密并注入 {{card_key}}
 * - text：仅回复文案，不发卡
 * 旧配置（trigger_words + reply_description）自动迁移为一条 issue 规则。
 */
function wechatKeywordRules(): array
{
    $cfg = wechatConfig();
    $raw = $cfg['keyword_rules'] ?? null;
    if (!is_array($raw) || $raw === []) {
        $words = [];
        foreach (explode(',', (string) ($cfg['trigger_words'] ?? '快手')) as $w) {
            $w = trim($w);
            if ($w !== '') {
                $words[] = $w;
            }
        }
        $reply = (string) ($cfg['reply_description'] ?? '');
        $raw = [];
        foreach ($words as $w) {
            $raw[] = ['keyword' => $w, 'reply' => $reply, 'action' => 'issue'];
        }
    }
    $rules = [];
    foreach ($raw as $rule) {
        if (!is_array($rule)) {
            continue;
        }
        $kw = trim((string) ($rule['keyword'] ?? ''));
        if ($kw === '') {
            continue;
        }
        $rules[] = [
            'keyword' => $kw,
            'reply'   => (string) ($rule['reply'] ?? ''),
            'action'  => (($rule['action'] ?? 'text') === 'issue') ? 'issue' : 'text',
        ];
    }
    return $rules;
}

/** 发卡关键词列表（action=issue），用于提示语与 {{trigger_words}} 占位符。 */
function wechatTriggerWords(): array
{
    $words = [];
    foreach (wechatKeywordRules() as $rule) {
        if ($rule['action'] === 'issue') {
            $words[] = $rule['keyword'];
        }
    }
    return $words !== [] ? $words : ['快手'];
}

/** 当前发卡关键词（顿号分隔串），供后台展示与占位符替换。 */
function wechatTriggerWordsString(): string
{
    return implode(' / ', wechatTriggerWords());
}

/** 关注公众号后的默认欢迎文案（未配置问答菜单时使用，不可配置）。 */
function wechatSubscribeReply(): string
{
    return strtr('欢迎关注！回复“{{trigger_words}}”即可领取你的专属卡密（每用户限一张），发送“' . wechatMenuKeyword() . '”查看服务菜单。', [
        '{{trigger_words}}' => wechatTriggerWordsString(),
    ]);
}

/** 无匹配关键词时的提示文案；留空则静默不回复。 */
function wechatNoMatchReply(): string
{
    $cfg = wechatConfig();
    return trim((string) ($cfg['no_match_reply'] ?? ''));
}

/* ---------------------------------------------------------------- 自动回复问答菜单 */

/** 问答菜单配置：{title, options:[{label, reply}]}。 */
function wechatAutoReply(): array
{
    $cfg = wechatConfig();
    $options = [];
    foreach ((array) ($cfg['auto_reply_options'] ?? []) as $o) {
        if (!is_array($o)) {
            continue;
        }
        $label = trim((string) ($o['label'] ?? ''));
        if ($label === '') {
            continue;
        }
        $options[] = ['label' => $label, 'reply' => (string) ($o['reply'] ?? '')];
    }
    return ['title' => trim((string) ($cfg['auto_reply_title'] ?? '')), 'options' => $options];
}

/** 问答菜单的展示文案（标题 + 编号选项列表）。 */
function wechatAutoReplyMenu(): string
{
    $ar = wechatAutoReply();
    if ($ar['options'] === []) {
        return '';
    }
    $lines = [];
    if ($ar['title'] !== '') {
        $lines[] = $ar['title'];
    }
    foreach ($ar['options'] as $i => $o) {
        $lines[] = ($i + 1) . '. ' . $o['label'];
    }
    $lines[] = '回复序号或选项文字即可查看详情';
    return implode("\n", $lines);
}

/** 匹配用户输入与问答选项：按序号或标签文字（不区分大小写）。命中返回选项，否则 null。 */
function matchAutoReplyOption(string $content): ?array
{
    $ar = wechatAutoReply();
    foreach ($ar['options'] as $i => $o) {
        if (strcasecmp($content, $o['label']) === 0 || $content === (string) ($i + 1)) {
            return $o;
        }
    }
    return null;
}

/** 展示问答菜单的关键词（默认「菜单」）。 */
function wechatMenuKeyword(): string
{
    $cfg = wechatConfig();
    $kw = trim((string) ($cfg['menu_keyword'] ?? ''));
    return $kw !== '' ? $kw : '菜单';
}

/* ---------------------------------------------------------------- 邀请码 */

/** 邀请码表中配置过的去重关键词列表。 */
function wechatInviteKeywords(): array
{
    $keywords = [];
    foreach (db()->query("SELECT DISTINCT keyword FROM invite_codes WHERE status != 'revoked'")->fetchAll() as $row) {
        $keywords[] = (string) $row['keyword'];
    }
    return $keywords;
}

/** 按内容（不区分大小写）找到对应的邀请码关键词，未命中返回空串。 */
function findInviteKeyword(string $content): string
{
    $lower = strtolower($content);
    foreach (wechatInviteKeywords() as $kw) {
        if (strtolower($kw) === $lower) {
            return $kw;
        }
    }
    return '';
}

/** 处理邀请码关键词命中：发放邀请码并返回回复文案。 */
function handleInviteKeyword(string $openid, string $keyword): string
{
    if (!wechatRateOk($openid)) {
        return '操作过于频繁，请稍后再试。';
    }
    $result = dispatchInviteCodeForUser($openid, $keyword);
    switch ($result['reason']) {
        case 'claimed':
            return "【{$result['website']}】邀请码：\n" . ($result['invite']['code'] ?? '') . "\n请妥善保存并及时使用。";
        case 'already_owned':
            return "你已领取过【{$result['website']}】的邀请码：\n" . ($result['invite']['code'] ?? '') . "\n请勿重复领取。";
        case 'empty':
            return '该网站的邀请码已发放完毕，敬请关注后续活动。';
        default:
            return '领取失败，请稍后再试。';
    }
}


function wechatConfig(): array
{
    $path = WECHAT_CONFIG_PATH;
    if (!is_file($path)) {
        jsonOut(['success' => false, 'message' => '公众号配置缺失'], 500);
    }
    $cfg = json_decode((string) file_get_contents($path), true);
    if (!is_array($cfg) || empty($cfg['token']) || substr((string) ($cfg['token'] ?? ''), 0, 8) === 'replace_') {
        jsonOut(['success' => false, 'message' => '公众号配置未填写'], 500);
    }
    return $cfg;
}

/* ---------------------------------------------------------------- 签名校验 */

function wechatCheckSignature(array $cfg): bool
{
    $signature = $_GET['signature'] ?? '';
    $timestamp = $_GET['timestamp'] ?? '';
    $nonce     = $_GET['nonce']     ?? '';
    if ($signature === '' || $timestamp === '' || $nonce === '') {
        return false;
    }
    $arr = [$cfg['token'], $timestamp, $nonce];
    sort($arr, SORT_STRING);
    return hash_equals(sha1(implode($arr)), (string) $signature);
}

/* ---------------------------------------------------------------- 加解密 */

function wechatAesKey(string $encodingAesKey): string
{
    $k = base64_decode($encodingAesKey . '=', true);
    if ($k === false || strlen($k) !== 32) {
        throw new RuntimeException('AESKey 非法：应为 43 字符的 Base64 编码（解码后 32 字节）');
    }
    return $k;
}

function wechatMessageSignature(array $cfg, string $timestamp, string $nonce, string $encrypt): string
{
    $parts = [(string) $cfg['token'], $timestamp, $nonce, $encrypt];
    sort($parts, SORT_STRING);
    return sha1(implode('', $parts));
}

function wechatPkcs7Unpad(string $value): string
{
    if ($value === '') {
        throw new RuntimeException('PKCS7 数据为空');
    }
    $pad = ord($value[strlen($value) - 1]);
    if ($pad < 1 || $pad > 32 || substr($value, -$pad) !== str_repeat(chr($pad), $pad)) {
        throw new RuntimeException('PKCS7 填充非法');
    }
    return substr($value, 0, -$pad);
}

function wechatDecryptPayload(array $cfg, string $timestamp, string $nonce, string $encrypt): string
{
    $cipher = base64_decode($encrypt, true);
    if ($cipher === false) {
        throw new RuntimeException('密文 Base64 解码失败');
    }

    $aesKey = wechatAesKey((string) $cfg['aes_key']);
    $plain = openssl_decrypt($cipher, 'AES-256-CBC', $aesKey, OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, substr($aesKey, 0, 16));
    if ($plain === false) {
        throw new RuntimeException('AES 解密失败');
    }

    $plain = wechatPkcs7Unpad($plain);
    if (strlen($plain) < 20) {
        throw new RuntimeException('密文长度非法');
    }
    $xmlLength = unpack('Nlength', substr($plain, 16, 4))['length'];
    $xml = substr($plain, 20, $xmlLength);
    $appId = substr($plain, 20 + $xmlLength);
    if ($appId !== (string) $cfg['appid']) {
        throw new RuntimeException('AppId 不匹配');
    }
    return $xml;
}

function wechatDecryptMsg(array $cfg, string $postData): string
{
    $msgSignature = (string) ($_GET['msg_signature'] ?? '');
    $timestamp = (string) ($_GET['timestamp'] ?? '');
    $nonce = (string) ($_GET['nonce'] ?? '');
    if ($msgSignature === '' || $timestamp === '' || $nonce === '') {
        throw new RuntimeException('安全模式缺少 msg_signature 参数');
    }
    $body = simplexml_load_string($postData, 'SimpleXMLElement', LIBXML_NOCDATA | LIBXML_NONET);
    if ($body === false || empty($body->Encrypt)) {
        throw new RuntimeException('密文 XML 解析失败');
    }
    $encrypt = (string) $body->Encrypt;
    if (!hash_equals(wechatMessageSignature($cfg, $timestamp, $nonce, $encrypt), $msgSignature)) {
        throw new RuntimeException('消息签名校验失败');
    }
    return wechatDecryptPayload($cfg, $timestamp, $nonce, $encrypt);
}

function wechatEncryptMsg(array $cfg, string $replyXml): string
{
    $aesKey   = wechatAesKey($cfg['aes_key']);
    $timestamp = (string) ($_GET['timestamp'] ?? time());
    $nonce     = (string) ($_GET['nonce']     ?? bin2hex(random_bytes(8)));

    $plain = random_bytes(16) . pack('N', strlen($replyXml)) . $replyXml . (string) $cfg['appid'];
    $pad   = 32 - (strlen($plain) % 32);
    $plain .= str_repeat(chr($pad), $pad);

    $cipher = openssl_encrypt($plain, 'AES-256-CBC', $aesKey, OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, substr($aesKey, 0, 16));
    if ($cipher === false) {
        throw new RuntimeException('AES 加密失败');
    }
    $encrypt = base64_encode($cipher);

    $sig = wechatMessageSignature($cfg, $timestamp, $nonce, $encrypt);

    return "<xml><Encrypt><![CDATA[$encrypt]]></Encrypt>" .
           "<MsgSignature><![CDATA[$sig]]></MsgSignature>" .
           "<TimeStamp>$timestamp</TimeStamp><Nonce><![CDATA[$nonce]]></Nonce></xml>";
}

/* ---------------------------------------------------------------- XML 工具 */

function wechatXmlText(string $to, string $from, string $content): string
{
    $ts = time();
    return "<xml><ToUserName><![CDATA[" . wechatCdata($to) . "]]></ToUserName>" .
           "<FromUserName><![CDATA[" . wechatCdata($from) . "]]></FromUserName>" .
           "<CreateTime>$ts</CreateTime><MsgType>text</MsgType>" .
           "<Content><![CDATA[" . wechatCdata($content) . "]]></Content></xml>";
}

function wechatXmlImage(string $to, string $from, string $mediaId): string
{
    $ts = time();
    return "<xml><ToUserName><![CDATA[" . wechatCdata($to) . "]]></ToUserName>" .
           "<FromUserName><![CDATA[" . wechatCdata($from) . "]]></FromUserName>" .
           "<CreateTime>$ts</CreateTime><MsgType>image</MsgType>" .
           "<Image><MediaId><![CDATA[" . wechatCdata($mediaId) . "]]></MediaId></Image></xml>";
}

/** 转义 XML CDATA 中的结束标记，防止注入。 */
function wechatCdata(string $value): string
{
    return str_replace(']]>', ']]]]><![CDATA[>', $value);
}

/**
 * 图文卡片（news）消息：公众号被动回复原生支持，无须 Imagick。
 * 微信客户端会下载 PicUrl 作为封面，标题/描述为普通文本。
 */
function wechatXmlNews(string $to, string $from, string $title, string $description, string $picUrl, string $url): string
{
    $ts = time();
    $item = '<item>'
        . '<Title><![CDATA[' . wechatCdata($title) . ']]></Title>'
        . '<Description><![CDATA[' . wechatCdata($description) . ']]></Description>'
        . '<PicUrl><![CDATA[' . wechatCdata($picUrl) . ']]></PicUrl>'
        . '<Url><![CDATA[' . wechatCdata($url) . ']]></Url>'
        . '</item>';
    return "<xml><ToUserName><![CDATA[" . wechatCdata($to) . "]]></ToUserName>"
        . "<FromUserName><![CDATA[" . wechatCdata($from) . "]]></FromUserName>"
        . "<CreateTime>$ts</CreateTime><MsgType>news</MsgType>"
        . "<ArticleCount>1</ArticleCount><Articles>$item</Articles></xml>";
}

/** 推断站点基地址（用于默认卡片封面图 URL）。 */
/**
 * 推断站点基地址（用于图文卡片默认封面/跳转链接）。
 * 兼容常见反向代理：X-Forwarded-Proto / X-Forwarded-SSL / X-Forwarded-Host。
 */
function wechatSiteBaseUrl(): string
{
    $proto = 'http';
    $forwardedProto = strtolower(trim((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')));
    if ($forwardedProto === 'https' || $forwardedProto === 'http') {
        $proto = $forwardedProto;
    } elseif (strtolower(trim((string) ($_SERVER['HTTP_X_FORWARDED_SSL'] ?? ''))) === 'on') {
        $proto = 'https';
    } elseif (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        $proto = 'https';
    } elseif (($_SERVER['SERVER_PORT'] ?? '') === '443') {
        $proto = 'https';
    }

    $host = trim((string) ($_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? ''));
    // 剥离端口（微信回调固定 443/80）
    $host = preg_replace('/[:\\/].*$/', '', $host) ?? $host;
    if ($host === '') {
        return '';
    }
    return $proto . '://' . $host;
}

function xmlChild(SimpleXMLElement $xml, string $name): string
{
    return isset($xml->$name) ? (string) $xml->$name : '';
}

/* ---------------------------------------------------------------- 频率限制 */

function wechatRateOk(string $openid): bool
{
    $file = DATA_DIR . '/rate_' . md5($openid) . '.txt';
    $now  = microtime(true);
    $last = is_file($file) ? (float) file_get_contents($file) : 0;
    if ($now - $last < 0.5) {
        return false;
    }
    @file_put_contents($file, (string) $now);
    return true;
}

/* ---------------------------------------------------------------- 业务 */

function buildCardReply(array $result): string
{
    $code = $result['key']['key_code'] ?? '';

    switch ($result['reason']) {
        case 'claimed':
            return "恭喜！你的卡密已发放：\n" . $code . "\n请妥善保管并及时使用。";
        case 'already_owned':
        case 'used':
            return "你已领取过卡密：\n" . $code . "\n每位用户限领一张，请勿重复领取。";
        case 'expired':
            return "你的卡密（" . $code . "）已过期。";
        case 'empty':
            return '活动卡密已发放完毕，敬请关注后续活动~';
        default:
            return '领取失败，请稍后再试。';
    }
}

/** 处理一次关键词命中：按规则动作发卡或纯文案，返回模板替换后的最终文案。 */
function handleKeyword(string $openid, array $rule): string
{
    if (!wechatRateOk($openid)) {
        return '操作过于频繁，请稍后再试。';
    }

    $cardCode = '';
    $status   = '';
    if ($rule['action'] === 'issue') {
        $result   = dispatchKeyForUser($openid, $rule['keyword']);
        $status   = buildCardReply($result);
        $cardCode = (string) ($result['key']['key_code'] ?? '');
    }

    $template = trim((string) ($rule['reply'] ?? ''));
    if ($template === '') {
        return $status !== '' ? $status : '收到。';
    }
    return strtr($template, [
        '{{card_key}}'      => $cardCode,
        '{{trigger_words}}' => wechatTriggerWordsString(),
        '{{status_message}}' => $status,
    ]);
}

function wechatHtmlToText(string $html): string
{
    $html = preg_replace('/<\/?(?:div|p|h[1-6]|li)(?:\s+[^>]*)?>/i', "\n", $html) ?? $html;
    $html = preg_replace('/<br\s*\/?>/i', "\n", $html) ?? $html;
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace("/\r\n?|\\x{2028}|\\x{2029}/u", "\n", $text) ?? $text;
    return trim(preg_replace("/\n{3,}/", "\n\n", $text) ?? $text);
}

function wechatDescriptionPng(string $html): string
{
    if (!class_exists('Imagick')) {
        throw new RuntimeException('服务器未安装 Imagick，无法生成 SVG 图片');
    }
    if (preg_match('/^\s*<svg\b/i', $html)) {
        $image = new Imagick();
        $image->readImageBlob(wechatSanitizeSvg($html));
        $image->setImageFormat('png');
        return $image->getImagesBlob();
    }
    // Only selected inline style values are transferred into the generated SVG.
    preg_match('/style\s*=\s*(["\'])(.*?)\1/is', $html, $styleMatch);
    $style = $styleMatch[2] ?? '';
    $pick = static function (string $name, string $fallback) use ($style): string {
        return preg_match('/(?:^|;)\s*' . preg_quote($name, '/') . '\s*:\s*([^;]+)/i', $style, $m)
            ? trim($m[1]) : $fallback;
    };
    $background = preg_match('/^#[0-9a-f]{3,8}$/i', $pick('background', $pick('background-color', '#fffaf0')))
        ? $pick('background', $pick('background-color', '#fffaf0')) : '#fffaf0';
    $color = preg_match('/^#[0-9a-f]{3,8}$/i', $pick('color', '#292524')) ? $pick('color', '#292524') : '#292524';
    $fontSize = (int) filter_var($pick('font-size', '32px'), FILTER_SANITIZE_NUMBER_INT);
    $fontSize = max(20, min(64, $fontSize ?: 32));
    $radius = (int) filter_var($pick('border-radius', '28px'), FILTER_SANITIZE_NUMBER_INT);
    $radius = max(0, min(100, $radius));
    $html = preg_replace('/<\/?(?:div|p|h[1-6]|li)(?:\s+[^>]*)?>/i', "\n", $html) ?? $html;
    $html = preg_replace('/<br\s*\/?>/i', "\n", $html) ?? $html;
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = trim(preg_replace("/\r\n?|\\x{2028}|\\x{2029}/u", "\n", $text) ?? $text);
    if ($text === '') {
        $text = ' ';
    }
    $width = 900;
    $padding = 56;
    $charsPerLine = max(12, (int) floor(($width - $padding * 2) / ($fontSize * 1.05)));
    $lines = [];
    foreach (explode("\n", $text) as $paragraph) {
        $line = '';
        foreach (preg_split('//u', $paragraph, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $char) {
            if (mb_strlen($line) >= $charsPerLine) {
                $lines[] = $line;
                $line = '';
            }
            $line .= $char;
        }
        $lines[] = $line;
    }
    $lineHeight = (int) ceil($fontSize * 1.65);
    $height = max(220, $padding * 2 + count($lines) * $lineHeight);
    $tspans = '';
    foreach ($lines as $index => $line) {
        $escaped = htmlspecialchars($line === '' ? ' ' : $line, ENT_XML1 | ENT_QUOTES, 'UTF-8');
        $tspans .= '<tspan x="' . $padding . '" dy="' . ($index === 0 ? 0 : $lineHeight) . '">' . $escaped . '</tspan>';
    }
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' . $width . '" height="' . $height . '" viewBox="0 0 ' . $width . ' ' . $height . '">'
        . '<rect width="100%" height="100%" fill="#f5f5f4"/>'
        . '<rect x="20" y="20" width="860" height="' . ($height - 40) . '" rx="' . $radius . '" fill="' . $background . '"/>'
        . '<text x="' . $padding . '" y="' . ($padding + $fontSize) . '" fill="' . $color . '" font-family="Noto Sans CJK SC, sans-serif" font-size="' . $fontSize . '">' . $tspans . '</text></svg>';
    $image = new Imagick();
    $image->readImageBlob($svg);
    $image->setImageFormat('png');
    return $image->getImagesBlob();
}

function wechatSanitizeSvg(string $svg): string
{
    if (stripos($svg, '<!DOCTYPE') !== false) {
        throw new RuntimeException('SVG 不支持 DOCTYPE');
    }
    $previous = libxml_use_internal_errors(true);
    try {
        $document = new DOMDocument();
        if (!$document->loadXML($svg, LIBXML_NONET | LIBXML_NOCDATA)) {
            throw new RuntimeException('SVG 格式无效');
        }
        $root = $document->documentElement;
        if ($root === null || $root->localName !== 'svg') {
            throw new RuntimeException('SVG 格式无效');
        }
        $root = $document->documentElement;
        foreach (['width', 'height'] as $dimension) {
            $value = (string) $root->getAttribute($dimension);
            if ($value !== '' && (!preg_match('/^\d+(?:\.\d+)?(?:px)?$/', $value) || (float) $value > 2000)) {
                throw new RuntimeException('SVG 尺寸必须是不大于 2000 的像素值');
            }
        }
        $xpath = new DOMXPath($document);
        foreach ($xpath->query('//*[local-name()="script" or local-name()="foreignObject" or local-name()="iframe" or local-name()="object" or local-name()="embed" or local-name()="animate" or local-name()="set"]') ?: [] as $node) {
            throw new RuntimeException('SVG 含不支持的动态或嵌入元素');
        }
        foreach ($xpath->query('//*') ?: [] as $element) {
            foreach (iterator_to_array($element->attributes) as $attribute) {
                $name = strtolower($attribute->nodeName);
                $value = trim($attribute->nodeValue);
                if (str_starts_with($name, 'on')) {
                    throw new RuntimeException('SVG 不允许事件属性');
                }
                if (in_array($name, ['href', 'xlink:href', 'src'], true) && $value !== '' && !str_starts_with($value, '#') && !str_starts_with($value, 'data:')) {
                    throw new RuntimeException('SVG 只允许内联 data 图片或内部引用');
                }
                if ($name === 'style' && preg_match('/url\s*\(|@import|expression\s*\(/i', $value)) {
                    throw new RuntimeException('SVG 样式不允许外部资源');
                }
            }
        }
        $result = $document->saveXML($root);
        if ($result === false) {
            throw new RuntimeException('SVG 序列化失败');
        }
        return $result;
    } finally {
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
    }
}

function wechatAccessToken(array $cfg): string
{
    $appid = trim((string) ($cfg['appid'] ?? ''));
    $secret = trim((string) ($cfg['secret'] ?? ''));
    if ($appid === '' || $secret === '') {
        throw new RuntimeException('图片回复需要填写 AppID 和 AppSecret');
    }
    $url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' . rawurlencode($appid) . '&secret=' . rawurlencode($secret);

    // 优先 cURL（带超时，兼容 allow_url_fopen=Off 的主机）；不可用时退回 file_get_contents。
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $response = curl_exec($curl);
        $err = curl_error($curl);
        curl_close($curl);
        if ($response === false || $response === '') {
            throw new RuntimeException('获取微信 access_token 失败：' . ($err !== '' ? $err : '空响应'));
        }
    } else {
        $ctx = stream_context_create(['http' => ['timeout' => 8]]);
        $response = @file_get_contents($url, false, $ctx);
        if ($response === false) {
            throw new RuntimeException('获取微信 access_token 失败：无法请求微信接口（需开启 allow_url_fopen）');
        }
    }

    $data = json_decode((string) $response, true);
    if (!is_array($data) || empty($data['access_token'])) {
        $reason = is_array($data) && isset($data['errmsg']) ? (string) $data['errmsg'] : '未知错误';
        throw new RuntimeException('获取微信 access_token 失败：' . $reason);
    }
    return (string) $data['access_token'];
}

function wechatUploadReplyImage(array $cfg, string $png): string
{
    $temp = tempnam(sys_get_temp_dir(), 'wechat_reply_');
    if ($temp === false) {
        throw new RuntimeException('无法创建图片临时文件');
    }
    $path = $temp . '.png';
    rename($temp, $path);
    try {
        file_put_contents($path, $png);
        $curl = curl_init('https://api.weixin.qq.com/cgi-bin/media/upload?access_token=' . rawurlencode(wechatAccessToken($cfg)) . '&type=image');
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_POSTFIELDS => ['media' => new CURLFile($path, 'image/png', 'reply.png')], CURLOPT_TIMEOUT => 8]);
        $response = curl_exec($curl);
        curl_close($curl);
        $data = json_decode((string) $response, true);
        if (!is_array($data) || empty($data['media_id'])) {
            throw new RuntimeException('上传微信图片素材失败');
        }
        return (string) $data['media_id'];
    } finally {
        @unlink($path);
    }
}

/* ---------------------------------------------------------------- 入口 */

$cfg = wechatConfig();

// 1) 服务器配置校验（微信 GET 回声）
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    if (($cfg['encrypt_mode'] ?? 'plain') === 'safe') {
        $timestamp = (string) ($_GET['timestamp'] ?? '');
        $nonce = (string) ($_GET['nonce'] ?? '');
        $encrypt = (string) ($_GET['echostr'] ?? '');
        $signature = (string) ($_GET['msg_signature'] ?? '');
        if ($timestamp === '' || $nonce === '' || $encrypt === '' || !hash_equals(wechatMessageSignature($cfg, $timestamp, $nonce, $encrypt), $signature)) {
            xmlOut('<xml><Content><![CDATA[verify failed]]></Content></xml>', 403);
        }
        try {
            echo wechatDecryptPayload($cfg, $timestamp, $nonce, $encrypt);
        } catch (Throwable $e) {
            error_log('wechat verify decrypt: ' . $e->getMessage());
            xmlOut('<xml><Content><![CDATA[verify failed]]></Content></xml>', 403);
        }
        exit;
    }
    if (!wechatCheckSignature($cfg)) {
        xmlOut('<xml><Content><![CDATA[verify failed]]></Content></xml>', 403);
    }
    echo $_GET['echostr'] ?? '';
    exit;
}

// 2) 接收消息
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    xmlOut('<xml></xml>', 405);
}

if (($cfg['encrypt_mode'] ?? 'plain') !== 'safe' && !wechatCheckSignature($cfg)) {
    xmlOut('<xml></xml>', 403);
}

$post = (string) (file_get_contents('php://input') ?? '');
if ($post === '') {
    xmlOut('<xml></xml>', 400);
}

try {
    if (($cfg['encrypt_mode'] ?? 'plain') === 'safe') {
        $xmlStr = wechatDecryptMsg($cfg, $post);
    } else {
        $xmlStr = $post; // 明文 / 兼容模式：直接是明文 XML
    }
} catch (Throwable $e) {
    error_log('wechat decrypt: ' . $e->getMessage());
    xmlOut('<xml></xml>', 400);
}

$xml = @simplexml_load_string($xmlStr, 'SimpleXMLElement', LIBXML_NOCDATA | LIBXML_NONET);
if ($xml === false) {
    xmlOut('<xml></xml>', 400);
}

$toUser  = xmlChild($xml, 'FromUserName');
$fromUser = xmlChild($xml, 'ToUserName');
$msgType = xmlChild($xml, 'MsgType');
$event   = xmlChild($xml, 'Event');
$content = trim(xmlChild($xml, 'Content'));

$reply = '';
$triggerText = wechatTriggerWordsString();

if ($msgType === 'event' && strtolower($event) === 'subscribe') {
    // 关注：配置了问答菜单则先展示菜单，否则用关注回复文案
    $reply = wechatAutoReplyMenu();
    if ($reply === '') {
        $reply = wechatSubscribeReply();
    }
} elseif ($msgType === 'text') {
    // 1) 问答菜单选项（序号或标签文字）
    $option = matchAutoReplyOption($content);
    if ($option !== null) {
        $reply = $option['reply'] !== '' ? $option['reply'] : '（该选项暂无内容）';
    } else {
        // 2) 卡密关键词规则（精确匹配，不区分大小写）
        $matched = null;
        foreach (wechatKeywordRules() as $rule) {
            if (strcasecmp($content, $rule['keyword']) === 0) {
                $matched = $rule;
                break;
            }
        }
        if ($matched) {
            $reply = handleKeyword($toUser, $matched);
        } elseif (($inviteKw = findInviteKeyword($content)) !== '') {
            // 3) 邀请码关键词
            $reply = handleInviteKeyword($toUser, $inviteKw);
        } elseif (strcasecmp($content, wechatMenuKeyword()) === 0) {
            // 4) 菜单关键词
            $reply = wechatAutoReplyMenu();
        } else {
            // 5) 未命中：使用配置的提示；未配置提示且开启了问答菜单则展示菜单
            $reply = wechatNoMatchReply();
            if ($reply === '') {
                $reply = wechatAutoReplyMenu();
            }
        }
    }
}

if ($reply === '') {
    xmlOut('<xml></xml>', 200); // 无匹配且未配置提示：静默不回复
}

$cardCode = preg_match('/\b[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}\b/', $reply, $match) ? $match[0] : '';

if (!empty($cfg['reply_as_news'])) {
    // 图文卡片：标题（模板）+ 描述（纯文本）+ 封面图 URL + 跳转链接；无需 Imagick。
    $title = trim((string) ($cfg['reply_title'] ?? ''));
    if ($title === '') {
        $title = $cardCode !== '' ? '卡密领取成功' : '系统通知';
    }
    $title = strtr($title, [
        '{{card_key}}'      => $cardCode,
        '{{trigger_words}}' => $triggerText,
        '{{status_message}}' => $reply,
    ]);
    $base = wechatSiteBaseUrl();
    if ($base === '') {
        error_log('wechat news: 无法确定站点基地址，请检查请求 Host');
    }
    $picUrl = trim((string) ($cfg['cover_url'] ?? ''));
    if ($picUrl === '') {
        $picUrl = $base !== '' ? $base . '/assets/cover.png' : '';
    }
    // 跳转链接：留空时回退到站点地址。空 <Url> 会导致部分微信客户端点击卡片闪退。
    $url = trim((string) ($cfg['link_url'] ?? ''));
    if ($url === '') {
        $url = $base;
    }
    $replyXml = wechatXmlNews($toUser, $fromUser, $title, wechatHtmlToText($reply), $picUrl, $url);
} elseif (!empty($cfg['reply_as_image'])) {
    // 图片回复：生成 PNG 并上传微信素材后发图片消息。
    // 任一步失败都降级为纯文本回复，绝不把原始 SVG 源码当文本发给用户。
    try {
        $png     = wechatDescriptionPng($reply);
        $mediaId = wechatUploadReplyImage($cfg, $png);
        $replyXml = wechatXmlImage($toUser, $fromUser, $mediaId);
    } catch (Throwable $e) {
        error_log('wechat image reply failed: ' . $e->getMessage());
        $replyXml = wechatXmlText($toUser, $fromUser, wechatHtmlToText($reply));
    }
} else {
    $replyXml = wechatXmlText($toUser, $fromUser, wechatHtmlToText($reply));
}

if (($cfg['encrypt_mode'] ?? 'plain') === 'safe') {
    xmlOut(wechatEncryptMsg($cfg, $replyXml));
}
xmlOut($replyXml);
