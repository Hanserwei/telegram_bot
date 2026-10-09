import { env as bindings, exports } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { processUpdate } from '../src/bot';
import { config, MAX_VIDEO_BYTES } from '../src/config';
import { Store } from '../src/db';
import { parseRange, serveMedia, sliceStream } from '../src/media';
import { Publisher } from '../src/publisher';
import type { Draft, Env, Update } from '../src/types';
import { telegram, telegraph } from '../src/api';

const env = bindings as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const store = new Store(env.DB);
const encoder = new TextEncoder();
let requests: { path: string; body: Record<string, any> }[];
let serial: number;
let publishFailure: 'network' | 'forbidden' | undefined;
let mediaMode: 'full' | 'range' | 'redirect' | 'wrong-range';

function api(result: unknown) { return Response.json({ ok: true, result }); }
async function bodyText(response: Response) {
  return new TextDecoder().decode(await response.arrayBuffer());
}

function mockNetwork() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Exercise workerd's request validation before replacing the external network.
    // In particular Workers rejects redirect: 'error', unlike Node's fetch.
    new Request(String(input), init);
    const url = new URL(String(input));
    if (url.hostname === 'api.telegram.org' && url.pathname.startsWith('/file/')) {
      requests.push({ path: 'download', body: { range: new Headers(init?.headers).get('Range') } });
      if (mediaMode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://secret.example' } });
      const data = '0123456789';
      const range = new Headers(init?.headers).get('Range');
      if (range && (mediaMode === 'range' || mediaMode === 'wrong-range')) {
        const parsed = parseRange(range, 10)!;
        const piece = data.slice(parsed.start, parsed.end + 1);
        return new Response(piece, { status: 206, headers: {
          'Content-Length': String(piece.length),
          'Content-Range': mediaMode === 'wrong-range' ? 'bytes 0-1/999' :
            `bytes ${parsed.start}-${parsed.end}/10`,
        } });
      }
      return new Response(data, { headers: { 'Content-Length': '10' } });
    }
    if (url.hostname === 'api.telegram.org') {
      const method = url.pathname.split('/').at(-1)!;
      const body = JSON.parse(String(init?.body ?? '{}'));
      requests.push({ path: method, body });
      if (method === 'getChat') return api({ id: body.chat_id, type: 'channel' });
      if (method === 'getMe') return api({ id: 99, username: 'test_bot' });
      if (method === 'getChatMember') return api({ status: 'administrator', can_post_messages: true });
      if (method === 'getFile') return api({ file_path: 'videos/file.mp4', file_size: 10 });
      if (method === 'sendMessage') {
        if (body.chat_id < 0 && publishFailure === 'network') throw new Error('contains-private-token');
        if (body.chat_id < 0 && publishFailure === 'forbidden') {
          return Response.json({ ok: false, error_code: 403 }, { status: 403 });
        }
        return api({ message_id: ++serial, chat: { id: body.chat_id, type: body.chat_id < 0 ? 'channel' : 'private' } });
      }
      if (method === 'copyMessage') return api({ message_id: ++serial });
      if (method === 'answerCallbackQuery' || method === 'editMessageReplyMarkup') return api(true);
      throw new Error(`Unexpected API method ${method}`);
    }
    if (url.hostname === 'api.telegra.ph') {
      const method = url.pathname.slice(1);
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      requests.push({ path: method, body });
      if (method === 'createAccount') return api({ access_token: 'test-telegraph-access-token' });
      if (method === 'createPage' || method === 'editPage') {
        const path = body.path || `video-${++serial}`;
        return api({ path, url: `https://telegra.ph/${path}` });
      }
    }
    throw new Error('Unexpected external request');
  });
}

