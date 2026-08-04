export class KeyedQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.active = 0;
    this.activeKeys = new Set();
    this.queues = new Map();
  }

  add(key, task) {
    return new Promise((resolve, reject) => {
      if (!this.queues.has(key)) this.queues.set(key, []);
      this.queues.get(key).push({ task, resolve, reject });
      this.#pump();
    });
  }

  /** Reject and drop all pending (not running) jobs for key. */
  cancelPending(key, reason = 'cancelled') {
    const jobs = this.queues.get(key) || [];
    this.queues.delete(key);
    for (const job of jobs) {
      try { job.reject(new Error(reason)); } catch {}
    }
    return jobs.length;
  }

  pendingCount(key) {
    return (this.queues.get(key) || []).length;
  }

  isActive(key) {
    return this.activeKeys.has(key);
  }

  stats() {
    let pending = 0;
    for (const jobs of this.queues.values()) pending += jobs.length;
    return {
      active: this.active,
      activeKeys: [...this.activeKeys],
      pending,
      queues: this.queues.size,
    };
  }

  #pump() {
    if (this.active >= this.concurrency) return;
    for (const [key, jobs] of this.queues.entries()) {
      if (this.activeKeys.has(key)) continue;
      if (!jobs.length) {
        this.queues.delete(key);
        continue;
      }
      const job = jobs.shift();
      if (!jobs.length) this.queues.delete(key);
      this.activeKeys.add(key);
      this.active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.activeKeys.delete(key);
          this.#pump();
        });
      if (this.active >= this.concurrency) break;
    }
  }
}
