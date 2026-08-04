import fs from 'node:fs';
import path from 'node:path';

export class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { peers: {} };
    this.#load();
  }

  #load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (!this.data.peers) this.data.peers = {};
      }
    } catch {
      this.data = { peers: {} };
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  peerKey(kind, id) {
    return `${kind}:${id}`;
  }

  get(kind, id) {
    return this.data.peers[this.peerKey(kind, id)] || null;
  }

  set(kind, id, patch) {
    const key = this.peerKey(kind, id);
    const prev = this.data.peers[key] || {};
    this.data.peers[key] = {
      ...prev,
      ...patch,
      kind,
      id,
      updatedAt: new Date().toISOString(),
    };
    this.#save();
    return this.data.peers[key];
  }

  clearSession(kind, id) {
    const key = this.peerKey(kind, id);
    const prev = this.data.peers[key];
    if (!prev) return null;
    const next = { ...prev, sessionId: null, updatedAt: new Date().toISOString() };
    this.data.peers[key] = next;
    this.#save();
    return next;
  }
}
