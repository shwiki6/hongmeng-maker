import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('media');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi']);
const VOICE_EXTS = new Set(['.silk', '.wav', '.mp3', '.flac', '.ogg', '.amr', '.m4a']);
const FILE_EXTS = new Set(['.pdf', '.txt', '.md', '.zip', '.tar', '.gz', '.json', '.csv', '.log', '.py', '.js', '.ts', '.php', '.html', '.css']);

export function mediaKindFromContentType(ct = '', filename = '') {
  const t = String(ct || '').toLowerCase();
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (t.startsWith('image/') || t === 'image' || IMAGE_EXTS.has(ext)) return 'image';
  if (t.startsWith('video/') || t === 'video' || VIDEO_EXTS.has(ext)) return 'video';
  if (t.startsWith('audio/') || t === 'voice' || t === 'audio' || VOICE_EXTS.has(ext)) return 'voice';
  if (t.startsWith('application/') || t.startsWith('text/') || FILE_EXTS.has(ext)) return 'file';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (VOICE_EXTS.has(ext)) return 'voice';
  return 'file';
}

function safeName(name, fallback) {
  const base = path.basename(String(name || fallback || 'file')).replace(/[^\w.\u4e00-\u9fff-]+/g, '_');
  return base.slice(0, 120) || fallback || 'file';
}

