import fs from 'node:fs';
import path from 'node:path';

/**
 * File-backed SessionPersistencePort for QQ gateway RESUME across restarts.
 * Shape matches @tencent-connect/qqbot-nodejs SessionPersistencePort.
 */
export function createGatewaySessionPersistence(filePath) {
  const file = path.resolve(filePath);
  return {
    load() {
      try {
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object') return null;
        // Soft expiry: 10 minutes — beyond that prefer IDENTIFY.
        if (data.savedAt && Date.now() - Number(data.savedAt) > 10 * 60 * 1000) {
          try { fs.unlinkSync(file); } catch {}
          return null;
        }
        return {
          sessionId: data.sessionId ?? null,
          lastSeq: data.lastSeq ?? null,
          intentLevelIndex: data.intentLevelIndex ?? 0,
          lastConnectedAt: data.lastConnectedAt ?? 0,
        };
      } catch {
        return null;
      }
    },
    save(session) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const payload = {
          sessionId: session?.sessionId ?? null,
          lastSeq: session?.lastSeq ?? null,
          intentLevelIndex: session?.intentLevelIndex ?? 0,
          lastConnectedAt: session?.lastConnectedAt ?? Date.now(),
          savedAt: Date.now(),
        };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
        fs.renameSync(tmp, file);
      } catch {
        // best-effort
      }
    },
    clear() {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    },
  };
}
