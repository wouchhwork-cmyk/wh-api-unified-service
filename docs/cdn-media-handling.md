# CDN Media Handling — Capture Stage Spec

**Status:** proposed · **Scope:** the service behaviour for a single inbound **CDN media** item, from "a media URL arrives" to "the bytes are captured and a handoff object is ready for the AI stage."

This document is an implementation spec for an engineer/agent building the media-capture stage. It covers **only** what the service does when it receives a CDN media reference. The LLM/AI analysis stage (intent, transcription, reply generation) is **out of scope** — see "Handoff boundary" at the end.

---

## 1. Purpose & the one hard constraint

Incoming chat media (Instagram / Messenger) arrives as a **signed CDN URL in the webhook payload**, not as bytes. The entire design is shaped by one fact:

> **CDN URLs are perishable and single-shot.** They expire quickly (minutes; up to ~24h for stories), cannot be re-resolved, and Meta's CDN frequently returns **403 to non-browser fetchers**. Once a URL dies, the media is **permanently unrecoverable**.

Therefore the service must **capture the bytes almost immediately on receipt**, and must never depend on fetching the URL later.

Two things follow and drive every decision below:
1. The model **cannot** be handed the CDN URL (Gemini Developer API doesn't fetch external URLs; even where a URL is accepted, Meta's CDN blocks it and it expires). **The service downloads the bytes itself.**
2. Because webhooks must be acknowledged fast but the URL is perishable, **capture (urgent) and AI analysis (slower) are separated into two stages with two queues.**

---

## 2. Non-goals (explicitly out of scope)

- No LLM/AI call, prompt assembly, intent classification, transcription, or reply generation here. This stage ends when a `MediaCapture` object exists.
- No WhatsApp media-ID resolution flow (all media is CDN URL for now).
- No persistence of media **bytes** anywhere in our infrastructure (see §9).
- No reply sending or side effects toward the customer.

---

## 3. High-level flow

```
Inbound webhook (contains signed CDN media URL)
  │
  ├─ Controller: verify signature → parse → ACK 200 FAST → enqueue CAPTURE job
  │
  ├─ CAPTURE worker (HIGH priority, minimal latency — URL is perishable):
  │     1. idempotency check (skip if already captured)
  │     2. stream-download bytes from CDN  (browser-like UA, timeout, retry, size cap)
  │     3. choose destination:
  │           small + synchronous-eligible → keep in RAM (inline base64)
  │           video / large / async        → stream straight into Gemini Files API → fileUri
  │     4. build MediaCapture {payload, metadata}  (capture every field)
  │     5. persist metadata (NOT bytes) via repository
  │     6. enqueue ANALYZE job with the MediaCapture reference
  │
  └─ (ANALYZE stage = AI — separate doc, out of scope)
```

Key ordering rule: **the CAPTURE job must run near-immediately** (dedicated high-priority queue), because the CDN URL expires. Do **not** place capture on a slow/batch queue. The slower AI work runs on a separate normal-priority queue off the already-captured bytes.

---

## 4. Layering & responsibilities

Follows the project's controller → service → repository rule. Business logic lives only in services.

| Component | Responsibility |
|---|---|
| **Webhook controller** | Verify signature/`appsecret_proof`, parse payload into `InboundMediaRef[]`, ACK 200 fast, enqueue capture jobs. No download, no business logic. |
| **Media capture service** | Orchestrates: idempotency → download → destination decision → build `MediaCapture` → persist metadata → enqueue analyze. The only place capture logic lives. |
| **CDN downloader** (util/provider) | Streamed HTTP GET of a signed CDN URL with UA, timeout, capped retries, size cap. Platform-agnostic. |
| **Media staging provider** (`MediaStagingTarget`) | Interface with one concrete impl: `GeminiFilesStagingProvider` (stream bytes → Files API → `{fileUri, expiresAt}`). Swappable seam so the model provider is not hard-coupled. |
| **Media repository** | Persist/read capture **metadata** only (never bytes). Tenant-scoped. |

---

## 5. Entry contract — `InboundMediaRef`

The controller parses each inbound media attachment into this normalized shape and enqueues one capture job per item:

