import { telegram, TelegramError, telegraph } from './api';
import { captionText, config, UserError } from './config';
import { Store } from './db';
import type { Draft, Env } from './types';

export function postText(draft: Draft): string {
  const text = `${draft.caption}\n\n▶️ 点击观看\n${draft.page_url}`;
  if (text.length > 4096) throw new UserError('文案加上观看链接过长，请缩短文案。');
  return text;
}

export function editable(draft: Draft) {
  if (draft.status !== 'draft') {
    throw new UserError('此草稿已发布、已取消或发送结果待核实，不能直接修改或再次发布。');
  }
}

export class Publisher {
  readonly store: Store;
  constructor(readonly env: Env) { this.store = new Store(env.DB); }

  async edit(draft: Draft, change: { caption?: string; target?: string; cancel?: boolean }) {
    editable(draft);
    const channels = config(this.env).channels;
    const target = change.target ?? draft.target_name;
    if (!(target in channels)) throw new UserError('该频道已移除，请重新选择。');
    const result = await this.env.DB.prepare(`UPDATE drafts SET caption=?,target_name=?,target_id=?,
      status=?,revision=revision+1,updated_at=? WHERE id=? AND status='draft' AND revision=?`).bind(
      change.caption === undefined ? draft.caption : captionText(change.caption),
      target, channels[target], change.cancel ? 'cancelled' : 'draft', Date.now(),
      draft.id, draft.revision,
    ).run();
    if (!result.meta.changes) throw new UserError('草稿已变化，请重新打开预览。');
    return (await this.store.get(draft.id))!;
  }

  async prepare(draft: Draft): Promise<Draft> {
    editable(draft);
    const pending = await this.env.DB.prepare(`SELECT 1 FROM incoming_albums i
      JOIN albums a ON a.chat_id=i.chat_id AND a.group_id=i.group_id
      LEFT JOIN processed_updates p ON p.update_id=i.update_id
      WHERE a.draft_id=? AND (p.state IS NULL OR p.state!='done') LIMIT 1`).bind(draft.id).first();
    if (pending) throw new UserError('这组素材仍在接收或处理中，请等素材收齐后再生成预览。');
    if (!draft.caption) throw new UserError('请回复原素材或草稿消息，先补充文案。');
    const title = draft.caption.split('\n')[0].slice(0, 128) || '视频';
    if (draft.page_url && draft.page_title === title && draft.page_revision === draft.revision) return draft;
    const items = await this.store.media(draft);
    let accessToken = this.env.TELEGRAPH_ACCESS_TOKEN ||
      await this.store.setting('telegraph_access_token');
    if (!accessToken) {
      const account = await telegraph<{ access_token: string }>('createAccount', {
        short_name: 'video-publisher', author_name: this.env.TELEGRAPH_AUTHOR_NAME || '视频分享',
      });
      accessToken = account.access_token;
      await this.store.saveSetting('telegraph_access_token', accessToken);
    }
    const data: Record<string, string> = {
      access_token: accessToken, title,
      author_name: this.env.TELEGRAPH_AUTHOR_NAME || '视频分享',
      content: JSON.stringify(items.map(item => ({ tag: item.kind === 'image' ? 'img' : 'video', attrs: {
        src: `${config(this.env).base}/media/${item.token}.${item.extension}`,
      } }))),
      return_content: 'false',
    };
    if (draft.page_path) data.path = draft.page_path;
    const page = await telegraph<{ url: string; path: string }>(
      draft.page_path ? 'editPage' : 'createPage', data,
    );
    const url = new URL(page.url);
    if (url.protocol !== 'https:' || url.hostname !== 'telegra.ph') {
      throw new UserError('Telegraph 返回了异常地址，请稍后重试。');
    }
    await this.env.DB.prepare('UPDATE drafts SET page_url=?,page_path=?,page_title=?,page_revision=? WHERE id=?')
      .bind(page.url, page.path, title, draft.revision, draft.id).run();
    return (await this.store.get(draft.id))!;
  }

  async publish(id: string, owner: number, revision: number): Promise<Draft> {
    let draft = await this.store.owned(id, owner);
    editable(draft);
    if (draft.revision !== revision) throw new UserError('文案或频道已更改，请在最新预览上点击发布。');
    if (config(this.env).channels[draft.target_name] !== draft.target_id) {
      throw new UserError('目标频道配置已变化，请重新选择并预览。');
    }
    draft = await this.prepare(draft);
    const text = postText(draft);
    const claimed = await this.env.DB.prepare(`UPDATE drafts SET status='publishing',updated_at=?
      WHERE id=? AND owner_id=? AND status='draft' AND revision=?`)
      .bind(Date.now(), id, owner, revision).run();
    if (!claimed.meta.changes) throw new UserError('这条草稿已经在处理中，请刷新预览。');
    let message: { message_id: number };
    try {
      message = await telegram(this.env, 'sendMessage', {
        chat_id: draft.target_id, text, link_preview_options: { url: draft.page_url },
      });
    } catch (error) {
      const definitive = error instanceof TelegramError && error.definitive;
      await this.env.DB.prepare('UPDATE drafts SET status=?,updated_at=? WHERE id=?')
        .bind(definitive ? 'draft' : 'uncertain', Date.now(), id).run();
      if (definitive) throw new UserError('频道未接收消息，请检查机器人权限或稍后重试。');
      throw new UserError(`发送结果无法确认，已暂停重试以免重复发帖。\n` +
        `先检查频道；已发送用 /resolve ${id} sent 消息编号\n` +
        `确认未发送用 /resolve ${id} retry`);
    }
    await this.env.DB.prepare(`UPDATE drafts SET status='published',published_message_id=?,updated_at=?
      WHERE id=?`).bind(message.message_id, Date.now(), id).run();
    return (await this.store.get(id))!;
  }

  async resolve(draft: Draft, messageId: number | null) {
    const result = await this.env.DB.prepare(`UPDATE drafts SET status=?,published_message_id=?,
      revision=revision+1,updated_at=? WHERE id=? AND status='uncertain'`).bind(
      messageId ? 'published' : 'draft', messageId, Date.now(), draft.id,
    ).run();
    if (!result.meta.changes) throw new UserError('仅能处理发送结果待核实的草稿。');
    return (await this.store.get(draft.id))!;
  }
}
