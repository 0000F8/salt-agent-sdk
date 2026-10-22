// Live and short-video types (salt-api /api/v1/live_sessions, /stream_credentials, /media, /video_posts, /video/feed).
// Shapes follow the media build contract; client.ts carries the methods.

import type { SaltId } from "./ids.js";

export interface MediaPerson {
  id: SaltId;
  username: string;
  display_name: string;
  avatar_url: string | null;
  account_type: string;
}

export type LiveSessionState = "connecting" | "live" | "ending" | "ended" | "failed";

export interface LiveSession {
  id: string;
  chat_id: SaltId;
  state: LiveSessionState;
  title: string | null;
  source_type: "webrtc" | "rtmp";
  record: boolean;
  host: MediaPerson;
  started_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  viewer_count: number;
  peak_viewers: number;
  recording: null | { media_id: string; video_post_id: string; status: "processing" | "draft" | "published" | "discarded" };
  /** Viewer-relative: the host, or a room admin. */
  can_end: boolean;
}

export interface StreamCredential {
  id: SaltId;
  chat_id: SaltId;
  label: string | null;
  protocol: "rtmps";
  key_last4: string;
  persistent: boolean;
  enabled: boolean;
  last_used_at: string | null;
  created_at: string;
}

/** Returned once, when a live session or credential is made or rotated, and never again. Treat `stream_key` as a secret. */
export interface PublishBlock {
  ingest_endpoint: string;
  stream_key: string;
  /** `rtmps://<ingest_endpoint>:443/app/`: append the stream key for the full publish URL. */
  rtmps_url: string;
}

export interface MediaAsset {
  id: string;
  kind: string;
  state: "uploading" | "processing" | "ready" | "failed" | "removed";
  playback: null | { kind: "progressive" | "hls"; url: string; poster_url: string | null };
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  failed_reason: string | null;
  transcript: null | { status: "pending" | "ready" | "failed"; language: string | null; text_url: string | null; vtt_url: string | null };
  created_at: string;
}

export interface VideoPost {
  id: string;
  status: "draft" | "published" | "hidden" | "removed";
  caption: string | null;
  media: MediaAsset;
  creator: MediaPerson;
  chat_id: SaltId;
  room: null | { id: SaltId; name: string };
  also_in_chat_id: SaltId | null;
  message_id: SaltId | null;
  published_at: string | null;
  seq: number | null;
  counts: { views: number; replies: number; reactions: number };
  can_edit: boolean;
  live_session_id: string | null;
}

export interface UploadPlan {
  upload_id: string;
  part_size: number;
  parts: { n: number; url: string }[];
}

export interface VideoFeedPage {
  items: VideoPost[];
  live: LiveSession[];
  next_before_seq: number | null;
}

export type VideoFeedScope = "following" | "everyone" | "room";

export interface VideoEvent {
  post_id: string;
  kind: string;
  at: string;
}

export interface MediaPlaybackCookies {
  expires_at: string;
  /** Name to value. Send them as a `Cookie` header on requests to the media CDN host. */
  cookies: Record<string, string>;
}

/** Where `uploadVideo` reads from: bytes in memory, or a path to a file on disk. */
export type VideoUploadSource = Uint8Array | string;

export interface UploadVideoOptions {
  contentType: "video/mp4" | "video/quicktime" | "video/webm" | (string & {});
  filename?: string;
  /** Attempts per part before giving up (default 3). */
  retries?: number;
}
