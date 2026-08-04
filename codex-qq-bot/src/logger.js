export function createLogger(scope = 'bot') {
  const stamp = () => new Date().toISOString();
  const line = (level, args) => {
    const msg = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    console.log(`[${stamp()}] [${level}] [${scope}] ${msg}`);
  };
  return {
    debug: (...args) => line('debug', args),
    info: (...args) => line('info', args),
    warn: (...args) => line('warn', args),
    error: (...args) => line('error', args),
  };
}
