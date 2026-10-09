import { telegram } from './api';
import { authorized, captionText, config, UserError } from './config';
import { editable, postText, Publisher } from './publisher';
import { attachment, MAX_ITEMS } from './attachments';
import type { Callback, Chat, Draft, Env, Message, Status, Update } from './types';

const STATUS: Record<Status, string> = {
  draft: '待发布', publishing: '正在发布', published: '已发布', uncertain: '发送结果待核实', cancelled: '已取消',
};
const HELP = `支持图片、MP4 视频，以及多图、多视频、图文视频混合相册。
每个文件不超过 10 MB，每篇最多 20 个素材。

一次多选图片/视频发送，机器人会把同一相册合并为一份草稿。
也可以回复原素材或草稿消息，继续发送图片/视频来追加。
全部收齐后点击“生成预览”，检查素材数量、观看页面和目标频道，再确认发布。

随素材附上的文字作为文案；回复草稿发送文字可以修改文案。
未关联的单独素材会新建草稿，普通文字不会自动绑定最近的草稿。

/drafts 最近 10 条草稿
/draft 草稿编号 打开预览
/check 检查频道权限
/help 使用说明

支持 JPG、PNG、WebP、GIF 和 MP4；其他格式请先转换。
文案为纯文本；修改、追加和取消仅限发布前。`;

function keyboard(draft: Draft) {
  const rows = [];
  if (draft.caption && draft.page_url && draft.page_revision === draft.revision) rows.push([{
    text: `✅ 确认发布到「${draft.target_name}」`, callback_data: `pub:${draft.id}:${draft.revision}`,
  }]);
  rows.push([
    { text: '选择频道', callback_data: `targets:${draft.id}` },
    { text: '生成预览', callback_data: `preview:${draft.id}` },
  ]);
  rows.push([{ text: '取消草稿', callback_data: `cancel:${draft.id}` }]);
  return { inline_keyboard: rows };
}

class BotHandler extends Publisher {
  async say(chatId: number, text: string, extras: object = {}) {
    return telegram<Message>(this.env, 'sendMessage', { chat_id: chatId, text, ...extras });
  }

  async preview(draft: Draft, chatId: number) {
    if (draft.status !== 'draft') {
      await this.say(chatId, `草稿 ${draft.id}：${STATUS[draft.status]}，目标频道：${draft.target_name}。` +
        (draft.status === 'uncertain' ? `\n请检查频道后，用 /resolve ${draft.id} sent 消息编号` +
          `\n或确认未发送后用 /resolve ${draft.id} retry。` : ''));
      return;
    }
    const items = await this.store.media(draft);
    const images = items.filter(item => item.kind === 'image').length;
    const summary = `${images} 张图片、${items.length - images} 个视频（共 ${items.length} 个）`;
    if (draft.caption) {
      draft = await this.prepare(draft);
      const info = await this.say(chatId,
        `草稿：${draft.id}\n目标频道：${draft.target_name}\n素材：${summary}\n请打开观看链接核对素材是否齐全。\n下方为发布预览，回复它可修改文案。`);
      await this.store.link(chatId, info.message_id, draft.id);
    }
    const sent = await this.say(chatId,
      draft.caption ? postText(draft) : `素材已存档。草稿：${draft.id}\n素材：${summary}\n` +
        `目标频道：${draft.target_name}\n请回复本消息填写文案或追加素材。`, {
        reply_markup: keyboard(draft),
        ...(draft.page_url ? { link_preview_options: { url: draft.page_url } } : {}),
      });
    await this.store.link(chatId, sent.message_id, draft.id);
  }