```ts
interface InboundMediaRef {
  tenantId: string;                  // tenant that owns this conversation
  platform: 'instagram' | 'messenger';
  conversationId: string;
  messageId: string;                 // platform message id — part of idempotency key
  attachmentIndex: number;           // position within the message (a message may carry several)
  mediaId?: string;                  // when the platform provides one
  cdnUrl: string;                    // signed, PERISHABLE — treat as single-use
  declaredType: 'image' | 'audio' | 'video' | 'file' | 'unknown';
  declaredMime?: string;             // if the payload states it
  caption?: string;
  receivedAt: string;                // ISO-8601 UTC
}
```

**Capture every field the platform gives** (caption, declared mime, sizes, timestamps, sticker/reel flags, etc.) — a field not captured on arrival usually cannot be recovered later. Add fields to this interface rather than dropping any.

---

## 6. The capture algorithm (step by step)

### 6.1 Idempotency gate (first thing in the worker)
Webhooks are at-least-once; the same media can arrive twice. Compute an idempotency key:

```
captureKey = hash(tenantId + ':' + messageId + ':' + attachmentIndex + ':' + (mediaId ?? cdnUrlHash))
```

If a `MediaCapture` already exists for `captureKey` with `status = 'captured'`, **skip** (do not re-download, re-stage, or re-enqueue). Enforce with a unique DB constraint on `captureKey` (tenant-scoped), not just an app check.

### 6.2 Download from CDN (streamed)
- **Stream** the response; never buffer a large file fully in memory.
- Set a **browser-like `User-Agent`** (and standard accept headers) — Meta's CDN 403s non-browser fetchers. UA value is config, not hardcoded.
- Apply **connect + read timeout** (config).
- **Retry** on transient failures (timeout, 5xx, connection reset) with capped exponential backoff + jitter. Do **not** retry a 403/404 many times — the URL may already be dead; fail fast to `unavailable`.
- Enforce a **hard size cap** while streaming (abort if exceeded) to bound memory and cost.
- Determine the real `mime` and `sizeBytes` from response headers/content; prefer the actual content type over the declared one, but store both.

### 6.3 Destination decision (where the bytes go)

| Condition | Destination | Payload |
|---|---|---|
| `mediaKind ∈ {image, audio}` **and** `sizeBytes ≤ INLINE_MAX_BYTES` **and** handled synchronously in this worker | **RAM buffer** | `{ kind: 'inline', base64 }` |
| `mediaKind = video`, **or** `sizeBytes > INLINE_MAX_BYTES`, **or** processing is async | **Gemini Files API** (stream CDN → Files API in one pass) | `{ kind: 'file_ref', fileUri, expiresAt }` |

**Default is the Files API path.** Because the pipeline is async (fast ack + slow AI) and URLs are perishable, staging to Files API is the safe default. The inline/RAM path is only valid if the whole capture→analyze happens synchronously and fast enough to beat URL expiry — treat it as an optimization, not the baseline.

**Never** write media bytes to local disk, an object bucket, or the database. The Files API is the short-lived staging buffer; it auto-expires (~48h) and the bytes never persist in our infra. (In-memory buffers also must not be handed across a queue — a buffer created by one instance is not available to another; this is another reason async ⇒ Files API.)

