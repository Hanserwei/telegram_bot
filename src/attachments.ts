import { MAX_VIDEO_BYTES, UserError } from './config';
import type { Message, MediaItem } from './types';

export const MAX_ITEMS = 20;
export function attachment(message: Message): Pick<MediaItem, 'file_id' | 'file_size' | 'kind' | 'mime_type' | 'extension'> {
  const photo = message.photo?.reduce((best, next) =>
    next.width * next.height > best.width * best.height ? next : best);
  const media = photo ?? message.video ?? message.document;
  if (!media) throw new UserError('请发送图片或 MP4 视频。');
  const mime = photo ? 'image/jpeg' : media.mime_type;
  const types: Record<string, ['image' | 'video', string]> = {
    'video/mp4': ['video', 'mp4'], 'image/jpeg': ['image', 'jpg'],
    'image/png': ['image', 'png'], 'image/webp': ['image', 'webp'], 'image/gif': ['image', 'gif'],
  };
  if (!mime || !types[mime]) throw new UserError('支持 MP4 视频，以及 JPG、PNG、WebP、GIF 图片；其他格式请先转换。');
  if (!media.file_size || !Number.isSafeInteger(media.file_size) || media.file_size < 0 || media.file_size > MAX_VIDEO_BYTES) {
    throw new UserError('每个图片或视频不能超过 10 MB，且必须包含有效的文件大小。');
  }
  return { file_id: media.file_id, file_size: media.file_size,
    kind: types[mime][0], extension: types[mime][1], mime_type: mime };
}
