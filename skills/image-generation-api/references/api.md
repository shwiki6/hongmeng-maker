# API Reference

The client targets an OpenAI-compatible API:

- `GET {base}/models`
- `POST {base}/images/generations`

The base URL should normally end in `/v1`, for example `https://example.invalid/v1`. The client adds the endpoint path and does not print credentials.

Generation JSON includes `prompt`, `model`, `n`, `size`, and `response_format=b64_json`. If the provider rejects `response_format`, the client retries once without that field. Each item may return `b64_json` or an HTTP(S) `url`.

Only HTTP(S) image URLs are downloaded. Local paths and other schemes are rejected. Multiple results append `-2`, `-3`, and so on before the file suffix.
