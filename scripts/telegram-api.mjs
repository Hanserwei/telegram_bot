import { setTimeout as delay } from 'node:timers/promises';

export class TelegramRequestError extends Error {
  constructor(message, { retryable = false, retryAfter = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

function rejection(method, status, retryAfter) {
  const prefix = `Telegram ${method}`;
  if (status === 401) return new TelegramRequestError(`${prefix}：Token 无效或已被撤销（401），请检查 BOT_TOKEN。`);
  if (status === 409) return new TelegramRequestError(
    `${prefix}：连接冲突（409）。请关闭其他 setup:ids 或使用同一机器人的长轮询进程；若已部署 Webhook，请勿同时运行 ID 工具。`,
  );
  if (status === 403) return new TelegramRequestError(`${prefix}：访问被拒绝（403），请检查机器人访问权限。`);
  if (status === 429) return new TelegramRequestError(`${prefix}：请求过于频繁（429）。`, {
    retryable: true,
    retryAfter: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : 1,
  });
  if (status >= 500 || status === 408) return new TelegramRequestError(
    `${prefix}：服务暂时不可用（${status}）。`, { retryable: true },
  );
  return new TelegramRequestError(`${prefix}：请求被拒绝（${status}），请检查操作参数。`);
}

export function createTelegramApi(token, { fetchImpl = fetch } = {}) {
  return async function api(method, body = {}) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000), redirect: 'error',
      });
    } catch (error) {
      // Only allowlisted codes are printable: raw errors can contain the token-bearing URL.
      const code = error?.cause?.code ?? error?.code;
      const safeCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
        'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'];
      const reason = error?.name === 'TimeoutError' ? '连接超时' :
        safeCodes.includes(code) ? `网络连接中断（${code}）` : '网络连接失败';
      throw new TelegramRequestError(`Telegram ${method}：${reason}。`, { retryable: true });
    }
    let result;
    try { result = await response.json(); }
    catch {
      if (!response.ok) throw rejection(method, response.status);
      throw new TelegramRequestError(`Telegram ${method}：返回了无法解析的响应。`, { retryable: true });
    }
    if (!response.ok || result?.ok === false) {
      throw rejection(method, Number.isInteger(result?.error_code) ? result.error_code : response.status,
        result?.parameters?.retry_after);
    }
    if (result?.ok !== true || !Object.hasOwn(result, 'result')) {
      throw new TelegramRequestError(`Telegram ${method}：返回了无效的响应格式。`, { retryable: true });
    }
    return result.result;
  };
}

export async function retryTelegramRead(api, method, body = {}, {
  sleep = delay, warn = console.error,
} = {}) {
  if (!['getUpdates', 'getWebhookInfo'].includes(method)) {
    throw new Error('Only Telegram setup reads may be retried automatically');
  }
  let failures = 0;
  while (true) {
    try { return await api(method, body); }
    catch (error) {
      if (!(error instanceof TelegramRequestError) || !error.retryable) throw error;
      const seconds = Math.max(Math.min(2 ** Math.min(failures++, 5), 30), error.retryAfter);
      warn(`${error.message} ${seconds} 秒后自动重试，按 Ctrl+C 退出。`);
      await sleep(seconds * 1000);
    }
  }
}

export async function pollIds(api, {
  print = console.log, warn = console.error, sleep = delay, shouldContinue = () => true,
} = {}) {
  let offset = 0;
  while (shouldContinue()) {
    const updates = await retryTelegramRead(api, 'getUpdates', {
      offset, timeout: 15, allowed_updates: ['message', 'channel_post'],
    }, { sleep, warn });
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message?.from) print(`用户 ID：${update.message.from.id}`);
      if (update.message?.forward_origin?.chat) print(`转发来源频道 ID：${update.message.forward_origin.chat.id}`);
      if (update.channel_post) print(`频道 ID：${update.channel_post.chat.id}`);
    }
  }
}