function upload(id = 1, caption?: string): Update {
  return { update_id: id, message: {
    message_id: id, from: { id: 111 }, chat: { id: 111, type: 'private' },
    video: { file_id: `telegram-file-${id}`, file_size: 10, mime_type: 'video/mp4' }, caption,
  } };
}
function photo(id: number, caption?: string): Update {
  const update = upload(id, caption);
  delete update.message!.video;
  update.message!.photo = [
    { file_id: `large-photo-${id}`, file_size: 10, width: 1280, height: 720 },
    { file_id: `thumbnail-${id}`, file_size: 3, width: 90, height: 90 },
  ];
  return update;
}
function album(update: Update, group = 'album-A'): Update {
  update.message!.media_group_id = group;
  return update;
}
function text(id: number, value: string, reply?: number): Update {
  return { update_id: id, message: {
    message_id: id, from: { id: 111 }, chat: { id: 111, type: 'private' }, text: value,
    ...(reply ? { reply_to_message: { message_id: reply, chat: { id: 111, type: 'private' } } } : {}),
  } };
}
function callback(id: number, data: string, owner = 111): Update {
  return { update_id: id, callback_query: {
    id: String(id), from: { id: owner }, data,
    message: { message_id: 500, chat: { id: owner, type: 'private' } },
  } };
}
async function draft(caption = '测试视频'): Promise<Draft> {
  return store.create({ owner_id: 111, source_chat_id: 111, source_message_id: ++serial,
    file_id: 'telegram-file', file_size: 10, archive_message_id: 900,
    caption, target_name: '主频道', target_id: -1001000 });
}
const publishedRequests = () => requests.filter(r => r.path === 'sendMessage' && r.body.chat_id < 0);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 1));
  await env.DB.prepare(`INSERT INTO drafts (id,token,owner_id,source_chat_id,source_message_id,
    file_id,file_size,archive_message_id,caption,target_name,target_id,created_at,updated_at,status,page_url)
    VALUES ('legacy',?,111,111,1,'old-file',10,1,'old caption','主频道',-1001000,1,1,'published','https://telegra.ph/old')`)
    .bind('a'.repeat(64)).run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const migrated = await store.mediaByToken('a'.repeat(64));
  expect(migrated?.file_id).toBe('old-file');
  expect(migrated?.mime_type).toBe('video/mp4');
  expect((await store.get('legacy'))?.page_url).toBe('https://telegra.ph/old');
});
beforeEach(async () => {
  await env.DB.batch(['incoming_albums', 'albums', 'media_items', 'message_links', 'drafts', 'settings', 'processed_updates']
    .map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  serial = 1000;
  requests = [];
  publishFailure = undefined;
  mediaMode = 'full';
  vi.stubGlobal('fetch', mockNetwork());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('administrator workflow', () => {
  it('archives, binds a reply, generates a Telegraph video page, selects a channel, and publishes once', async () => {
    await processUpdate(env, upload());
    let item = (await store.recent(111))[0];
    expect(item.caption).toBe('');
    expect(requests.filter(r => r.path === 'copyMessage')).toHaveLength(1);
    expect(publishedRequests()).toHaveLength(0);
    await processUpdate(env, text(2, '标题\n这是一条测试文案', 1));
    item = (await store.get(item.id))!;
    expect(item.caption).toBe('标题\n这是一条测试文案');
    const page = requests.find(r => r.path === 'createPage')!;
    expect(JSON.parse(page.body.content)).toEqual([{ tag: 'video', attrs: {
      src: `https://videos.example.com/media/${item.token}.mp4`,
    } }]);
    expect(page.body.content).not.toContain(env.BOT_TOKEN);
    expect(page.body.content).not.toContain('telegram-file');
    await processUpdate(env, callback(3, `target:${item.id}:-1002000`));
    item = (await store.get(item.id))!;
    expect(item.target_name).toBe('第二频道');
    const publish = callback(4, `pub:${item.id}:${item.revision}`);
    await processUpdate(env, publish);
    await processUpdate(env, publish); // Telegram webhook redelivery
    await processUpdate(env, callback(5, `pub:${item.id}:${item.revision}`)); // double click
    expect(publishedRequests()).toHaveLength(1);
    expect(publishedRequests()[0].body.chat_id).toBe(-1002000);
    expect(publishedRequests()[0].body.text).toBe(`${item.caption}\n\n▶️ 点击观看\n${item.page_url}`);
    expect((await store.get(item.id))?.status).toBe('published');
  });

  it('does not confuse replies when two videos are uploaded', async () => {
    await processUpdate(env, upload(10));
    await processUpdate(env, upload(11));
    await processUpdate(env, text(12, '第二个视频文案', 11));
    await processUpdate(env, text(13, '第一个视频文案', 10));
    expect((await store.source(111, 10))?.caption).toBe('第一个视频文案');
    expect((await store.source(111, 11))?.caption).toBe('第二个视频文案');
  });

  it('requires an explicit reply instead of silently attaching text to the last video', async () => {
    await processUpdate(env, upload());
    await processUpdate(env, text(2, '未关联的文案'));
    expect((await store.recent(111))[0].caption).toBe('');
    expect(requests.at(-1)?.body.text).toContain('回复对应素材');
  });

  it('rejects unauthorized uploads and ownership changes by another admin', async () => {
    const update = upload();
    update.message!.from!.id = 333;
    update.message!.chat.id = 333;
    await processUpdate(env, update);
    expect(requests).toHaveLength(0);
    const item = await draft();
    await processUpdate(env, callback(2, `cancel:${item.id}`, 222));
    expect((await store.get(item.id))?.status).toBe('draft');
  });

  it.each(['oversize', 'format'])('rejects %s before copying or saving a video', async kind => {
    const update = upload();
    if (kind === 'oversize') update.message!.video!.file_size = MAX_VIDEO_BYTES + 1;
    if (kind === 'format') update.message!.video!.mime_type = 'video/quicktime';
    await processUpdate(env, update);
    expect(await store.recent(111)).toHaveLength(0);
    expect(requests.some(r => r.path === 'copyMessage')).toBe(false);
  });

  it('rejects a public archive channel', async () => {
    const original = mockNetwork();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/getChat')) return api({ id: -1009000, type: 'channel', username: 'public' });
      return original(url, init);
    });
    await processUpdate(env, upload());
    expect(await store.recent(111)).toHaveLength(0);
    expect(requests.at(-1)?.body.text).toContain('私有频道');
  });

  it('preserves a recoverable draft if Telegraph is unavailable', async () => {
    const original = mockNetwork();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.includes('api.telegra.ph')) throw new Error('network');
      return original(url, init);
    });
    await processUpdate(env, upload(1, '文案'));
    const items = await store.recent(111);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('draft');
    expect(await store.reply(111, 1)).not.toBeNull();
    expect(publishedRequests()).toHaveLength(0);
  });
});

