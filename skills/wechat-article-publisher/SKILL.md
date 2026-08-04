---
name: wechat-article-publisher
description: Create polished WeChat public-account articles with attractive mobile HTML, generate inline SVG decoration, upload a raster cover, and create or publish drafts through standalone official WeChat APIs. Use for writing, formatting, decorating, testing, drafting, or publishing WeChat public-account articles without depending on another project.
---

# WeChat Article Publisher

This is a standalone article-writing and publishing workflow. It does not depend on a PHP application, project database, project Session, `wechat_articles.php`, or any other repository.

## Workflow

1. Edit the bundled `wechat.env` file and fill `WECHAT_APPID` and `WECHAT_APPSECRET`. The script loads this file automatically. Environment variables with the same names override the file for one-off tests. Never read or print secrets from another project.
2. Define audience, title, author, digest, key message, and call to action. Use a clear opening, feature sections, proof or workflow, and concise closing.
3. Write mobile-friendly HTML with inline styles. Use semantic headings, short paragraphs, restrained colors, and generous spacing.
4. Generate one to three purposeful inline SVG decorations: hero banner, process diagram, feature divider, or data visual. SVG must use inline shapes, gradients, paths, and text only. Reject scripts, event attributes, external URLs, `foreignObject`, animations, and `DOCTYPE`. Maintain strong text/background contrast: use near-white text on dark fills, near-black or forest text on light fills, and avoid low-contrast muted green or gray labels.
5. Save SVG assets for inspection and inline the SVG markup into the article body. Do not use local `file://` paths, private URLs, or external CSS in the body.
6. Generate an SVG cover as part of the article design and pass it with `--cover-svg`. The bundled script converts that SVG to a temporary PNG and uploads the PNG. Do not use an existing material-library image by default. WeChat permanent material upload does not accept SVG directly as a cover.
7. Create a reviewable draft with the bundled script:

   ```bash
   python3 scripts/wechat_publish.py create-draft \
       --title '文章标题' --author '作者' --digest '摘要' \
       --content-file article.html --cover-svg cover.svg
   ```

8. Report the returned draft `media_id`. A draft is not a publication.
9. Publish only after explicit confirmation:

   ```bash
   python3 scripts/wechat_publish.py publish \
       --media-id 'DRAFT_MEDIA_ID' --confirm
   ```

## Safety And Quality

- Never expose AppSecret, access tokens, local secret files, or command output containing secrets.
- Never publish an ambiguous test request. Create a draft first.
- Do not claim a draft or publication succeeded unless the bundled script returns `success: true`.
- Treat invalid credentials, API errors, unsupported covers, and missing media IDs as blocking conditions.
- Validate source URLs as `http://` or `https://` before placing them in article HTML.
- Keep article HTML self-contained and avoid private local paths.

## Bundled Resources

- `scripts/wechat_publish.py`: standalone token, cover upload, draft creation, and publish client.
- `wechat.env`: editable standalone credential file. Fill its values before use and keep it private.
- `references/wechat-api.md`: official endpoint mapping, field limits, and operational constraints.
