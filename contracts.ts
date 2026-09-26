export type JobState = 'queued' | 'awaiting_format' | 'processing' | 'uploading' | 'completed' | 'failed' | 'cancelled' | 'expired';
export const TERMINAL: JobState[] = ['completed','failed','cancelled','expired'];
const transitions: Record<JobState, JobState[]> = {
  queued: ['awaiting_format','failed','cancelled','expired'],
  awaiting_format: ['processing','uploading','failed','cancelled','expired'],
  processing: ['uploading','failed','cancelled','expired'],
  uploading: ['processing','completed','failed','expired'],
  completed: [], failed: [], cancelled: [], expired: []
};
export const canTransition = (from: JobState, to: JobState) => transitions[from].includes(to);
export type Platform = 'TikTok' | 'Instagram' | 'Facebook' | 'YouTube' | 'X / Twitter' | 'Reddit' | 'Pinterest' | 'Direct';
export type SendMethod = 'sendVideo' | 'sendAudio' | 'sendDocument';
export interface MediaFormat { id: string; kind: 'video' | 'audio'; quality: string; ext: string; filesize: number | null }
export interface Metadata { title: string; artist: string; duration: number | null; media_type: 'video' | 'audio'; formats: MediaFormat[] }
export const ERROR_CODES = ['PRIVATE_CONTENT','MEDIA_UNAVAILABLE','MEDIA_TOO_LARGE','FORMAT_UNAVAILABLE','DOWNLOAD_TIMEOUT','UNSUPPORTED_LINK','BLOCKED_URL'] as const;
export type MediaErrorCode = typeof ERROR_CODES[number];
export type WorkerCallback = {job_id: string; status: 'completed'; file_url: string; mime_type: string; file_size: number; title: string; artist: string; duration: number | null} | {job_id: string; status: 'failed'; error_code: MediaErrorCode; error_message?: string};
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: { id: string; from: {id: number; username?: string}; data?: string; message?: TelegramMessage };
}
export interface TelegramMessage { message_id: number; from?: {id: number; username?: string}; chat: {id: number; type?: string}; text?: string; caption?: string; entities?: {type: string; offset: number; length: number; url?: string}[]; caption_entities?: {type: string; offset: number; length: number; url?: string}[] }
export type QueueWork = {type: 'update'; id: number} | {type: 'deliver' | 'dispatch' | 'metadata'; id: string};
