// Salt 0.265.0 folder archives, agent side: client.folders.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}
function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] }, json: async () => body, text: async () => JSON.stringify(body) };
}
const make = (respond) => {
  const fetchImpl = recordingFetch(respond);
  return { fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
};
const ok = (body = {}) => () => jsonResponse(200, body);

test("listFiles filters and listArchives paths", async () => {
  const { fetchImpl, client } = make(ok({ folder: {}, files: [], archives: [] }));
  await client.folders.listFiles("k", "f1", { archived: true, archiveId: "a1", limit: 20, before: "m5" });
  await client.folders.listFiles("k", "f1", { archived: "false" });
  await client.folders.listFiles("k", "f1");
  await client.folders.listArchives("k", "f1");
  const u = fetchImpl.calls.map((c) => c.url.replace("https://salt.test", ""));
  assert.equal(u[0], "/api/v1/folders/f1/files?before=m5&limit=20&archived=true&archive_id=a1");
  assert.equal(u[1], "/api/v1/folders/f1/files?archived=false");
  assert.equal(u[2], "/api/v1/folders/f1/files");
  assert.equal(u[3], "/api/v1/folders/f1/archives");
});

test("archiveFile files by name or id, with dry_run; PUT to the file's archive", async () => {
  const { fetchImpl, client } = make(ok({ folder_id: "f1", dry_run: true, archive: { id: "a1", name: "2026", note: null, created: false }, file: { message_id: "m1", status: "archived", archive_id: "a1" } }));
  const r = await client.folders.archiveFile("k", "f1", "m1", { archive: { name: "2026", note: "Old invoices" }, dryRun: true });
  assert.equal(r.file.status, "archived");
  assert.equal(fetchImpl.calls[0].method, "PUT");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/folders\/f1\/files\/m1\/archive$/);
  assert.deepStrictEqual(fetchImpl.calls[0].body, { archive: { name: "2026", note: "Old invoices" }, dry_run: true });
  await client.folders.archiveFile("k", "f1", "m1", { archiveId: "a1" });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { archive_id: "a1" });
});

test("restore sends an explicit null; leaving both out sends nothing, so the server says archive_required", async () => {
  const { fetchImpl, client } = make((u, o, i) => (i < 2 ? jsonResponse(200, { folder_id: "f1", file: { message_id: "m1", status: "cleared", archive_id: null } }) : jsonResponse(422, { error: "Say where.", code: "archive_required", next_step: "Send archive_id, archive, or null." })));
  const r = await client.folders.unarchiveFile("k", "f1", "m1");
  assert.equal(r.file.status, "cleared");
  assert.deepStrictEqual(fetchImpl.calls[0].body, { archive_id: null });
  await client.folders.unarchiveFile("k", "f1", "m1", { dryRun: true });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { archive_id: null, dry_run: true });
  await assert.rejects(client.folders.archiveFile("k", "f1", "m1", {}), (e) => e instanceof sdk.FolderArchiveError && e.code === "archive_required" && /null/.test(e.nextStep));
  assert.deepStrictEqual(fetchImpl.calls[2].body, {}, "no key sent when none given");
});

test("archiveFiles posts message_ids with the spec; unarchiveFiles uses null; over 100 is refused before any request", async () => {
  const { fetchImpl, client } = make(ok({ folder_id: "f1", counts: { archived: 2 }, files: [] }));
  const ids = ["a", "b"];
  await client.folders.archiveFiles("k", "f1", ids, { archive: { name: "X" } });
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/folders\/f1\/files\/archive$/);
  assert.deepStrictEqual(fetchImpl.calls[0].body, { message_ids: ids, archive: { name: "X" } });
  await client.folders.unarchiveFiles("k", "f1", ids, { dryRun: true });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { message_ids: ids, archive_id: null, dry_run: true });
  const many = Array.from({ length: 101 }, (_, i) => String(i));
  await assert.rejects(client.folders.archiveFiles("k", "f1", many, { archiveId: "a" }), (e) => e instanceof sdk.FolderArchiveError && e.code === "too_many_files" && e.status === 422 && /100/.test(e.nextStep));
  await client.folders.archiveFiles("k", "f1", many.slice(0, 100), { archiveId: "a" });
  assert.equal(fetchImpl.calls.length, 3);
});

test("a mixed batch is data: per-file statuses come back on a 200", async () => {
  const files = [{ message_id: "a", status: "archived", archive_id: "a1" }, { message_id: "b", status: "forbidden", code: "archive_forbidden", error: "Not yours.", next_step: "Ask the author." }, { message_id: "c", status: "not_found", code: "file_not_found" }];
  const { client } = make(ok({ folder_id: "f1", counts: { archived: 1, forbidden: 1, not_found: 1 }, files }));
  const r = await client.folders.archiveFiles("k", "f1", ["a", "b", "c"], { archiveId: "a1" });
  assert.deepStrictEqual(r.files.map((f) => f.status), ["archived", "forbidden", "not_found"]);
});

test("updateArchive and deleteArchive; archive_not_empty is a typed 409 with the next step", async () => {
  const { fetchImpl, client } = make((u, o) => (o.method === "DELETE" ? jsonResponse(409, { error: "Not empty.", code: "archive_not_empty", next_step: "POST files/archive with archive_id null for its files." }) : jsonResponse(200, { archive: { id: "a1", name: "New", note: null } })));
  await client.folders.updateArchive("k", "f1", "a1", { name: "New", note: null });
  assert.equal(fetchImpl.calls[0].method, "PATCH");
  assert.deepStrictEqual(fetchImpl.calls[0].body, { name: "New", note: null });
  await assert.rejects(client.folders.deleteArchive("k", "f1", "a1"), (e) => e instanceof sdk.FolderArchiveError && e.code === "archive_not_empty" && e.status === 409 && /archive_id null/.test(e.nextStep));
});

test("other errors stay plain SaltApiError; every archive code is typed", async () => {
  const plain = make(() => jsonResponse(404, { error: "Not found." }));
  await assert.rejects(plain.client.folders.listArchives("k", "f1"), (e) => e instanceof sdk.SaltApiError && !(e instanceof sdk.FolderArchiveError));
  for (const code of sdk.FOLDER_ARCHIVE_CODES) {
    const { client } = make(() => jsonResponse(422, { error: `s ${code}`, code, next_step: "n" }));
    await assert.rejects(client.folders.listArchives("k", "f1"), (e) => e instanceof sdk.FolderArchiveError && e.code === code && e.sentence === `s ${code}`);
  }
  assert.equal(sdk.FOLDER_ARCHIVE_CODES.length, 11);
});
