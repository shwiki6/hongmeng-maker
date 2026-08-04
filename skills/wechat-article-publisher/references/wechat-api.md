# Standalone WeChat API Reference

## Authentication

The bundled client calls:

```text
GET https://api.weixin.qq.com/cgi-bin/token
  ?grant_type=client_credential&appid=APPID&secret=APPSECRET
```

Credentials are loaded from the skill-local `wechat.env` file. Process environment variables named `WECHAT_APPID` and `WECHAT_APPSECRET` override the file. Set `WECHAT_ENV_FILE` to use a different private config file.

## Cover Material

The client converts the generated SVG cover to a temporary PNG, then uploads the raster cover to:

```text
POST https://api.weixin.qq.com/cgi-bin/material/add_material
  ?access_token=ACCESS_TOKEN&type=image
```

Accepted MIME types: `image/jpeg`, `image/png`, `image/gif`. Maximum size: 2MB. The returned permanent `media_id` is used as `thumb_media_id`. An existing `thumb_media_id` is only used when explicitly supplied, never as the default cover source.

## Draft

```text
POST https://api.weixin.qq.com/cgi-bin/draft/add
  ?access_token=ACCESS_TOKEN
```

Payload shape:

```json
{
  "articles": [{
    "title": "max 64 characters",
    "author": "max 32 characters",
    "digest": "max 120 characters",
    "content": "HTML, max 200000 characters",
    "content_source_url": "https://example.com/article",
    "thumb_media_id": "permanent image media_id",
    "need_open_comment": 0,
    "only_fans_can_comment": 0
  }]
}
```

## Publish

```text
POST https://api.weixin.qq.com/cgi-bin/freepublish/submit
  ?access_token=ACCESS_TOKEN
```

Payload:

```json
{"media_id":"DRAFT_MEDIA_ID"}
```

Publishing is irreversible from this workflow. Require explicit user confirmation before calling it.