async function fetchToFile(url, destPath, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return { bytes: buf.length, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download inbound QQ attachments to local media dir.
 * @returns {Promise<Array<{kind:string, localPath:string, url:string, filename?:string, contentType:string, asr?:string, bytes:number}>>}
 */
export async function downloadAttachments(attachments = [], mediaDir, opts = {}) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const out = [];
  const list = Array.isArray(attachments) ? attachments : [];
  for (let i = 0; i < list.length; i += 1) {
    const att = list[i] || {};
    const url = att.voice_wav_url || att.url;
    if (!url) continue;
    const kind = mediaKindFromContentType(att.content_type, att.filename);
    const extGuess =
      path.extname(att.filename || '') ||
      (kind === 'image' ? '.jpg' : kind === 'video' ? '.mp4' : kind === 'voice' ? '.wav' : '.bin');
    const filename = safeName(att.filename, `att-${Date.now()}-${i}${extGuess}`);
    const dest = path.join(mediaDir, `${Date.now()}-${i}-${filename}`);
    try {
      const meta = await fetchToFile(url, dest, opts.timeoutMs || 60000);
      out.push({
        kind,
        localPath: dest,
        url,
        filename: att.filename || filename,
        contentType: att.content_type || meta.contentType || '',
        asr: att.asr_refer_text || '',
        bytes: meta.bytes,
      });
      log.info(`downloaded ${kind} -> ${dest} (${meta.bytes}B)`);
    } catch (err) {
      log.warn(`download failed ${url.slice(0, 100)}: ${err.message || err}`);
      out.push({
        kind,
        localPath: '',
        url,
        filename: att.filename,
        contentType: att.content_type || '',
        asr: att.asr_refer_text || '',
        bytes: 0,
        error: String(err.message || err),
      });
    }
  }
  return out;
}

/** Collect quote/reply text from msg_elements if present. */
export function extractQuotedText(msg) {
  const els = msg?.msgElements || msg?.raw?.msg_elements || [];
  if (!Array.isArray(els) || !els.length) return '';
  const parts = [];
  for (const el of els) {
    if (el?.content) parts.push(String(el.content).trim());
    if (Array.isArray(el?.attachments) && el.attachments.length) {
      for (const a of el.attachments) {
        const k = mediaKindFromContentType(a.content_type, a.filename);
        parts.push(`[引用附件:${k}${a.filename ? ` ${a.filename}` : ''}]`);
      }
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}

/**
 * Parse local media paths from Codex final text so we can send them back to QQ.
 * Supports absolute paths, file://, and markdown images.
 */
export function extractOutboundMedia(text = '', { max = 6 } = {}) {
  const s = String(text || '');
  const found = [];
  const seen = new Set();
  // Strip fenced code blocks first — source snippets often contain absolute paths.
  // Keep inline-code paths: Codex commonly formats generated media as
  // `/absolute/path/image.jpg`. Only fenced blocks are ignored as source code.
  const noCode = s.replace(/```[\s\S]*?```/g, ' ');

  const push = (raw, kindHint) => {
    if (!raw || found.length >= max) return;
    let p = String(raw).trim().replace(/^['"`]+|['"`]+$/g, '');
    if (p.startsWith('file://')) {
      try { p = decodeURIComponent(p.slice('file://'.length)); } catch { p = p.slice('file://'.length); }
    }
    // drop query fragments
    p = p.split('?')[0].split('#')[0];
    // trim trailing punctuation common in prose
    p = p.replace(/[),.;:]+$/g, '');
    if (!path.isAbsolute(p)) return;
    if (seen.has(p)) return;
    const ext = path.extname(p).toLowerCase();
    const known =
      IMAGE_EXTS.has(ext) ||
      VIDEO_EXTS.has(ext) ||
      VOICE_EXTS.has(ext) ||
      FILE_EXTS.has(ext);
    // Bare paths without known extension are too noisy (e.g. /root/project).
    if (!known && !String(raw).startsWith('file://')) return;
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return;
    const kind = kindHint || mediaKindFromContentType('', p);
    seen.add(p);
    found.push({ kind, localPath: p, filename: path.basename(p) });
  };

  // markdown image/file links (keep original text so code fences don't hide intentional links)
  const mdRe = /!\[[^\]]*]\(([^)\s]+)\)|\[[^\]]*]\(([^)\s]+)\)/g;
  let m;
  while ((m = mdRe.exec(s)) && found.length < max) {
    push(m[1] || m[2], m[0].startsWith('![') ? 'image' : undefined);
  }

  // file:// and absolute paths with common media extensions (scan prose, not code fences)
  const pathRe = /(?:file:\/\/[^\s)'"`]+|\/(?:storage|root|home|tmp|data|sdcard|mnt|var|opt)[^\s)'"`]*)/g;
  while ((m = pathRe.exec(noCode)) && found.length < max) {
    const candidate = m[0];
    const ext = path.extname(candidate.split('?')[0]).toLowerCase();
    if (
      IMAGE_EXTS.has(ext) ||
      VIDEO_EXTS.has(ext) ||
      VOICE_EXTS.has(ext) ||
      FILE_EXTS.has(ext) ||
      candidate.startsWith('file://')
    ) {
      push(candidate);
    }
  }

  return found;
}

/** Pack several generated files into one archive so QQ group quota is used once. */
export function createZipArchive(items = [], outputDir) {
  const files = items
    .map((item) => item?.localPath)
    .filter((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
  if (files.length < 2) return files[0] || null;
  fs.mkdirSync(outputDir, { recursive: true });
  const archive = path.join(outputDir, `codex-files-${Date.now()}.zip`);
  execFileSync('zip', ['-q', '-j', archive, ...files], { stdio: 'ignore' });
  return archive;
}

/** Build prompt lines describing downloaded attachments. */
export function formatAttachmentPrompt(downloaded = []) {
  if (!downloaded.length) return [];
  const lines = ['【用户附件】'];
  for (const d of downloaded) {
    if (d.kind === 'image' && d.localPath) {
      lines.push(`- 图片已下载: ${d.localPath}${d.filename ? ` (${d.filename})` : ''}`);
    } else if (d.kind === 'voice') {
      if (d.asr) lines.push(`- 语音转写(ASR): ${d.asr}`);
      if (d.localPath) lines.push(`- 语音文件: ${d.localPath}`);
      else if (d.url) lines.push(`- 语音 URL: ${d.url}`);
    } else if (d.localPath) {
      lines.push(`- ${d.kind} 文件: ${d.localPath}${d.filename ? ` (${d.filename})` : ''}`);
    } else {
      lines.push(`- ${d.kind} 下载失败: ${d.error || d.url || 'unknown'}`);
    }
  }
  lines.push('图片已通过 codex -i 注入（若存在）；其他附件路径可直接读取。');
  return lines;
}
