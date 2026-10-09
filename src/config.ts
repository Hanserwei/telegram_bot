import type { Env, Update } from './types';

export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
export class UserError extends Error {}

export function config(env: Env) {
  const admins: number[] = JSON.parse(env.ADMIN_IDS);
  const channels: Record<string, number> = JSON.parse(env.PUBLISH_CHANNELS);
  const archive = Number(env.ARCHIVE_CHAT_ID);
  const base = new URL(env.PUBLIC_BASE_URL);
  const entries = Object.entries(channels);
  if (!Array.isArray(admins) || !admins.length ||
      admins.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      !Number.isSafeInteger(archive) || archive >= 0 ||
      !entries.length || entries.length > 30 ||
      entries.some(([name, id]) => !name.trim() || name.length > 30 ||
        !Number.isSafeInteger(id) || id >= 0 || id === archive) ||
      new Set(Object.values(channels)).size !== entries.length ||
      base.protocol !== 'https:' || base.pathname !== '/' ||
      base.search || base.hash || base.username || base.password) {
    throw new Error('Invalid configuration');
  }
  return { admins, channels, archive, base: base.origin };
}

export function authorized(update: Update, env: Env): boolean {
  const { admins } = config(env);
  const sender = update.callback_query?.from ?? update.message?.from;
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  return Number.isSafeInteger(update.update_id) && !!sender &&
    admins.includes(sender.id) && chat?.type === 'private' && chat.id === sender.id;
}

export function captionText(value: string): string {
  const text = value.trim();
  if (text.length > 3500) throw new UserError('文案请控制在 3500 字以内，部分表情占两个字符。');
  return text;
}

export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),
    n => n.toString(16).padStart(2, '0')).join('');
}
