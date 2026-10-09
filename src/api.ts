import type { Env } from './types';
import { UserError } from './config';

export class TelegramError extends Error {
  constructor(
    readonly definitive: boolean,
    readonly code?: number,
    readonly reason: 'network' | 'response' | 'api' = 'api',
  ) {
    super('Telegram request failed');
  }
}

export async function telegram<T>(env: Env, method: string, data: object = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Workers supports only follow/manual. Manual also prevents forwarding credentials.
      body: JSON.stringify(data), redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new TelegramError(false, undefined, 'network'); }
  let payload: { ok: boolean; result: T; error_code?: number };
  try { payload = await response.json(); } catch { throw new TelegramError(false, response.status, 'response'); }
  if (!response.ok || !payload.ok) {
    // Only a structured API rejection confirms that sendMessage was not accepted.
    throw new TelegramError(payload.ok === false &&
      [400, 401, 403, 404, 409, 429].includes(payload.error_code ?? 0),
      payload.error_code ?? response.status);
  }
  return payload.result;
}

export async function telegraph<T>(method: string, data: Record<string, string>): Promise<T> {
  try {
    const response = await fetch(`https://api.telegra.ph/${method}`, {
      method: 'POST', body: new URLSearchParams(data),
      redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json<{ ok: boolean; result: T }>();
    if (!response.ok || !payload.ok) throw new Error('Rejected');
    return payload.result;
  } catch {
    throw new UserError('Telegraph 暂时无法生成页面。视频草稿已保留，请稍后使用 /drafts 重新预览。');
  }
}
