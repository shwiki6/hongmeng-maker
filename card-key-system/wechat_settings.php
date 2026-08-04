<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

requireAdmin();

$path = WECHAT_CONFIG_PATH;
if (!is_file($path)) {
    jsonOut(['success' => false, 'message' => '公众号配置缺失'], 500);
}
$cfg = json_decode((string) file_get_contents($path), true);
if (!is_array($cfg)) {
    jsonOut(['success' => false, 'message' => '公众号配置损坏'], 500);
}

/** 归一化关键词规则（含旧 trigger_words 迁移）。 */
function normalizedKeywordRules(array $cfg): array
{
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

/** 归一化自动回复问答选项。 */
function normalizedAutoReplyOptions(array $cfg): array
{
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
    return $options;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    jsonOut([
        'success'   => true,
        'settings'  => [
            'keyword_rules'     => normalizedKeywordRules($cfg),
            'no_match_reply'    => (string) ($cfg['no_match_reply'] ?? ''),
            'token'             => (string) ($cfg['token'] ?? ''),
            'appid'             => (string) ($cfg['appid'] ?? ''),
            'secret_configured' => trim((string) ($cfg['secret'] ?? '')) !== '',
            'aes_key_configured' => trim((string) ($cfg['aes_key'] ?? '')) !== '',
            'encrypt_mode'      => in_array($cfg['encrypt_mode'] ?? '', ['plain', 'compatible', 'safe'], true)
                ? $cfg['encrypt_mode'] : 'compatible',
            'reply_as_image'    => !empty($cfg['reply_as_image']),
            'reply_as_news'     => !empty($cfg['reply_as_news']),
            'reply_title'       => (string) ($cfg['reply_title'] ?? ''),
            'cover_url'         => (string) ($cfg['cover_url'] ?? ''),
            'link_url'          => (string) ($cfg['link_url'] ?? ''),
            'auto_reply_title'  => (string) ($cfg['auto_reply_title'] ?? ''),
            'auto_reply_options' => normalizedAutoReplyOptions($cfg),
            'menu_keyword'      => (string) ($cfg['menu_keyword'] ?? ''),
            'imagick_available' => class_exists('Imagick'),
        ],
    ]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($input)) {
        jsonOut(['success' => false, 'message' => '请求格式错误'], 400);
    }

    // ---------- 关键词规则 ----------
    if (array_key_exists('keyword_rules', $input)) {
        $rawRules = $input['keyword_rules'];
        if (!is_array($rawRules)) {
            jsonOut(['success' => false, 'message' => '关键词规则格式错误'], 400);
        }
        $rules = [];
        $seen = [];
        foreach ($rawRules as $rule) {
            if (!is_array($rule)) {
                jsonOut(['success' => false, 'message' => '关键词规则格式错误'], 400);
            }
            $kw = trim((string) ($rule['keyword'] ?? ''));
            if ($kw === '') {
                jsonOut(['success' => false, 'message' => '关键词不能为空'], 400);
            }
            if (mb_strlen($kw) > 30) {
                jsonOut(['success' => false, 'message' => "关键词「{$kw}」过长（最多 30 字符）"], 400);
            }
            if (!preg_match('/^[\p{Han}A-Za-z0-9]+$/u', $kw)) {
                jsonOut(['success' => false, 'message' => "非法关键词「{$kw}」（仅限中文/字母/数字）"], 400);
            }
            $lower = mb_strtolower($kw);
            if (isset($seen[$lower])) {
                jsonOut(['success' => false, 'message' => "关键词「{$kw}」重复"], 400);
            }
            $seen[$lower] = true;

            $reply = (string) ($rule['reply'] ?? '');
            if (mb_strlen($reply) > 12000) {
                jsonOut(['success' => false, 'message' => "关键词「{$kw}」的回复文案不能超过 12000 个字符"], 400);
            }
            $action = (($rule['action'] ?? 'text') === 'issue') ? 'issue' : 'text';
            $rules[] = ['keyword' => $kw, 'reply' => $reply, 'action' => $action];
        }
        if ($rules === []) {
            jsonOut(['success' => false, 'message' => '至少需要一条关键词规则'], 400);
        }
        $cfg['keyword_rules'] = $rules;
    }

    // ---------- 文案 ----------
    if (array_key_exists('no_match_reply', $input)) {
        $noMatchReply = (string) $input['no_match_reply'];
        if (mb_strlen($noMatchReply) > 12000) {
            jsonOut(['success' => false, 'message' => '无匹配提示不能超过 12000 个字符'], 400);
        }
        $cfg['no_match_reply'] = $noMatchReply;
    }

    // ---------- 接口参数（仅更新请求中出现的字段，防止局部更新清空其他配置） ----------
    if (array_key_exists('appid', $input)) {
        $appid = trim((string) $input['appid']);
        if ($appid !== '' && !preg_match('/^wx[a-zA-Z0-9]{16,64}$/', $appid)) {
            jsonOut(['success' => false, 'message' => 'AppID 格式无效，应以 wx 开头'], 400);
        }
        $cfg['appid'] = $appid;
    }
    if (array_key_exists('secret', $input)) {
        $secret = trim((string) $input['secret']);
        if (strlen($secret) > 256) {
            jsonOut(['success' => false, 'message' => 'AppSecret 不能超过 256 个字符'], 400);
        }
        if ($secret !== '') {
            $cfg['secret'] = $secret;
        }
    }
    if (array_key_exists('token', $input)) {
        $token = trim((string) $input['token']);
        if ($token !== '') {
            if (strlen($token) < 3 || strlen($token) > 64 || preg_match('/\s/', $token)) {
                jsonOut(['success' => false, 'message' => 'Token 应为 3-64 个字符且不含空白'], 400);
            }
            $cfg['token'] = $token;
        }
    }
    if (array_key_exists('encrypt_mode', $input)) {
        $encryptMode = (string) $input['encrypt_mode'];
        if ($encryptMode !== '' && in_array($encryptMode, ['plain', 'compatible', 'safe'], true)) {
            $cfg['encrypt_mode'] = $encryptMode;
        }
    }
    if (array_key_exists('aes_key', $input)) {
        $aesKey = trim((string) $input['aes_key']);
        if ($aesKey !== '') {
            if (!preg_match('/^[A-Za-z0-9]{43}$/', $aesKey)) {
                jsonOut(['success' => false, 'message' => 'AESKey 应为 43 字符的 Base64 串'], 400);
            }
            $cfg['aes_key'] = $aesKey;
        }
    }

    // ---------- 回复样式 ----------
    if (array_key_exists('reply_title', $input)) {
        $replyTitle = trim((string) $input['reply_title']);
        if (mb_strlen($replyTitle) > 200) {
            jsonOut(['success' => false, 'message' => '卡片标题不能超过 200 个字符'], 400);
        }
        $cfg['reply_title'] = $replyTitle;
    }
    if (array_key_exists('cover_url', $input)) {
        $coverUrl = trim((string) $input['cover_url']);
        if ($coverUrl !== '' && !preg_match('#^https?://[^\s]+$#i', $coverUrl)) {
            jsonOut(['success' => false, 'message' => '封面图 URL 格式无效（必须以 http:// 或 https:// 开头）'], 400);
        }
        $cfg['cover_url'] = $coverUrl;
    }
    if (array_key_exists('link_url', $input)) {
        $linkUrl = trim((string) $input['link_url']);
        if ($linkUrl !== '' && !preg_match('#^https?://[^\s]+$#i', $linkUrl)) {
            jsonOut(['success' => false, 'message' => '跳转链接 URL 格式无效（必须以 http:// 或 https:// 开头）'], 400);
        }
        $cfg['link_url'] = $linkUrl;
    }
    if (array_key_exists('reply_as_image', $input)) {
        $cfg['reply_as_image'] = !empty($input['reply_as_image']);
    }
    if (array_key_exists('reply_as_news', $input)) {
        $cfg['reply_as_news'] = !empty($input['reply_as_news']);
    }

    // ---------- 自动回复问答菜单 ----------
    if (array_key_exists('auto_reply_title', $input)) {
        $autoReplyTitle = (string) $input['auto_reply_title'];
        if (mb_strlen($autoReplyTitle) > 500) {
            jsonOut(['success' => false, 'message' => '菜单标题不能超过 500 个字符'], 400);
        }
        $cfg['auto_reply_title'] = $autoReplyTitle;
    }
    if (array_key_exists('auto_reply_options', $input)) {
        $rawOptions = $input['auto_reply_options'];
        if (!is_array($rawOptions)) {
            jsonOut(['success' => false, 'message' => '问答选项格式错误'], 400);
        }
        if (count($rawOptions) > 20) {
            jsonOut(['success' => false, 'message' => '问答选项最多 20 条'], 400);
        }
        $options = [];
        $seen = [];
        foreach ($rawOptions as $o) {
            if (!is_array($o)) {
                jsonOut(['success' => false, 'message' => '问答选项格式错误'], 400);
            }
            $label = trim((string) ($o['label'] ?? ''));
            if ($label === '') {
                jsonOut(['success' => false, 'message' => '选项文字不能为空'], 400);
            }
            if (mb_strlen($label) > 20 || !preg_match('/^[\p{Han}A-Za-z0-9]+$/u', $label)) {
                jsonOut(['success' => false, 'message' => "选项「{$label}」仅限中文/字母/数字，最长 20 字符"], 400);
            }
            $lower = mb_strtolower($label);
            if (isset($seen[$lower])) {
                jsonOut(['success' => false, 'message' => "选项「{$label}」重复"], 400);
            }
            $seen[$lower] = true;
            $reply = (string) ($o['reply'] ?? '');
            if (mb_strlen($reply) > 12000) {
                jsonOut(['success' => false, 'message' => "选项「{$label}」的回复不能超过 12000 个字符"], 400);
            }
            $options[] = ['label' => $label, 'reply' => $reply];
        }
        $cfg['auto_reply_options'] = $options;
    }
    if (array_key_exists('menu_keyword', $input)) {
        $menuKeyword = trim((string) $input['menu_keyword']);
        if ($menuKeyword !== '') {
            if (mb_strlen($menuKeyword) > 30 || !preg_match('/^[\p{Han}A-Za-z0-9]+$/u', $menuKeyword)) {
                jsonOut(['success' => false, 'message' => '菜单关键词仅限中文/字母/数字，最长 30 字符'], 400);
            }
            $cfg['menu_keyword'] = $menuKeyword;
        }
    }

    if (!saveWechatConfig($cfg)) {
        jsonOut(['success' => false, 'message' => '保存失败'], 500);
    }

    jsonOut([
        'success'      => true,
        'message'      => '已保存',
        'keyword_rules' => normalizedKeywordRules($cfg),
        'no_match_reply'  => (string) ($cfg['no_match_reply'] ?? ''),
        'token'        => (string) ($cfg['token'] ?? ''),
        'appid'        => (string) ($cfg['appid'] ?? ''),
        'secret_configured' => trim((string) ($cfg['secret'] ?? '')) !== '',
        'aes_key_configured' => trim((string) ($cfg['aes_key'] ?? '')) !== '',
        'encrypt_mode' => $cfg['encrypt_mode'] ?? 'compatible',
        'reply_as_image' => $cfg['reply_as_image'] ?? false,
        'reply_as_news'  => $cfg['reply_as_news'] ?? false,
        'reply_title'    => (string) ($cfg['reply_title'] ?? ''),
        'cover_url'      => (string) ($cfg['cover_url'] ?? ''),
        'link_url'       => (string) ($cfg['link_url'] ?? ''),
        'auto_reply_title'  => (string) ($cfg['auto_reply_title'] ?? ''),
        'auto_reply_options' => normalizedAutoReplyOptions($cfg),
        'menu_keyword'      => (string) ($cfg['menu_keyword'] ?? ''),
        'imagick_available' => class_exists('Imagick'),
    ]);
}

jsonOut(['success' => false, 'message' => '无效请求'], 400);
