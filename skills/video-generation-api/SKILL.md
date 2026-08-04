---
name: video-generation-api
description: Generate videos through the configured OpenAI-compatible video API, poll asynchronous jobs, and save MP4 results locally. Use when Codex needs to create animated illustrations, product clips, short films, motion backgrounds, or other video assets.
---

# Video Generation API

Use this as a standalone video-generation skill. It uses only the skill-local `video.env` and does not depend on the image skill or any project.

## Workflow

List models when needed:

```bash
python3 scripts/video_generate.py list-models
```

Generate a video:

```bash
python3 scripts/video_generate.py generate \
  --prompt 'A cinematic close-up of a red paper crane flying over a calm lake at sunrise' \
  --output /tmp/paper-crane.mp4 \
  --seconds 5
```

The client submits `POST /video/generations`, polls `GET /video/generations` with the returned task ID, then downloads the completed HTTP(S) result URL. Report the absolute output path only after checking it exists and is non-empty.

## Rules

- Keep credentials in the skill-local `video.env`; never read another project's configuration.
- Never print API keys, authorization headers, or raw secret-bearing responses.
- Use `--model` when requested; otherwise use `VIDEO_MODEL` or `agnes-video-v2.0`.
- Keep polling bounded by `VIDEO_TIMEOUT_SECONDS` and `VIDEO_POLL_SECONDS`.
- Do not claim success for a submitted task until the MP4 has been downloaded.

## Bundled Resources

- `scripts/video_generate.py`: standalone submission, polling, and download client.
- `video.env`: private skill-local configuration.
- `references/api.md`: endpoint and response notes.
