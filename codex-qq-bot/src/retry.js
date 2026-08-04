/**
 * Retry helper for transient QQ API failures.
 */
export async function withRetry(fn, {
  retries = 2,
  baseDelayMs = 400,
  label = 'op',
  shouldRetry = defaultShouldRetry,
  onRetry = null,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const delay = baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * 100);
      if (onRetry) {
        try { onRetry(err, attempt + 1, delay); } catch {}
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultShouldRetry(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = err?.httpStatus || err?.status || err?.bizCode;
  if (code === 429 || code === 502 || code === 503 || code === 504) return true;
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('fetch failed')) return true;
  if (msg.includes('rate') || msg.includes('temporarily')) return true;
  return false;
}
