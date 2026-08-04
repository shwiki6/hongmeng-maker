/**
 * Simple TTL message-id deduper to absorb QQ gateway redeliveries.
 * Mark only after successful handling so mid-handler crashes can retry.
 */
export class MessageDeduper {
  constructor({ ttlMs = 10 * 60 * 1000, maxSize = 5000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.map = new Map(); // id -> seenAt
  }

  has(id) {
    if (!id) return false;
    this.#evict();
    return this.map.has(id);
  }

  mark(id) {
    if (!id) return;
    this.#evict();
    this.map.set(id, Date.now());
    if (this.map.size > this.maxSize) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }

  /** @deprecated prefer has()+mark(); kept for compatibility */
  seen(id) {
    if (this.has(id)) return true;
    this.mark(id);
    return false;
  }

  #evict() {
    const now = Date.now();
    for (const [id, at] of this.map) {
      if (now - at > this.ttlMs) this.map.delete(id);
      else break; // Map insertion order roughly age-order
    }
  }

  size() {
    return this.map.size;
  }
}
