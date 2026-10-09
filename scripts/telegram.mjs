// Node 22+, no third-party runtime dependencies. Never print the bot token or upstream URL.
import { existsSync } from 'node:fs';
import { createTelegramApi, pollIds, retryTelegramRead } from './telegram-api.mjs';

if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const token = process.env.BOT_TOKEN;
if (!token || token.includes('REPLACE')) {
  console.error('请复制 .dev.vars.example 为 .dev.vars，并填写 BOT_TOKEN。');
  process.exit(1);
}

const api = createTelegramApi(token);

async function main() {
  const action = process.argv[2];
  if (action === 'ids') {
    const info = await retryTelegramRead(api, 'getWebhookInfo');
    if (info.url) throw new Error('机器人已配置 Webhook。请勿同时获取 ID；必要时先明确运行 remove-webhook。');
    console.log('向机器人发私聊消息获取用户 ID；把机器人设为频道管理员后在频道发消息获取频道 ID。');
    console.log('也可转发频道消息给机器人。只打印 ID，不回复消息；获取后按 Ctrl+C 退出。');
    await pollIds(api);
    return;
  }
  if (action === 'remove-webhook') {
    await api('deleteWebhook', { drop_pending_updates: false });
    console.log('已移除 Webhook，现有机器人服务将停止接收更新。');
    return;
  }
  const base = process.env.PUBLIC_BASE_URL;
  if (!base || !base.startsWith('https://') || base.includes('YOUR-SUBDOMAIN')) {
    throw new Error('请填写 .dev.vars 中的 PUBLIC_BASE_URL。');
  }
  if (action === 'register') {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret || secret.includes('REPLACE') || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
      throw new Error('WEBHOOK_SECRET 需为随机生成的 32 到 256 位字母、数字、下划线或连字符。');
    }
    const health = await fetch(`${base.replace(/\/$/, '')}/healthz`);
    if (!health.ok) throw new Error('Worker 健康检查失败，请先完成部署和 D1 迁移。');
    await api('setWebhook', {
      url: `${base.replace(/\/$/, '')}/telegram/webhook`, secret_token: secret,
      allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: false,
    });
    await api('setMyCommands', { commands: [
      { command: 'help', description: '使用说明' },
      { command: 'drafts', description: '最近的视频草稿' },
      { command: 'check', description: '检查频道权限' },
    ] });
    console.log('Webhook 和命令菜单已设置。向机器人发送 /check，再用一个视频测试发布。');
    return;
  }
  if (action === 'check') {
    const me = await api('getMe');
    const info = await api('getWebhookInfo');
    console.log(`机器人：@${me.username}`);
    console.log(`Webhook 已设置：${Boolean(info.url)}；待处理更新：${info.pending_update_count}`);
    console.log(`Webhook 是否指向当前配置：${info.url === `${base.replace(/\/$/, '')}/telegram/webhook`}`);
    console.log(`最近是否有投递错误：${Boolean(info.last_error_date)}`);
    const response = await fetch(`${base.replace(/\/$/, '')}/healthz`);
    console.log(`Worker 和数据库：${response.ok ? '正常' : '异常'}`);
    if (process.env.WEBHOOK_SECRET) {
      const runtime = await fetch(`${base.replace(/\/$/, '')}/internal/telegram-check`, {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': process.env.WEBHOOK_SECRET },
        signal: AbortSignal.timeout(25000),
      });
      if (runtime.ok) {
        const result = await runtime.json();
        const healthy = result.ok === true && result.botId === me.id;
        console.log(`Cloudflare 到 Telegram API：${healthy ? '正常' : '异常'}`);
        if (!healthy) process.exitCode = 1;
      } else {
        console.log(`Cloudflare 到 Telegram API：诊断接口返回 HTTP ${runtime.status}`);
        process.exitCode = 1;
      }
    }
    const channels = JSON.parse(process.env.PUBLISH_CHANNELS || '{}');
    const archive = Number(process.env.ARCHIVE_CHAT_ID);
    for (const [name, id] of [['私有存档频道', archive], ...Object.entries(channels)]) {
      const chat = await api('getChat', { chat_id: id });
      const member = await api('getChatMember', { chat_id: id, user_id: me.id });
      const allowed = chat.type === 'channel' && (member.status === 'creator' || member.can_post_messages);
      console.log(`${name}：${allowed ? '可发布' : '缺少权限'}${id === archive && chat.username ? '，必须改为私有' : ''}`);
    }
    return;
  }
  throw new Error('用法：node scripts/telegram.mjs ids|register|check|remove-webhook');
}

main().catch(error => {
  // Network exceptions can contain request URLs. Only our own fixed messages are displayed.
  console.error(error instanceof Error && !error.cause ? error.message : '请求失败，请检查配置和网络。');
  process.exitCode = 1;
});
