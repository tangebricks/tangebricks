# Binary Asset Pipeline (`@poc/binary-assets`)

Workspace file uploads stored in R2 (binding `BUCKET`), with their metadata in D1 (`asset_files`), under `/api/assets`.
Every route is scoped to the caller's workspace; only an owner or admin may delete.

| Route                             | What it does                                         |
| --------------------------------- | ---------------------------------------------------- |
| `GET /api/assets`                 | Lists the workspace's assets and its total bytes.    |
| `GET /api/assets/:id`             | One asset's metadata.                                |
| `GET /api/assets/:id/download`    | The asset's bytes, always as an attachment.          |
| `POST /api/assets/upload`         | Uploads the raw request body (`?filename=` or `X-Filename`). |
| `DELETE /api/assets/:id`          | Deletes the asset (owner/admin).                     |

## Settings (story 1.14)

| Setting               | Route option          | Type                       | Default                | Range                 |
| --------------------- | --------------------- | -------------------------- | ---------------------- | --------------------- |
| `maxFileSizeBytes`    | `maxSize`             | integer                    | 10485760 (10 MiB)      | 1 KiB to 100 MiB      |
| `workspaceQuotaBytes` | `quotaBytes`          | integer                    | 1073741824 (1 GiB)     | 1 MiB to 1 TiB        |
| `allowedContentTypes` | `allowedContentTypes` | comma-separated media types | see below             | up to 512 characters  |

The default `allowedContentTypes` is `image/png, image/jpeg, image/gif, image/webp, image/avif, application/pdf,
text/plain, text/csv, application/json, application/zip, application/octet-stream, audio/mpeg, video/mp4`. Each entry
must look like `type/subtype`; the assembler checks this against the setting's pattern.

`publicBaseUrl` is a route option only (no setting): when it is set, a stored asset of a passive type gets a
`public_url` under it.

## Upload rules

1. **Size.** A `Content-Length` above `maxFileSizeBytes` is refused with `413 FILE_TOO_LARGE` before any of the body
   is read. The body is then read as a stream with a running byte count and the read stops as soon as it passes the
   limit (`413 FILE_TOO_LARGE`), so a missing or wrong `Content-Length` cannot get past it. An empty body is `400`.
2. **Quota.** An upload that would take the workspace's total `size_bytes` over `workspaceQuotaBytes` is refused with
   `413 QUOTA_EXCEEDED`. The check reads the total before writing, so it is **best-effort under concurrency**: uploads
   that run at the same time and each fit can together go over the quota, by at most one file each.
3. **Content-Type.** The media type is lowercased and its parameters (`; charset=...`) are dropped; that is what is
   stored. It must be on `allowedContentTypes`, or the upload gets `415 UNSUPPORTED_CONTENT_TYPE`.
4. **Active types.** `text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml`, `application/xml`, `text/xsl`, any `+xml`
   type and any type containing `javascript` or `ecmascript` can run script in a browser. They are not on the default
   list. If an app adds one, uploads of it are accepted but **never get a `public_url`**, are stored in R2 with
   `contentType: application/octet-stream` and `contentDisposition: attachment`, and are downloaded as
   `application/octet-stream`. Rows stored before 1.14 with an active type are read back with `public_url: null`, but their
   R2 objects keep their old inline metadata, so on a public bucket the operator should remove those objects or rewrite
   their metadata.
5. **Filename.** Only the last path segment is kept (split on `/` and `\`), control characters are dropped, anything
   outside `[A-Za-z0-9._ -]` becomes `_`, leading dots and spaces (and trailing spaces) are stripped, and the name is
   capped at 255 characters. An empty result becomes `upload.bin`. The sanitized name is stored and returned. The R2
   key is `workspaces/<workspaceId>/assets/<assetId>/<encodeURIComponent(name)>`, and the public URL encodes each key
   segment again, so it addresses exactly that object. A key over 512 characters (or a public URL over 1024) is `400`.
6. **Failures.** If saving the metadata fails, the R2 object is removed and the call answers `500 INTERNAL_ERROR` with
   a generic message and a `correlationId`; the raw error is only written to `console.error` with that id.

## Download

`GET /api/assets/:id/download` streams the object from R2 with:

- `Content-Disposition: attachment; filename="<ascii-safe>"; filename*=UTF-8''<percent-encoded>`; the ASCII form has
  quotes and backslashes removed and other non-printable or non-ASCII characters replaced with `_`.
- `X-Content-Type-Options: nosniff`.
- The stored type, or `application/octet-stream` for an active type.

## Listing

`limit` must be a whole number from 1 to 100 (default 50) and `offset` from 0 to 100000 (default 0); anything else is
`400 INVALID_PAGING`.
