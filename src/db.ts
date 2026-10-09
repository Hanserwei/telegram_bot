import type { Draft, Env, MediaItem } from './types';
import { randomHex, UserError } from './config';
import { MAX_ITEMS } from './attachments';

export class Store {
  constructor(readonly db: D1Database) {}

  async get(id: string): Promise<Draft | null> {
    return this.db.prepare('SELECT * FROM drafts WHERE id=?').bind(id).first<Draft>();
  }
  async owned(id: string, owner: number): Promise<Draft> {
    const draft = await this.get(id);
    if (!draft || draft.owner_id !== owner) throw new UserError('找不到这条草稿，请用 /drafts 查看。');
    return draft;
  }
  async byToken(token: string): Promise<Draft | null> {
    return this.db.prepare("SELECT * FROM drafts WHERE token=? AND status!='cancelled'")
      .bind(token).first<Draft>();
  }
  async media(draft: Draft): Promise<MediaItem[]> {
    const rows = (await this.db.prepare('SELECT * FROM media_items WHERE draft_id=? ORDER BY source_message_id')
      .bind(draft.id).all<MediaItem>()).results;
    // Covers a legacy upload arriving between the additive migration and deployment.
    return rows.length ? rows : [{ ...draft, draft_id: draft.id, kind: 'video', mime_type: 'video/mp4', extension: 'mp4' }];
  }
  async mediaByToken(token: string): Promise<MediaItem | null> {
    const item = await this.db.prepare(`SELECT m.* FROM media_items m JOIN drafts d ON d.id=m.draft_id
      WHERE m.token=? AND d.status!='cancelled'`).bind(token).first<MediaItem>();
    if (item) return item;
    const draft = await this.byToken(token);
    return draft ? (await this.media(draft)).find(m => m.token === token) ?? null : null;
  }
  async album(chat: number, group: string): Promise<Draft | null> {
    return this.db.prepare('SELECT d.* FROM drafts d JOIN albums a ON a.draft_id=d.id WHERE a.chat_id=? AND a.group_id=?')
      .bind(chat, group).first<Draft>();
  }
  async bindAlbum(chat: number, group: string, id: string) {
    await this.db.prepare('INSERT OR IGNORE INTO albums VALUES (?,?,?)').bind(chat, group, id).run();
  }
  async source(chat: number, message: number): Promise<Draft | null> {
    return await this.db.prepare(`SELECT d.* FROM drafts d JOIN media_items m ON m.draft_id=d.id
      WHERE m.source_chat_id=? AND m.source_message_id=?`).bind(chat, message).first<Draft>() ??
      this.db.prepare('SELECT * FROM drafts WHERE source_chat_id=? AND source_message_id=?').bind(chat, message).first<Draft>();
  }
  async create(fields: Pick<Draft, 'owner_id' | 'source_chat_id' | 'source_message_id' |
    'file_id' | 'file_size' | 'archive_message_id' | 'caption' | 'target_name' | 'target_id'>,
    type: Pick<MediaItem, 'kind' | 'mime_type' | 'extension'> = { kind: 'video', mime_type: 'video/mp4', extension: 'mp4' }) {
    const id = randomHex(8), token = randomHex(32), now = Date.now();
    await this.db.batch([this.db.prepare(`INSERT INTO drafts (id,token,owner_id,source_chat_id,source_message_id,
      file_id,file_size,archive_message_id,caption,target_name,target_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, token, fields.owner_id, fields.source_chat_id, fields.source_message_id,
      fields.file_id, fields.file_size, fields.archive_message_id, fields.caption,
      fields.target_name, fields.target_id, now, now,
    ), this.db.prepare('INSERT INTO media_items VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
      token,id,fields.source_chat_id,fields.source_message_id,fields.file_id,fields.file_size,
      fields.archive_message_id,type.kind,type.mime_type,type.extension,
    )]);
    return (await this.get(id))!;
  }
  async append(draft: Draft, item: Omit<MediaItem, 'token' | 'draft_id'>, caption?: string) {
    if (draft.status !== 'draft') throw new UserError('已发布或已取消的草稿不能追加素材，请重新发送建立新草稿。');
    if ((await this.media(draft)).length >= MAX_ITEMS) throw new UserError(`一篇内容最多 ${MAX_ITEMS} 个素材，请另建草稿。`);
    // Serialized queue consumer owns edits; the conditional insert also rejects stale revisions.
    const result = await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO media_items
        SELECT token,id,source_chat_id,source_message_id,file_id,file_size,archive_message_id,
        'video','video/mp4','mp4' FROM drafts WHERE id=?`).bind(draft.id),
      this.db.prepare(`INSERT INTO media_items SELECT ?,?,?,?,?,?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM drafts WHERE id=? AND status='draft' AND revision=?)`).bind(
        randomHex(32),draft.id,item.source_chat_id,item.source_message_id,item.file_id,item.file_size,
        item.archive_message_id,item.kind,item.mime_type,item.extension,draft.id,draft.revision,
      ),
      this.db.prepare(`UPDATE drafts SET caption=?,revision=revision+1,updated_at=?
        WHERE id=? AND status='draft' AND revision=? AND EXISTS
        (SELECT 1 FROM media_items WHERE source_chat_id=? AND source_message_id=?)`).bind(
        caption ?? draft.caption,Date.now(),draft.id,draft.revision,item.source_chat_id,item.source_message_id,
      ),
    ]);
    if (!result[1].meta.changes) throw new UserError('草稿已变化，请重新打开预览。');
    return (await this.get(draft.id))!;
  }
  async link(chat: number, message: number, draftId: string) {
    await this.db.prepare('INSERT OR REPLACE INTO message_links VALUES (?,?,?)')
      .bind(chat, message, draftId).run();
  }
  async reply(chat: number, message: number): Promise<Draft | null> {
    return this.db.prepare(`SELECT d.* FROM drafts d JOIN message_links m ON d.id=m.draft_id
      WHERE m.chat_id=? AND m.message_id=?`).bind(chat, message).first<Draft>();
  }
  async recent(owner: number): Promise<Draft[]> {
    return (await this.db.prepare('SELECT * FROM drafts WHERE owner_id=? ORDER BY created_at DESC LIMIT 10')
      .bind(owner).all<Draft>()).results;
  }
  async setting(key: string): Promise<string | null> {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<string>('value');
  }
  async saveSetting(key: string, value: string) {
    await this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').bind(key, value).run();
  }
  async recover() {
    await this.db.prepare("UPDATE drafts SET status='uncertain' WHERE status='publishing' AND updated_at<?")
      .bind(Date.now() - 120_000).run();
  }
}

export function store(env: Env) { return new Store(env.DB); }
