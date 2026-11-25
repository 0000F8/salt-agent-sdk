// Folder archives (Salt 0.265.0), the agent side: file a folder's files away in named archives and take them out again.
// NEVER deletes a file: archiving is a label, restoring removes it. Twin of saltapp-python 0.25.0's `client.folders`.
import { SaltApiError } from "./apiError.js";
import type { SaltId } from "./ids.js";

export const FOLDER_ARCHIVE_CODES = [
  "archive_required",
  "archive_name_required",
  "archive_invalid",
  "archive_not_found",
  "archive_forbidden",
  "archive_not_empty",
  "file_not_found",
  "message_ids_required",
  "too_many_files",
  "archived_invalid",
  "nothing_to_change",
] as const;
export type FolderArchiveCode = (typeof FOLDER_ARCHIVE_CODES)[number];
export const ARCHIVE_FILES_MAX = 100;

export interface FolderArchive {
  id: SaltId;
  name: string;
  note: string | null;
  created_by_id: SaltId | null;
  created_at: string;
  updated_at: string;
  /** Live (not deleted) files filed in it. */
  file_count: number;
}

/** `{name (at most 80), note? (at most 500)}`: file under the archive of this name, made if new (names are unique per folder, case-insensitive). */
export interface ArchiveSpec {
  name: string;
  note?: string;
}

/**
 * Where to file. Give `archiveId` (an existing archive) or `archive` (by name). An EXPLICIT `null` for either means restore (take the
 * file out of its archive); leaving both out is 422 `archive_required`. `dryRun` reports what would happen and writes nothing,
 * not even a new archive.
 */
export interface ArchiveTarget {
  archiveId?: SaltId | null;
  archive?: ArchiveSpec | null;
  dryRun?: boolean;
}

export interface ArchiveFileResult {
  message_id: SaltId;
  status: "archived" | "cleared" | "unchanged" | "forbidden" | "not_found";
  archive_id?: SaltId | null;
  code?: string;
  error?: string;
  next_step?: string;
}

export interface ArchiveFileResponse {
  folder_id: SaltId;
  dry_run?: boolean;
  archive?: { id: SaltId; name: string; note: string | null; created: boolean };
  file: ArchiveFileResult;
}

export interface ArchiveFilesResult {
  folder_id: SaltId;
  dry_run?: boolean;
  archive?: { id: SaltId; name: string; note: string | null; created: boolean };
  would_create_archive?: Record<string, unknown>;
  counts: Record<string, number>;
  files: ArchiveFileResult[];
}

/** A refusal from a folder-archive call, typed: `code` is one of `FOLDER_ARCHIVE_CODES`, `sentence` the server's words and `nextStep` what to do next (the server's `next_step`). `archive_not_empty` (409) names the call that empties the archive. */
export class FolderArchiveError extends SaltApiError {
  sentence: string;
  nextStep?: string;

  constructor(method: string, url: string, status: number, body: unknown) {
    super(method, url, status, body);
    this.name = "FolderArchiveError";
    const b = (body ?? {}) as { error?: unknown; next_step?: unknown };
    this.sentence = typeof b.error === "string" ? b.error : "Salt refused this archive call.";
    if (typeof b.next_step === "string") this.nextStep = b.next_step;
  }
}

/** A `FolderArchiveError` for a `SaltApiError` whose code is one of `FOLDER_ARCHIVE_CODES`; undefined for anything else. */
export function asFolderArchiveError(err: unknown): FolderArchiveError | undefined {
  if (err instanceof FolderArchiveError) return err;
  if (err instanceof SaltApiError && typeof err.code === "string" && (FOLDER_ARCHIVE_CODES as readonly string[]).includes(err.code)) {
    const m = /^Salt API (\S+) (\S+) ->/.exec(err.message);
    return new FolderArchiveError(m?.[1] ?? "GET", m?.[2] ?? "", err.status, err.body);
  }
  return undefined;
}

type Req = <T>(method: string, path: string, apiKey: string, body?: unknown, opts?: { extraHeaders?: Record<string, string>; idempotencyKey?: string }) => Promise<T>;

function spec(t: ArchiveTarget): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (t.archiveId !== undefined) body.archive_id = t.archiveId;
  if (t.archive !== undefined) body.archive = t.archive;
  if (t.dryRun !== undefined) body.dry_run = t.dryRun;
  return body;
}

