# API Reference

This provider exposes an asynchronous video API:

- `GET /v1/models`
- `POST /v1/video/generations`
- `GET /v1/video/generations?task_id=TASK_ID`

The generation request uses `model`, `prompt`, `seconds` as a string, and `size`. The task response may place the identifier in `task_id`, `id`, or `data.task_id`. Status may be `queued`, `processing`, `running`, `completed`, `success`, `failed`, or `error`. Completed responses may expose the video at `video_url`, `url`, `data.video_url`, or `data.url`.
