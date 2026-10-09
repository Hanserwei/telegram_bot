import { telegram } from './api';
import { MAX_VIDEO_BYTES } from './config';
import { Store } from './db';
import type { Env } from './types';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length',
};

export function parseRange(value: string, total: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ?
      { start: Math.max(total - suffix, 0), end: total - 1 } : null;
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || end < start) return null;
  return { start, end: Math.min(end, total - 1) };
}

// Handles origins that ignore Range without buffering an entire video in a Worker isolate.
export function sliceStream(source: ReadableStream<Uint8Array>, skip: number, length: number) {
  const reader = source.getReader();
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (remaining) controller.error(new Error('Video stream interrupted'));
            else controller.close();
            return;
          }
          if (skip >= value.byteLength) { skip -= value.byteLength; continue; }
          const chunk = value.subarray(skip, skip + remaining);
          skip = 0;
          remaining -= chunk.byteLength;
          controller.enqueue(chunk);
          if (!remaining) {
            controller.close();
            void reader.cancel().catch(() => {});
          }
          return;
        }
      } catch {
        controller.error(new Error('Video stream interrupted'));
        void reader.cancel().catch(() => {});
      }
    },
    cancel() { return reader.cancel().catch(() => {}); },
  });
}

export async function serveMedia(request: Request, env: Env, token: string, extension?: string): Promise<Response> {
  const fail = (status: number, text: string, extra: Record<string, string> = {}) =>
    new Response(request.method === 'HEAD' ? null : text, {
      status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra },
    });
  if (!/^[a-f0-9]{64}$/.test(token)) return fail(404, 'Video not found');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'Method not allowed', { Allow: 'GET, HEAD, OPTIONS' });
  const draft = await new Store(env.DB).mediaByToken(token);
  if (!draft || (extension && extension !== draft.extension)) return fail(404, 'Media not found');
  const total = draft.file_size;
  if (total <= 0 || total > MAX_VIDEO_BYTES) return fail(404, 'Video not found');
  const rangeHeader = request.method === 'GET' ? request.headers.get('Range') : null;
  const range = rangeHeader ? parseRange(rangeHeader, total) : { start: 0, end: total - 1 };
  if (!range) return fail(416, 'Range not satisfiable', { 'Content-Range': `bytes */${total}` });
  const { start, end } = range;
  const length = end - start + 1;
  const headers: Record<string, string> = {
    ...CORS, 'Content-Type': draft.mime_type, 'Content-Disposition': 'inline',
    'Content-Length': String(length), 'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff',
    ...(rangeHeader ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  try {
    // Resolve each time: Telegram file URLs expire, file_id remains reusable for this bot.
    const file = await telegram<{ file_path?: string; file_size?: number }>(env, 'getFile', { file_id: draft.file_id });
    if (!file.file_path || !/^[\w/.-]+$/.test(file.file_path) || file.file_path.includes('..') ||
        (file.file_size !== undefined && file.file_size !== total)) throw new Error('Invalid media');
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20000);
    let origin: Response;
    try {
      origin = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`, {
        headers: rangeHeader ? { Range: `bytes=${start}-${end}` } : {},
        redirect: 'manual', signal: abort.signal,
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } finally { clearTimeout(timeout); }
    const expectedRange = `bytes ${start}-${end}/${total}`;
    if (!origin.body || ![200, 206].includes(origin.status) ||
        (origin.status === 206 && (!rangeHeader || origin.headers.get('Content-Range') !== expectedRange))) {
      await origin.body?.cancel();
      throw new Error('Invalid media response');
    }
    const expectedLength = origin.status === 206 ? length : total;
    const upstreamLength = origin.headers.get('Content-Length');
    if (upstreamLength !== null && Number(upstreamLength) !== expectedLength) {
      await origin.body.cancel();
      throw new Error('Invalid media length');
    }
    // Workers ignores a manually supplied Content-Length on arbitrary streams.
    // A FixedLengthStream preserves the correct length at the actual HTTP boundary.
    const fixed = new FixedLengthStream(length);
    void sliceStream(origin.body, origin.status === 206 ? 0 : start, length)
      .pipeTo(fixed.writable).catch(() => {});
    return new Response(fixed.readable, {
      status: rangeHeader ? 206 : 200, headers,
    });
  } catch {
    // Never redirect clients to the token-bearing Telegram download URL.
    return fail(503, 'Video temporarily unavailable; please retry', { 'Retry-After': '10' });
  }
}