  async upload(message: Message) {
    const media = attachment(message);
    const caption = captionText(message.caption ?? '');
    const existing = await this.store.source(message.chat.id, message.message_id);
    if (existing) {
      if (message.media_group_id) await this.store.bindAlbum(message.chat.id, message.media_group_id, existing.id);
      await this.store.link(message.chat.id, message.message_id, existing.id);
      await this.receipt(existing, message.chat.id);
      return;
    }
    let draft = message.media_group_id ? await this.store.album(message.chat.id, message.media_group_id) : null;
    const reply = message.reply_to_message;
    if (reply) {
      const target = await this.store.reply(message.chat.id, reply.message_id);
      if (!target || target.owner_id !== message.from!.id) throw new UserError('请回复自己的素材或草稿消息追加，或不使用回复来新建草稿。');
      if (draft && draft.id !== target.id) throw new UserError('同一相册不能分配给不同草稿。');
      draft = target;
    }
    if (draft) {
      if (draft.owner_id !== message.from!.id) throw new UserError('只能追加到自己的草稿。');
      editable(draft);
      if ((await this.store.media(draft)).length >= MAX_ITEMS) throw new UserError(`一篇最多 ${MAX_ITEMS} 个素材，请另建草稿。`);
    }
    const cfg = config(this.env);
    const archive = await telegram<Chat>(this.env, 'getChat', { chat_id: cfg.archive });
    if (archive.type !== 'channel' || archive.username) throw new UserError('存档目标必须是私有频道。');
    const copied = await telegram<{ message_id: number }>(this.env, 'copyMessage', {
      chat_id: cfg.archive, from_chat_id: message.chat.id, message_id: message.message_id,
    });
    const appending = !!draft;
    const conflictingCaption = !!(draft?.caption && caption && draft.caption !== caption);
    if (draft) {
      draft = await this.store.append(draft, { ...media, source_chat_id: message.chat.id,
        source_message_id: message.message_id, archive_message_id: copied.message_id },
        !draft.caption && caption ? caption : undefined);
    } else {
      const [name, target] = Object.entries(cfg.channels)[0];
      draft = await this.store.create({
        owner_id: message.from!.id, source_chat_id: message.chat.id,
        source_message_id: message.message_id, file_id: media.file_id, file_size: media.file_size,
        archive_message_id: copied.message_id, caption, target_name: name, target_id: target,
      }, media);
    }
    if (message.media_group_id) await this.store.bindAlbum(message.chat.id, message.media_group_id, draft.id);
    await this.store.link(message.chat.id, message.message_id, draft.id);
    await this.receipt(draft, message.chat.id, conflictingCaption);
    // Telegram sends albums as separate updates with no "last item" flag. The admin
    // explicitly requests a preview after checking the received count, never a timer guess.
    if (!message.media_group_id && !appending) await this.preview(draft, message.chat.id);
  }

  async receipt(draft: Draft, chat: number, conflictingCaption = false) {
    const items = await this.store.media(draft);
    const images = items.filter(item => item.kind === 'image').length;
    const sent = await this.say(chat, `素材已存档。草稿：${draft.id}\n` +
      `已收到 ${images} 张图片、${items.length - images} 个视频，共 ${items.length} 个。\n` +
      '全部收齐后点击“生成预览”；回复此消息可以追加素材或修改文案。' +
      (conflictingCaption ? '\n这次附带的文案与已有文案不同，已保留原文案；如需修改，请回复草稿发送新文案。' : ''),
      { reply_markup: { inline_keyboard: [[{ text: '生成预览', callback_data: `preview:${draft.id}` }]] } });
    await this.store.link(chat, sent.message_id, draft.id);
  }

  async check(chatId: number) {
    const cfg = config(this.env);
    const me = await telegram<{ id: number }>(this.env, 'getMe');
    const lines = [];
    for (const [name, id] of [['私有存档频道', cfg.archive], ...Object.entries(cfg.channels)] as [string, number][]) {
      try {
        const chat = await telegram<Chat>(this.env, 'getChat', { chat_id: id });
        const member = await telegram<{ status: string; can_post_messages?: boolean }>(
          this.env, 'getChatMember', { chat_id: id, user_id: me.id },
        );
        const allowed = chat.type === 'channel' && (member.status === 'creator' ||
          (member.status === 'administrator' && member.can_post_messages));
        lines.push(`${name}：${id === cfg.archive && chat.username ? '❌ 存档频道必须私有' :
          allowed ? '✅ 可发布' : '❌ 缺少频道发布权限'}`);
      } catch { lines.push(`${name}：❌ 无法访问，请检查 ID 和权限`); }
    }
    lines.push(`视频服务：${cfg.base}`, '以上仅检查 Telegram 权限，实际播放请用测试视频验收。');
    await this.say(chatId, lines.join('\n'));
  }