describe('photos, albums, and mixed posts', () => {
  it('uses the largest Telegram photo and serves its JPEG with the correct content type', async () => {
    await processUpdate(env, photo(1, '一张图片'));
    const item = (await store.recent(111))[0];
    const media = await store.media(item);
    expect(media).toHaveLength(1);
    expect(media[0].file_id).toBe('large-photo-1');
    const content = JSON.parse(requests.find(r => r.path === 'createPage')!.body.content);
    expect(content).toEqual([{ tag: 'img', attrs: { src: `https://videos.example.com/media/${item.token}.jpg` } }]);
    const response = await worker.fetch(new Request(content[0].attrs.src), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await bodyText(response)).toBe('0123456789');
    expect((await worker.fetch(new Request(content[0].attrs.src.replace('.jpg', '.mp4')), env)).status).toBe(404);
  });

  it.each(['image/png', 'image/webp', 'image/gif', 'image/jpeg'])('accepts an image sent as a %s document', async mime => {
    const update = upload(1, '图片文件');
    update.message!.document = { ...update.message!.video!, mime_type: mime };
    delete update.message!.video;
    await processUpdate(env, update);
    const item = (await store.recent(111))[0];
    expect((await store.media(item))[0].mime_type).toBe(mime);
    expect(JSON.parse(requests.find(r => r.path === 'createPage')!.body.content)[0].tag).toBe('img');
  });

  it.each(['photos', 'videos', 'mixed'])('groups %s into one page and one published post', async kind => {
    const make = (id: number) => kind === 'photos' || (kind === 'mixed' && id % 2) ? photo(id) : upload(id);
    // Queue delivery order is not guaranteed. Telegram source message order is preserved.
    for (const id of [3, 1, 2]) {
      const update = album(make(id));
      if (id === 1) update.message!.caption = '相册文案';
      await processUpdate(env, update);
    }
    const drafts = await store.recent(111);
    expect(drafts).toHaveLength(1);
    const item = drafts[0];
    const media = await store.media(item);
    expect(media.map(m => m.source_message_id)).toEqual([1, 2, 3]);
    expect(item.caption).toBe('相册文案');
    expect(requests.some(r => r.path === 'createPage')).toBe(false);
    expect(requests.some(r => JSON.stringify(r.body.reply_markup ?? {}).includes(`pub:${item.id}`))).toBe(false);
    await processUpdate(env, callback(10, `preview:${item.id}`));
    const content = JSON.parse(requests.find(r => r.path === 'createPage')!.body.content);
    expect(content.map((node: any) => node.tag)).toEqual(media.map(m => m.kind === 'image' ? 'img' : 'video'));
    const ready = (await store.get(item.id))!;
    await processUpdate(env, callback(11, `pub:${item.id}:${ready.revision}`));
    expect(publishedRequests()).toHaveLength(1);
    expect((await store.get(item.id))?.status).toBe('published');
  });

  it('keeps separate albums and administrator drafts isolated', async () => {
    await processUpdate(env, album(photo(1), 'A'));
    await processUpdate(env, album(upload(2), 'B'));
    const other = album(photo(3), 'A');
    other.message!.from!.id = 222;
    other.message!.chat.id = 222;
    await processUpdate(env, other);
    expect(await store.recent(111)).toHaveLength(2);
    expect(await store.recent(222)).toHaveLength(1);
    expect((await store.album(111, 'A'))?.id).not.toBe((await store.album(222, 'A'))?.id);
  });

  it('deduplicates repeated album updates and source messages', async () => {
    const update = album(photo(1));
    await processUpdate(env, update);
    await processUpdate(env, update);
    await processUpdate(env, { ...update, update_id: 2 });
    const item = (await store.recent(111))[0];
    expect(await store.media(item)).toHaveLength(1);
    expect(requests.filter(r => r.path === 'copyMessage')).toHaveLength(1);
  });

  it('appends a mixed album by replying to an existing draft and refreshes the same page', async () => {
    await processUpdate(env, upload(1, '文案'));
    const first = (await store.recent(111))[0];
    const addition = album(photo(2));
    addition.message!.reply_to_message = { message_id: 1, chat: { id: 111, type: 'private' } };
    await processUpdate(env, addition);
    await processUpdate(env, album(upload(3)));
    const changed = (await store.get(first.id))!;
    expect(await store.recent(111)).toHaveLength(1);
    expect(await store.media(changed)).toHaveLength(3);
    await expect(new Publisher(env).publish(first.id, 111, first.revision)).rejects.toThrow('最新预览');
    await processUpdate(env, callback(4, `preview:${first.id}`));
    const edited = requests.filter(r => r.path === 'editPage').at(-1)!;
    expect(JSON.parse(edited.body.content).map((m: any) => m.tag)).toEqual(['video', 'img', 'video']);
    expect((await store.get(first.id))?.page_url).toBe(first.page_url);
  });

  it('allows a caption reply to any member of an album', async () => {
    await processUpdate(env, album(photo(1)));
    await processUpdate(env, album(upload(2)));
    await processUpdate(env, text(3, '统一文案', 2));
    const item = (await store.recent(111))[0];
    expect(item.caption).toBe('统一文案');
    expect(JSON.parse(requests.find(r => r.path === 'createPage')!.body.content)).toHaveLength(2);
  });

  it('does not overwrite existing copy with conflicting attachment captions', async () => {
    await processUpdate(env, album(photo(1, '保留这篇文案')));
    await processUpdate(env, album(upload(2, '不同的附带文案')));
    const item = (await store.recent(111))[0];
    expect(item.caption).toBe('保留这篇文案');
    expect(await store.media(item)).toHaveLength(2);
    expect(requests.at(-1)?.body.text).toContain('保留原文案');
  });

  it('rejects appending to another admin or a published draft before copying', async () => {
    await processUpdate(env, photo(1, '文案'));
    const item = (await store.recent(111))[0];
    const other = upload(2);
    other.message!.from!.id = 222; other.message!.chat.id = 222;
    other.message!.reply_to_message = { message_id: 1, chat: { id: 222, type: 'private' } };
    await processUpdate(env, other);
    await new Publisher(env).publish(item.id, 111, item.revision);
    const after = upload(3);
    after.message!.reply_to_message = { message_id: 1, chat: { id: 111, type: 'private' } };
    await processUpdate(env, after);
    expect(requests.filter(r => r.path === 'copyMessage')).toHaveLength(1);
    expect(await store.media(item)).toHaveLength(1);
  });

  it('limits a draft to 20 items without silently discarding the overflow', async () => {
    for (let id = 1; id <= 21; id++) await processUpdate(env, album(photo(id)));
    const item = (await store.recent(111))[0];
    expect(await store.media(item)).toHaveLength(20);
    expect(requests.filter(r => r.path === 'copyMessage')).toHaveLength(20);
    expect(requests.at(-1)?.body.text).toContain('最多 20');
  });

  it('blocks preview and publication while an already received album item is queued', async () => {
    await processUpdate(env, album(photo(1, '文案')));
    const item = (await store.recent(111))[0];
    const next = album(upload(2));
    const send = vi.fn(async () => {});
    const response = await worker.fetch(new Request('https://videos.example.com/telegram/webhook', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET }, body: JSON.stringify(next),
    }), { ...env, UPDATES: { send } as unknown as Queue<Update> });
    expect(response.status).toBe(200);
    const publisher = new Publisher(env);
    await expect(publisher.prepare(item)).rejects.toThrow('仍在接收');
    await expect(publisher.publish(item.id, 111, item.revision)).rejects.toThrow('仍在接收');
    expect(publishedRequests()).toHaveLength(0);
    await processUpdate(env, next);
    const ready = await publisher.prepare((await store.get(item.id))!);
    expect(ready.page_url).toBeTruthy();
    expect(await store.media(ready)).toHaveLength(2);
  });

  it('revokes every image and video URL when the draft is cancelled', async () => {
    await processUpdate(env, album(photo(1)));
    await processUpdate(env, album(upload(2)));
    const item = (await store.recent(111))[0];
    const media = await store.media(item);
    await new Publisher(env).edit(item, { cancel: true });
    for (const m of media) {
      const response = await worker.fetch(new Request(`https://videos.example.com/media/${m.token}.${m.extension}`), env);
      expect(response.status).toBe(404);
    }
  });

  it('retains legacy media even for uploads arriving between migration and deployment', async () => {
    const item = await draft();
    await env.DB.prepare('DELETE FROM media_items WHERE draft_id=?').bind(item.id).run();
    expect((await store.mediaByToken(item.token))?.file_id).toBe(item.file_id);
    const extended = await store.append(item, { source_chat_id: 111, source_message_id: 9000,
      file_id: 'new-image', file_size: 10, archive_message_id: 9001,
      kind: 'image', mime_type: 'image/png', extension: 'png' });
    expect((await store.media(extended)).map(m => m.file_id)).toEqual([item.file_id, 'new-image']);
  });
});

