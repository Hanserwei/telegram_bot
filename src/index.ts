import { processUpdate } from './bot';
import { telegram, TelegramError } from './api';
import { authorized } from './config';
import { Store } from './db';
import { serveMedia } from './media';
import type { Env, Update } from './types';

async function sameSecret(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([left, right].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < aa.length; index++) mismatch |= aa[index] ^ bb[index];
  return mismatch === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/internal/telegram-check' && request.method === 'POST') {
        if (!await sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', env.WEBHOOK_SECRET)) {
          return new Response('Forbidden', { status: 403 });
        }
        try {
          const me = await telegram<{ id: number }>(env, 'getMe');
          return Response.json({ ok: true, botId: me.id });
        } catch (error) {
          return Response.json({ ok: false, reason: error instanceof TelegramError ? error.reason : 'unexpected',
            code: error instanceof TelegramError ? error.code : undefined });
        }
      }
      if (path === '/healthz' && request.method === 'GET') {
        await env.DB.prepare('SELECT 1 FROM drafts LIMIT 1').first();
        return Response.json({ status: 'ok' });
      }
      const media = /^\/media\/([^/]+)\.(mp4|jpg|png|webp|gif)$/.exec(path);
      if (media) return await serveMedia(request, env, media[1], media[2]);
      if (path !== '/telegram/webhook') return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!await sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', env.WEBHOOK_SECRET)) {
        return new Response('Forbidden', { status: 403 });
      }
      // Only authenticated Telegram requests reach body parsing; also enforce a hard size bound.
      if (Number(request.headers.get('Content-Length')) > 65536) return new Response('Too large', { status: 413 });
      const reader = request.body?.getReader();
      if (!reader) return new Response('Invalid update', { status: 400 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); return new Response('Too large', { status: 413 }); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let update: Update;
      try { update = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return new Response('Invalid update', { status: 400 }); }
      if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) {
        return new Response('Invalid update', { status: 400 });
      }
      if (authorized(update, env)) {
        if (update.message?.media_group_id) {
          await env.DB.prepare('INSERT OR IGNORE INTO incoming_albums VALUES (?,?,?,?)').bind(
            update.update_id, update.message.chat.id, update.message.media_group_id, Date.now(),
          ).run();
        }
        await env.UPDATES.send(update);
      }
      // Telegram receives success only after durable enqueue; retries are safe via update_id dedup.
      return new Response('OK');
    } catch {
      return new Response('Service temporarily unavailable', { status: 503 });
    }
  },

  async queue(batch: MessageBatch<Update>, env: Env): Promise<void> {
    // Keep max_concurrency=1 in wrangler.jsonc: commands are intentionally serialized.
    for (const item of batch.messages) {
      try { await processUpdate(env, item.body); item.ack(); }
      catch { item.retry({ delaySeconds: 30 }); }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await new Store(env.DB).recover();
    await env.DB.prepare('DELETE FROM incoming_albums WHERE received_at<?')
      .bind(Date.now() - 30 * 24 * 60 * 60 * 1000).run();
    await env.DB.prepare('DELETE FROM processed_updates WHERE created_at<?')
      .bind(Date.now() - 30 * 24 * 60 * 60 * 1000).run();
  },
} satisfies ExportedHandler<Env, Update>;