  async message(message: Message) {
    const owner = message.from!.id, chat = message.chat.id;
    if (message.video || message.photo?.length || message.document) { await this.upload(message); return; }
    if (!message.text) throw new UserError('请发送图片、MP4 视频或文本，输入 /help 查看说明。');
    const parts = message.text.trim().split(/\s+/);
    const command = parts[0].split('@')[0];
    if (command === '/start' || command === '/help') { await this.say(chat, HELP); return; }
    if (command === '/check') { await this.check(chat); return; }
    if (command === '/drafts') {
      await this.store.recover();
      const items = await this.store.recent(owner);
      await this.say(chat, items.map(d => `${STATUS[d.status]} · ${d.target_name}\n` +
        `${d.caption.slice(0, 50) || '尚未填写文案'}\n/draft ${d.id}`).join('\n\n') || '还没有草稿，先发图片或视频。');
      return;
    }
    if (command === '/draft') {
      if (parts.length !== 2) throw new UserError('用法：/draft 草稿编号');
      await this.store.recover();
      await this.preview(await this.store.owned(parts[1], owner), chat);
      return;
    }
    if (command === '/resolve') {
      let messageId = null;
      if (parts.length === 4 && parts[2] === 'sent' && /^[1-9]\d*$/.test(parts[3]) &&
          Number.isSafeInteger(Number(parts[3]))) messageId = Number(parts[3]);
      else if (!(parts.length === 3 && parts[2] === 'retry')) {
        throw new UserError('先检查频道，再选择：\n/resolve 草稿编号 sent 消息编号\n/resolve 草稿编号 retry');
      }
      const draft = await this.resolve(await this.store.owned(parts[1], owner), messageId);
      await this.preview(draft, chat);
      return;
    }
    if (command.startsWith('/')) throw new UserError('未知命令，输入 /help 查看说明。');
    const replied = message.reply_to_message;
    if (!replied) throw new UserError('请回复对应素材或草稿消息来填写文案，避免配错视频。');
    const draft = await this.store.reply(chat, replied.message_id);
    if (!draft || draft.owner_id !== owner) throw new UserError('这条消息没有关联你的素材，请用 /drafts 选择草稿。');
    const edited = await this.edit(draft, { caption: message.text });
    await this.store.link(chat, message.message_id, draft.id);
    await this.preview(edited, chat);
  }

  async callback(query: Callback) {
    // A queue-delayed callback may have expired; the underlying operation is still valid.
    try { await telegram(this.env, 'answerCallbackQuery', { callback_query_id: query.id }); } catch { /* best effort */ }
    const [action, id, arg] = (query.data ?? '').split(':');
    if (!id) return;
    const owner = query.from.id, chat = query.message!.chat.id;
    const draft = await this.store.owned(id, owner);
    if (action === 'pub' && /^\d+$/.test(arg ?? '')) {
      const sent = await this.publish(id, owner, Number(arg));
      await this.say(chat, `✅ 已发布到「${sent.target_name}」\n草稿：${id}\n频道消息编号：${sent.published_message_id}`);
    } else if (action === 'preview') {
      await this.preview(draft, chat);
      return;
    } else if (action === 'targets') {
      editable(draft);
      await this.say(chat, '选择这篇内容的发布频道：', { reply_markup: { inline_keyboard:
        Object.entries(config(this.env).channels).map(([name, target]) => [{
          text: name, callback_data: `target:${id}:${target}`,
        }]),
      } });
      return;
    } else if (action === 'target') {
      const name = Object.entries(config(this.env).channels).find(([, target]) => String(target) === arg)?.[0];
      if (!name) throw new UserError('频道配置已变化，请重新选择。');
      await this.preview(await this.edit(draft, { target: name }), chat);
      return;
    } else if (action === 'cancel') {
      await this.edit(draft, { cancel: true });
      await this.say(chat, '已取消草稿，存档素材保留，观看地址停止提供新请求。');
    } else return;
    try {
      await telegram(this.env, 'editMessageReplyMarkup', {
        chat_id: chat, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [] },
      });
    } catch { /* Old messages may have been deleted; state in D1 is authoritative. */ }
  }
}

export async function processUpdate(env: Env, update: Update) {
  if (!authorized(update, env)) return;
  const bot = new BotHandler(env);
  const owner = update.callback_query?.from.id ?? update.message!.from!.id;
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO processed_updates VALUES (?,?,?)')
    .bind(update.update_id, 'processing', Date.now()).run();
  if (!inserted.meta.changes) {
    const state = await env.DB.prepare('SELECT state FROM processed_updates WHERE update_id=?')
      .bind(update.update_id).first<string>('state');
    if (state === 'done') return;
    // A terminated attempt may already have caused external side effects. Never blindly replay it.
    await bot.store.recover();
    try { await bot.say(owner, '上次操作意外中断，已停止自动重试。请用 /drafts 检查草稿和频道后继续。'); } catch { /* best effort */ }
  } else {
    try {
      if (update.callback_query) await bot.callback(update.callback_query);
      else if (update.message) await bot.message(update.message);
    } catch (error) {
      // Never log upstream URLs or raw exception messages, which may include bot credentials.
      const explanation = error instanceof UserError ? error.message :
        '操作暂时失败。请先用 /drafts 检查草稿状态，再重新预览。';
      try { await bot.say(owner, explanation); } catch { /* The admin can recover via /drafts. */ }
    }
  }
  await env.DB.prepare("UPDATE processed_updates SET state='done' WHERE update_id=?")
    .bind(update.update_id).run();
}
