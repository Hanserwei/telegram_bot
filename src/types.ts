export interface Env {
  DB: D1Database;
  UPDATES: Queue<Update>;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS: string;
  ARCHIVE_CHAT_ID: string;
  PUBLISH_CHANNELS: string;
  PUBLIC_BASE_URL: string;
  TELEGRAPH_AUTHOR_NAME?: string;
  TELEGRAPH_ACCESS_TOKEN?: string;
}

export interface Chat { id: number; type: string; username?: string }
export interface Media { file_id: string; file_size?: number; mime_type?: string }
export interface Message {
  message_id: number;
  chat: Chat;
  from?: { id: number };
  video?: Media;
  photo?: (Media & { width: number; height: number })[];
  document?: Media;
  media_group_id?: string;
  text?: string;
  caption?: string;
  reply_to_message?: Message;
}
export interface Callback {
  id: string;
  from: { id: number };
  message?: Message;
  data?: string;
}
export interface Update { update_id: number; message?: Message; callback_query?: Callback }
export type Status = 'draft' | 'publishing' | 'published' | 'uncertain' | 'cancelled';
export interface Draft {
  id: string;
  token: string;
  owner_id: number;
  source_chat_id: number;
  source_message_id: number;
  file_id: string;
  file_size: number;
  archive_message_id: number;
  caption: string;
  target_name: string;
  target_id: number;
  status: Status;
  revision: number;
  page_url: string | null;
  page_path: string | null;
  page_title: string | null;
  page_revision: number | null;
  published_message_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface MediaItem {
  token: string;
  draft_id: string;
  source_chat_id: number;
  source_message_id: number;
  file_id: string;
  file_size: number;
  archive_message_id: number;
  kind: 'video' | 'image';
  mime_type: string;
  extension: string;
}
