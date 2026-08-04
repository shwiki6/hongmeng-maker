export function stripMentions(content = '') {
  return String(content)
    .replace(/<@!?[^>]+>/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function chunkText(text, maxChars = 1800) {
  const s = String(text || '').trim();
  if (!s) return [''];
  if (s.length <= maxChars) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.6) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.6) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function isCommand(text) {
  return text.startsWith('/') || text.startsWith('！') || text.startsWith('!');
}

export function parseCommand(text) {
  const raw = text.replace(/^！/, '/').replace(/^!/, '/').trim();
  // Allow ASCII commands and common CJK aliases (e.g. /撤回).
  const m = raw.match(/^\/([\w\u4e00-\u9fff-]+)(?:\s+([\s\S]*))?$/u);
  if (!m) return null;
  const name = m[1];
  // Lowercase only ASCII letters so CJK names stay intact.
  return { name: name.replace(/[A-Za-z]+/g, (s) => s.toLowerCase()), args: (m[2] || '').trim(), raw };
}