describe('publication state and recovery', () => {
  it('invalidates old preview buttons after caption edits', async () => {
    const publisher = new Publisher(env), item = await draft();
    await publisher.edit(item, { caption: '修改后的文案' });
    await expect(publisher.publish(item.id, 111, item.revision)).rejects.toThrow('最新预览');
    expect(publishedRequests()).toHaveLength(0);
  });

  it('atomically allows only one simultaneous publication', async () => {
    const publisher = new Publisher(env);
    const item = await publisher.prepare(await draft());
    const outcomes = await Promise.allSettled([
      publisher.publish(item.id, 111, item.revision), publisher.publish(item.id, 111, item.revision),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(publishedRequests()).toHaveLength(1);
  });

  it('blocks stale target IDs if configuration changes', async () => {
    const item = await draft();
    const changed = { ...env, PUBLISH_CHANNELS: '{"主频道":-1009999}' };
    await expect(new Publisher(changed).publish(item.id, 111, 0)).rejects.toThrow('配置已变化');
    expect(publishedRequests()).toHaveLength(0);
  });

  it('marks ambiguous delivery uncertain and requires explicit recovery before retrying', async () => {
    const publisher = new Publisher(env), item = await draft();
    publishFailure = 'network';
    await expect(publisher.publish(item.id, 111, 0)).rejects.toThrow('无法确认');
    expect((await store.get(item.id))?.status).toBe('uncertain');
    await expect(publisher.publish(item.id, 111, 0)).rejects.toThrow('待核实');
    expect(publishedRequests()).toHaveLength(1);
    publishFailure = undefined;
    const reset = await publisher.resolve((await store.get(item.id))!, null);
    expect(reset.revision).toBe(1);
    expect(reset.status).toBe('draft');
    expect(publishedRequests()).toHaveLength(1); // resolving does not itself publish
    await publisher.publish(item.id, 111, reset.revision);
    expect(publishedRequests()).toHaveLength(2);
  });

  it('restores a draft after a definite API rejection', async () => {
    const item = await draft();
    publishFailure = 'forbidden';
    await expect(new Publisher(env).publish(item.id, 111, 0)).rejects.toThrow('未接收');
    expect((await store.get(item.id))?.status).toBe('draft');
  });

  it('recovers interrupted publishing without automatically resending', async () => {
    const item = await draft();
    await env.DB.prepare("UPDATE drafts SET status='publishing',updated_at=? WHERE id=?")
      .bind(Date.now() - 130_000, item.id).run();
    await store.recover();
    expect((await store.get(item.id))?.status).toBe('uncertain');
    expect(publishedRequests()).toHaveLength(0);
  });

  it('does not replay an interrupted queue update that may already have side effects', async () => {
    await env.DB.prepare('INSERT INTO processed_updates VALUES (?,?,?)').bind(1, 'processing', Date.now()).run();
    await processUpdate(env, upload(1));
    expect(requests.some(r => r.path === 'copyMessage')).toBe(false);
    expect(requests.at(-1)?.body.text).toContain('意外中断');
  });

  it('reuses the persisted Telegraph account and edits an existing page', async () => {
    const publisher = new Publisher(env);
    const first = await publisher.prepare(await draft());
    const changed = await publisher.edit(first, { caption: '新标题' });
    const edited = await publisher.prepare(changed);
    await publisher.prepare(await draft('另一视频'));
    expect(edited.page_url).toBe(first.page_url);
    expect(requests.filter(r => r.path === 'createAccount')).toHaveLength(1);
    expect(requests.filter(r => r.path === 'editPage')).toHaveLength(1);
  });
});

describe('video streaming', () => {
  async function request(range?: string, method = 'GET') {
    const item = await draft();
    return serveMedia(new Request(`https://videos.example.com/media/${item.token}.mp4`, {
      method, headers: range ? { Range: range } : {},
    }), env, item.token);
  }

  it('streams a complete video without exposing credentials or upstream headers', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(await bodyText(response)).toBe('0123456789');
    expect(JSON.stringify([...response.headers])).not.toContain(env.BOT_TOKEN);
  });

  it.each(['full', 'range'])('supports seeking when upstream serves %s responses', async mode => {
    mediaMode = mode as typeof mediaMode;
    const response = await request('bytes=3-6');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 3-6/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(await bodyText(response)).toBe('3456');
  });

  it.each([['bytes=-3', '789'], ['bytes=8-', '89'], ['bytes=8-999', '89']])(
    'supports %s', async (range, expected) => { expect(await bodyText(await request(range))).toBe(expected); },
  );

  it.each(['bytes=10-', 'bytes=5-2', 'bytes=0-1,4-5', 'bytes=-0', 'nonsense'])(
    'rejects invalid range %s before contacting Telegram', async range => {
      const response = await request(range);
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */10');
      expect(requests).toHaveLength(0);
    },
  );

  it('answers HEAD without downloading video', async () => {
    const response = await request(undefined, 'HEAD');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(await response.text()).toBe('');
    expect(requests).toHaveLength(0);
  });

  it('preserves byte lengths through the real Workers HTTP boundary, including HEAD', async () => {
    const item = await draft();
    const url = `https://videos.example.com/media/${item.token}.mp4`;
    const head = await exports.default.fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('10');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const partial = await exports.default.fetch(url, { headers: { Range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Length')).toBe('4');
    expect(await bodyText(partial)).toBe('2345');
  });

  it.each(['redirect', 'wrong-range'])('hides unsafe or invalid upstream %s responses', async mode => {
    mediaMode = mode as typeof mediaMode;
    const response = await request('bytes=3-6');
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).not.toContain(env.BOT_TOKEN);
  });

  it('rejects unknown tokens, traversal attempts and cancelled videos', async () => {
    const item = await draft();
    await new Publisher(env).edit(item, { cancel: true });
    for (const token of [item.token, 'f'.repeat(64), '../secrets']) {
      const response = await serveMedia(new Request('https://videos.example.com'), env, token);
      expect(response.status).toBe(404);
    }
    expect(requests).toHaveLength(0);
  });

  it('trims across upstream chunk boundaries and cancels unread bytes', async () => {
    let n = 0;
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(encoder.encode(['012', '345', '678', '9'][n++])); }, cancel,
    });
    expect(await new Response(sliceStream(source, 4, 3)).text()).toBe('456');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fails a truncated stream instead of silently returning a partial video as success', async () => {
    const source = new Response('12').body!;
    await expect(new Response(sliceStream(source, 0, 5)).text()).rejects.toThrow('interrupted');
  });
});