export function buildFolders(request: Req) {
  async function run<T>(method: string, path: string, apiKey: string, body?: unknown): Promise<T> {
    try {
      return await request<T>(method, path, apiKey, body);
    } catch (err) {
      throw asFolderArchiveError(err) ?? err;
    }
  }
  const base = (id: SaltId) => `/api/v1/folders/${id}`;

  const api = {
    /** `GET /files`: `{folder, files, archives}`. `archived`: "all" (default), "true" (only archived) or "false"; `archiveId`: one archive's files. */
    async listFiles(
      apiKey: string,
      folderId: SaltId,
      opts?: { before?: string; limit?: number; archived?: "all" | "true" | "false" | boolean; archiveId?: SaltId }
    ): Promise<{ folder: Record<string, unknown>; files: Array<Record<string, unknown>>; archives: FolderArchive[] }> {
      const p = new URLSearchParams();
      if (opts?.before !== undefined) p.set("before", opts.before);
      if (opts?.limit !== undefined) p.set("limit", String(opts.limit));
      if (opts?.archived !== undefined) p.set("archived", String(opts.archived));
      if (opts?.archiveId !== undefined) p.set("archive_id", String(opts.archiveId));
      const qs = p.toString();
      return run("GET", `${base(folderId)}/files${qs ? `?${qs}` : ""}`, apiKey);
    },

    /** `GET /archives`: `{folder_id, archives}`, newest first, with live file counts. */
    async listArchives(apiKey: string, folderId: SaltId): Promise<{ folder_id: SaltId; archives: FolderArchive[] }> {
      return run("GET", `${base(folderId)}/archives`, apiKey);
    },

    /** `PATCH /archives/:id`: rename or re-describe (`note: null` clears it). Returns `{archive}`. */
    async updateArchive(apiKey: string, folderId: SaltId, archiveId: SaltId, params: { name?: string; note?: string | null }): Promise<{ archive: FolderArchive }> {
      const body: Record<string, unknown> = {};
      if (params.name !== undefined) body.name = params.name;
      if (params.note !== undefined) body.note = params.note;
      return run("PATCH", `${base(folderId)}/archives/${archiveId}`, apiKey, body);
    },

    /** `DELETE /archives/:id`: removes the label only, and only while empty (409 `archive_not_empty`). Never deletes a file. */
    async deleteArchive(apiKey: string, folderId: SaltId, archiveId: SaltId): Promise<{ id: SaltId }> {
      return run("DELETE", `${base(folderId)}/archives/${archiveId}`, apiKey);
    },

    /** `PUT /files/:message_id/archive`: file one file under `archiveId` or `archive: {name, note?}` (made if new). Idempotent (`unchanged`). */
    async archiveFile(apiKey: string, folderId: SaltId, messageId: SaltId, target: ArchiveTarget): Promise<ArchiveFileResponse> {
      return run("PUT", `${base(folderId)}/files/${messageId}/archive`, apiKey, spec(target));
    },

    /** `POST /files/archive` for up to 100 files (more throws `too_many_files` before any request). Always 200 with a per-file `status` (archived, cleared, unchanged, forbidden, not_found): one refused file never blocks the rest. */
    async archiveFiles(apiKey: string, folderId: SaltId, messageIds: SaltId[], target: ArchiveTarget): Promise<ArchiveFilesResult> {
      const path = `${base(folderId)}/files/archive`;
      if (messageIds.length > ARCHIVE_FILES_MAX) {
        throw new FolderArchiveError("POST", path, 422, {
          error: `At most ${ARCHIVE_FILES_MAX} files at a time.`,
          code: "too_many_files",
          next_step: `Send ${ARCHIVE_FILES_MAX} messageIds or fewer per call and repeat.`,
        });
      }
      return run("POST", path, apiKey, { message_ids: messageIds, ...spec(target) });
    },

    /** Restore: `archiveFile` with an explicit null. The file leaves its archive; nothing is deleted. */
    async unarchiveFile(apiKey: string, folderId: SaltId, messageId: SaltId, opts?: { dryRun?: boolean }): Promise<ArchiveFileResponse> {
      return api.archiveFile(apiKey, folderId, messageId, { archiveId: null, dryRun: opts?.dryRun });
    },

    /** Restore up to 100 files: `archiveFiles` with an explicit null. */
    async unarchiveFiles(apiKey: string, folderId: SaltId, messageIds: SaltId[], opts?: { dryRun?: boolean }): Promise<ArchiveFilesResult> {
      return api.archiveFiles(apiKey, folderId, messageIds, { archiveId: null, dryRun: opts?.dryRun });
    },
  };
  return api;
}