### 6.4 Per media type (all CDN)
- **Image / GIF / sticker** → treat as image. If small and synchronous: inline. Otherwise stage. (Downscaling for token cost is an AI-stage concern; do not alter bytes here beyond what's needed to stage.)
- **Audio (voice note)** → usually small; inline-eligible if synchronous, else stage.
- **Video** → **always stage to Files API**, enforce `VIDEO_MAX_BYTES` and `VIDEO_MAX_DURATION_MS`; if over limits, set `status='unavailable'`, `failureCode='MEDIA_TOO_LARGE'` and let the text path continue. (The AI stage reads both the video's picture and audio from the `fileUri` — no audio extraction is done here.)
- **file / unknown** → if mime is in the allowed list, stage; else `MEDIA_UNSUPPORTED`.

### 6.5 Build & persist
Construct the `MediaCapture` (§7), persist its **metadata** via the repository (§9), then enqueue the analyze job referencing it. The analyze job must be able to run from the persisted record alone (it holds the `fileUri` or inline reference), so it survives instance restarts and queue latency.

---

## 7. Output contract — `MediaCapture` (handoff object)

```ts
type MediaPayload =
  | { kind: 'inline';   base64: string }                       // small, synchronous path
  | { kind: 'file_ref'; fileUri: string; expiresAt: string };  // staged in Gemini Files API

interface MediaCapture {
  captureKey: string;                 // idempotency key (§6.1)
  tenantId: string;
  conversationId: string;
  messageId: string;
  attachmentIndex: number;

  mediaKind: 'image' | 'audio' | 'video' | 'document';
  mime: string;                       // actual, resolved
  sizeBytes: number;
  durationMs?: number;                // audio/video when known

  payload: MediaPayload;

  source: {                           // REFERENCE ONLY — never the bytes
    platform: 'instagram' | 'messenger';
    mediaId?: string;
    cdnUrlRef: string;                // the original URL, for audit/trace (expired by now)
    caption?: string;
  };

  capturedAt: string;                 // ISO-8601 UTC
  status: 'captured' | 'unavailable';
  failureCode?: string;               // set when status='unavailable' (see §11)
}
```

The AI stage consumes `MediaCapture` and nothing platform-specific. This is the clean seam between stages.

---

## 8. Cross-cutting requirements

- **Tenant isolation:** every download, staging call, DB read/write, and queue payload is scoped to `tenantId`. Staging/credentials use the correct tenant context. A capture for tenant A must never be reachable or overwritable by tenant B (including via a shared `captureKey` collision — scope the unique constraint by tenant).
- **Timeouts & bounded work:** all external calls (CDN GET, Files API upload) have timeouts; retries are capped with backoff + jitter; no unbounded loops.
- **Streaming:** large payloads are streamed end-to-end (CDN → Files API). Never load an unbounded file into memory.
- **Config-driven:** all limits, timeouts, UA string, allowed mime lists, and Files API settings come from centralized config (§10). No magic numbers, no hardcoded secrets.
- **Observability:** structured logs with correlation IDs (`tenantId`, `conversationId`, `messageId`, `captureKey`). Log outcomes, sizes, durations, failure codes, retry counts. **Never log the bytes, base64, caption text, or full CDN URL** (it may carry a signature/token) — log a hash or redacted form. Emit metrics: capture success/failure counts, download latency, bytes captured, staging latency, failure-code breakdown.

---

## 9. Persistence — metadata only

Persist a `media_capture` record (metadata) via the repository. **Do not store bytes, base64, or the raw file anywhere.**

Suggested columns (extend to capture every field the platform gives):

| Column | Notes |
|---|---|
| `id` (PK) | |
| `tenant_id` | indexed; all queries tenant-scoped |
| `capture_key` | **unique (tenant_id, capture_key)** — idempotency at the DB level |
| `conversation_id`, `message_id`, `attachment_index` | |
| `media_kind`, `mime`, `size_bytes`, `duration_ms` | |
| `payload_kind` (`inline`\|`file_ref`), `file_uri`, `file_uri_expires_at` | for `file_ref`; inline bytes are never stored |
| `source_platform`, `source_media_id`, `source_cdn_url_ref`, `caption` | reference/audit |
| `status`, `failure_code` | |
| `captured_at`, `created_at`, `updated_at` | all **UTC** |

Index on `(tenant_id, message_id)` and the unique `(tenant_id, capture_key)`. Follow the project's migration/expand-contract and deploy-order rules; apply the migration immediately after adding the entity.

---

## 10. Configuration keys (centralized, injected)

| Key | Purpose | Example default |
|---|---|---|
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | CDN GET connect+read timeout | 10000 |
| `MEDIA_DOWNLOAD_MAX_RETRIES` | capped retries on transient errors | 2 |
| `MEDIA_MAX_BYTES` | hard overall size cap (abort stream) | 26214400 (25 MB) |
| `MEDIA_INLINE_MAX_BYTES` | inline/RAM eligibility ceiling (keep under Gemini's 20 MB request cap incl. prompt) | 18874368 (18 MB) |
| `MEDIA_VIDEO_MAX_BYTES` | reject videos larger than this | 26214400 |
| `MEDIA_VIDEO_MAX_DURATION_MS` | reject/trim videos longer than this | 180000 |
| `MEDIA_HTTP_USER_AGENT` | browser-like UA to pass Meta CDN | (config) |
| `MEDIA_ALLOWED_MIME_*` | per-kind allowed mime lists | (config) |
| `GEMINI_FILES_API_KEY` | secret — from secret manager/env, never hardcoded | — |
| `GEMINI_FILES_API_BASE_URL` / timeouts | staging endpoint config | — |
| `MEDIA_CAPTURE_QUEUE` / `MEDIA_ANALYZE_QUEUE` | queue names | (config) |

---

## 11. Failure modes & handling

Partial failure is normal. Catch per-attachment; one bad item must not fail the whole message or crash the webhook. On any failure, write `status='unavailable'` with a `failureCode`, still persist the metadata, and let the message's text path (and the AI stage) proceed with a graceful fallback.

| Scenario | Detection | Action | `failureCode` |
|---|---|---|---|
| CDN 403 (crawler block) | HTTP 403 | retry once with browser-like UA; if still 403 → unavailable | `MEDIA_FORBIDDEN` |
| URL expired / gone | HTTP 404 / empty | no retry (can't re-resolve) → unavailable | `MEDIA_EXPIRED` |
| Download timeout | timeout | retry w/ backoff; then unavailable | `MEDIA_TIMEOUT` |
| Over size/duration cap | stream length / metadata | abort stream → unavailable | `MEDIA_TOO_LARGE` |
| Unsupported mime | mime not allowlisted | skip → unavailable | `MEDIA_UNSUPPORTED` |
| Files API upload failed | staging error | retry w/ backoff; then unavailable | `MEDIA_STAGING_FAILED` |
| Duplicate delivery | idempotency hit | skip silently (no error) | — |

---

## 12. Implementation checklist (ordered)

1. Define `InboundMediaRef`, `MediaCapture`, `MediaPayload`, `MediaStagingTarget` types/interfaces.
2. Add the `media_capture` entity + migration (unique `(tenant_id, capture_key)`, indexes, UTC timestamps). Apply the migration immediately.
3. Implement the CDN downloader: streamed GET, UA, timeout, capped retry+backoff, size-cap abort, mime/size resolution.
4. Implement `GeminiFilesStagingProvider` behind `MediaStagingTarget` (stream CDN response → Files API → `{fileUri, expiresAt}`). Keep credentials in the secret manager.
5. Implement the media capture service: idempotency gate → download → destination decision → build `MediaCapture` → persist → enqueue analyze.
6. Wire the controller: parse attachments → `InboundMediaRef[]` → fast ACK → enqueue capture jobs on the **high-priority** capture queue.
7. Add config keys (§10) to the central config/schema with safe defaults.
8. Add structured logging + metrics (§8); verify no PII/bytes/signed-URL leakage.
9. Tests (see §13).

---

## 13. Acceptance criteria & verification

- **Unit:** destination-decision matrix (inline vs file_ref) across kind/size/sync; idempotency gate returns skip on duplicate; failure matrix maps each scenario to the right `failureCode`; nothing writes bytes to disk/DB.
- **Integration:** downloader honours timeout/retry/size-cap; `GeminiFilesStagingProvider` returns a usable `fileUri`; repository enforces the unique constraint (duplicate insert rejected).
- **Negative tests:** 403, 404/expired, timeout, oversize, unsupported mime, staging failure → correct `status`/`failureCode`, message pipeline still proceeds.
- **Tenant isolation:** a capture under tenant A is not readable/writable under tenant B; `captureKey` collision across tenants does not merge records.
- **Determinism:** control time, randomness (jitter), and the downloader/staging via test doubles — no live network in unit tests.
- **Real-world verification (do NOT fabricate webhooks into the dev DB):** confirm against a **real inbound message** that (a) your backend's CDN download succeeds with the configured UA, and (b) the expiry/403 behaviour matches assumptions. Treat config as a guess until a real fetch is read back.

---

## 14. Handoff boundary (what's next, not here)

This stage ends when a `MediaCapture` with `status ∈ {captured, unavailable}` is persisted and an analyze job is enqueued. The **AI stage** (separate doc) consumes `MediaCapture`:
- reads `payload.fileUri` (or inline base64) in a Gemini call,
- produces transcript / media summary / intent / reply,
- then the bytes are discarded (Files API auto-expires; inline buffers are GC'd).

Nothing in this stage calls the model or sends a reply.