describe('webhook and deployment boundary', () => {
  it('uses Workers-compatible manual redirects for both external APIs', async () => {
    const fetchMock = vi.mocked(fetch);
    await telegram(env, 'getMe');
    await telegraph('createAccount', { short_name: 'test' });
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('manual');
  });

  it('checks Telegram from the deployed runtime only for an authenticated admin', async () => {
    const url = 'https://videos.example.com/internal/telegram-check';
    const denied = await worker.fetch(new Request(url, { method: 'POST' }), env);
    expect(denied.status).toBe(403);
    expect(requests).toHaveLength(0);
    const good = await worker.fetch(new Request(url, {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET },
    }), env);
    expect(await good.json()).toEqual({ ok: true, botId: 99 });
  });

  it('reports only safe error categories from the runtime diagnostic', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error(`Secret: ${env.BOT_TOKEN}`); });
    const result = await worker.fetch(new Request('https://videos.example.com/internal/telegram-check', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET },
    }), env);
    expect(await result.json()).toEqual({ ok: false, reason: 'network' });
  });
  async function webhook(body: unknown, secret = env.WEBHOOK_SECRET, send = vi.fn(async () => {})) {
    const response = await worker.fetch(new Request('https://videos.example.com/telegram/webhook', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body),
    }), { ...env, UPDATES: { send } as unknown as Queue<Update> });
    return { response, send };
  }

  it('authenticates webhook requests before enqueuing', async () => {
    const bad = await webhook(upload(), 'wrong');
    expect(bad.response.status).toBe(403);
    expect(bad.send).not.toHaveBeenCalled();
    const good = await webhook(upload());
    expect(good.response.status).toBe(200);
    expect(good.send).toHaveBeenCalledWith(upload());
  });

  it('acknowledges unauthorized senders without doing work', async () => {
    const update = upload();
    update.message!.from!.id = 333;
    update.message!.chat.id = 333;
    const { response, send } = await webhook(update);
    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns an error when durable enqueue fails so Telegram can retry', async () => {
    const { response } = await webhook(upload(), env.WEBHOOK_SECRET, vi.fn(async () => { throw new Error('queue unavailable'); }));
    expect(response.status).toBe(503);
  });

  it('rejects malformed and oversized bodies', async () => {
    expect((await webhook(null)).response.status).toBe(400);
    expect((await webhook({ update_id: 'not-numeric' })).response.status).toBe(400);
    expect((await webhook({ extra: 'x'.repeat(65537) })).response.status).toBe(413);
  });

  it('checks real D1 schema and exposes no listing or admin HTTP endpoint', async () => {
    expect((await worker.fetch(new Request('https://videos.example.com/healthz'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('https://videos.example.com/media'), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://videos.example.com/admin'), env)).status).toBe(404);
  });

  it('rejects a configuration that would expose the archive as a publishing destination', () => {
    expect(() => config({ ...env, PUBLISH_CHANNELS: '{"错误频道":-1009000}' })).toThrow('configuration');
  });
});
