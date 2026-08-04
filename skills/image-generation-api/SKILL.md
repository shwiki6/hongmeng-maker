---
name: image-generation-api
description: Generate raster images through the configured OpenAI-compatible image API and save them locally. Use when Codex needs to create illustrations, covers, decorations, product visuals, or other bitmap assets with the configured image-generation service.
---

# Image Generation API

Use this skill as a standalone image-generation capability. Do not read credentials or implementation details from another project. The skill loads its own `image.env` and calls the configured `IMAGE_API_BASE_URL` with `IMAGE_API_KEY`.

## Workflow

1. Read the requested subject, style, dimensions, quantity, and output location.
2. List available models when the configured model is empty:

   ```bash
   python3 scripts/image_generate.py list-models
   ```

3. Generate and save an image:

   ```bash
   python3 scripts/image_generate.py generate \
     --prompt 'A clean editorial illustration of a modern Android phone, warm studio light' \
     --output /tmp/android-phone.png \
     --size 1024x1024
   ```

4. Report the generated absolute path. Include it directly in QQ responses when the user needs the image returned.

## Rules

- Use only the skill-local `image.env`; never search another project for credentials.
- Never print the API key, authorization header, or raw response containing secrets.
- Prefer PNG for transparent or UI assets.
- Do not claim success unless the output exists and has non-zero size.
- Use `--model` when the user names a model. Otherwise use `IMAGE_MODEL`, then auto-select from `/models`.
- The client accepts OpenAI-compatible responses containing `data[].b64_json` or `data[].url`.

## Bundled Resources

- `scripts/image_generate.py`: model discovery, generation, URL download, and base64 decoding client.
- `image.env`: skill-local runtime configuration; keep it private.
- `references/api.md`: endpoint and compatibility notes.
