# steady-backend

The coach proxy for [Steady](https://github.com/jnnabugwu/steady): Vercel functions that
stream Claude Opus 5.5 replies to the iPhone app.

- Holds the Anthropic API key. The app never has it.
- Verifies Apple App Attest on every request, so only the genuine Steady app on a real
  iPhone can use it.
- Owns the coach's system prompt and guardrails, so a guardrail fix ships without App Review.
- Keeps no conversation text: logs are metadata only (status, token counts, latency).
- Caps cost per device per day, with a global daily backstop and a kill switch.

It's **stateless**: every request carries the whole conversation, and nothing about a
conversation is stored. Redis holds only one-time challenges, each attested key's public
key and counter, and daily request counts.

Design and tasks: [jnnabugwu/steady#149](https://github.com/jnnabugwu/steady/issues/149)
(tracking: [#155](https://github.com/jnnabugwu/steady/issues/155)). The app side:
[#150](https://github.com/jnnabugwu/steady/issues/150) (App Attest client) and
[#151](https://github.com/jnnabugwu/steady/issues/151) (`HostedCoachModel`).

## Contents

- [API contract](#api-contract)
- [Server-owned instructions](#server-owned-instructions)
- [Model settings](#model-settings)
- [App Attest verification](#app-attest-verification)
- [Cost caps and the kill switch](#cost-caps-and-the-kill-switch)
- [Logging](#logging)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Deploying](#deploying)
- [Tests and CI](#tests-and-ci)

## API contract

Three endpoints, all under one base URL (one per Vercel environment; the app takes it
from build config). Every response has `cache-control: no-store`.

### Flow

```text
once per install (and again after attestation_failed):
  GET  /api/attest/challenge            -> {challenge}
  DCAppAttestService.attestKey(keyId, clientDataHash = SHA-256(challenge))
  POST /api/attest/register {keyId, attestation, challenge}   -> 204

every coach reply:
  GET  /api/attest/challenge            -> {challenge}
  body = the JSON request body, as bytes
  DCAppAttestService.generateAssertion(keyId, clientDataHash = SHA-256(challenge ‖ body))
  POST /api/coach/reply  (headers: key id, assertion, challenge; body)  -> SSE stream
```

A challenge is usable **once**, for **300 seconds**. Every attempt that presents one uses
it up, whether or not it passes, so fetch a fresh challenge for every attestation, every
reply and every retry.

### Encodings

| Value | Encoding |
|---|---|
| `challenge` | 32 random bytes, **base64url without padding**: always 43 characters of `A-Z a-z 0-9 - _`. Hash it as its UTF-8 (ASCII) text, not decoded. |
| key id | The `keyId` string `DCAppAttestService.generateKey` returns: standard base64 (with padding) of the 32-byte SHA-256 of the public key. Sent as is. |
| attestation, assertion | The `Data` App Attest returns, **standard base64 with padding**. |
| attestation `clientDataHash` | `SHA-256(UTF-8(challenge))`. |
| assertion `clientDataHash` | `SHA-256(UTF-8(challenge) ‖ body)`: the 43 challenge bytes followed directly by the **exact bytes sent as the HTTP body** (no separator). Serialize the body once and send those same bytes. |

### `GET /api/attest/challenge`

`200`:

```json
{ "challenge": "q9Xm3...43 chars...", "expiresInSeconds": 300 }
```

`500 {"error": {"code": "server_error"}}` if the store is unavailable.

### `POST /api/attest/register`

Body (JSON, at most 32 KB, exactly these three fields):

```json
{
  "keyId": "<keyId from generateKey>",
  "attestation": "<base64 attestation object from attestKey>",
  "challenge": "<the challenge whose SHA-256 was the clientDataHash>"
}
```

| Status | Body | Meaning / what the app does |
|---|---|---|
| `204` | none | Key stored with counter 0. Start sending assertions. |
| `400` | `{"error": {"code": "bad_request"}}` | Malformed body. A bug: don't retry. |
| `401` | `{"error": {"code": "attestation_failed"}}` | The challenge was unknown, used or expired, or the attestation didn't verify (wrong chain, nonce, app id, environment, key id or counter). Get a new challenge and try once more; if it fails again, generate a new key. |
| `500` | `{"error": {"code": "server_error"}}` | Retry later. |

Registering a key id that's already stored replaces it (counter back to 0); a valid
attestation is proof enough.

### `POST /api/coach/reply`

#### Headers

| Header | Value |
|---|---|
| `x-steady-attest-key-id` | The key id. |
| `x-steady-attest-assertion` | The assertion, base64. |
| `x-steady-attest-challenge` | The challenge the assertion's `clientDataHash` covers. |
| `x-steady-dev-bypass` | **Debug builds on the Simulator only**, instead of the three above: the dev bypass token. Honoured only in Development and Preview; see [Dev bypass](#dev-bypass). |
| `content-type` | `application/json` (not checked). |

#### Body

JSON, UTF-8, at most **64 KB**. No other fields are allowed: in particular the app never
sends instruction or prompt text.

```jsonc
{
  "kind": "chat" | "weekly" | "summary",
  "weekContext": "<formatCoachWeek text>",   // chat and weekly: required; summary: optional, ignored
  "turns": [                                  // oldest first
    { "role": "person", "text": "..." },
    { "role": "coach",  "text": "..." },
    { "role": "app",    "topic": "logging" | "steps" | "cravings" | "nextWeek" }  // weekly only
  ]
}
```

| Limit | Value | Matches the app's |
|---|---|---|
| `weekContext` | at most **1,200** UTF-16 code units (JS/Dart `String.length`); non-blank for chat and weekly | `coachWeekContextMaxChars` |
| a person turn | **1 to 1,000** characters, counted as Unicode code points (Dart runes); not blank | `coachMaxMessageChars` |
| a coach turn | at most **4,000** code points | (backstop only) |
| turns | **1 to 100** | |
| all turn text together | at most **40,000** code points | |

Conversation rules:

- **chat / weekly**: the first turn can't be `coach`, and the **last turn must be `person`
  or `app`** (the coach replies to it; Opus 5.5 has no assistant prefill).
- **app** turns are allowed only in `weekly`. The server expands each into the weekly topic
  prompt (`src/coach/weekly.ts`) as a user turn, so the app sends `{role: "app", topic}`
  exactly where today it calls `weeklyTopicPrompt(topic)`, and the coach's reply to it is
  the next `coach` turn. The app never shows these turns, but keeps them in the turns it
  sends so the conversation is the same each request.
- A **coach** turn whose text is empty or whitespace (a reply stopped before any text) is
  dropped, not rejected.
- **summary**: the turns to summarise (the whole conversation); it may end with `coach`,
  needs at least one `person` turn, and ignores `weekContext`. The server builds the
  summary prompt itself: `CoachInstructions.summaryRequest`, then `The conversation:`, then
  `Person: …` / `Coach: …` lines (app turns left out), under the summary instructions
  (tracking habits and next week's plan; no cravings, calories, steps or weights; day counts are fine).

Consecutive turns on the same side are sent to the model as one message.

#### Response: server-sent events

`content-type: text/event-stream; charset=utf-8`. Each event is

```text
event: <name>
data: <one line of JSON>

```

| Event | Data | Meaning |
|---|---|---|
| `snapshot` | `{"text": "..."}` | **The whole reply so far**, not a delta. Show the latest; replace the previous. (Today's `CoachReplySnapshot` contract.) |
| `done` | `{"stopReason": "end_turn" \| "max_tokens"}` | The reply finished. `max_tokens`: it was cut off at the server's token limit; the app decides what to show (#152). |
| `error` | `{"code": "<code>"}`, plus `"retryAfter": <seconds>` for `rate_limited` | The reply failed. |

**Every stream ends with exactly one `done` or `error`**, and nothing follows it. A stream
that closes without one is a broken connection: treat it as `server_error`. To stop a
reply, cancel the request; the server stops the upstream call.

#### Error codes

Errors found before the reply starts come back as a stream with just the `error` event,
with the HTTP status below. Once the reply has started the status is `200` and a failure
arrives as the final `error` event. **The event is authoritative**; the status is a hint.

| `code` | HTTP (before streaming) | Meaning | What the app does (#151) |
|---|---|---|---|
| `refusal` | always `200`, mid-stream | The model's safety classifiers declined, and so did the server-side fallback model. Can arrive after `snapshot`s. | **Discard any partial text** and show `CoachCopy.helpLine`. |
| `rate_limited` | `429`, with a `retry-after` header | This device's daily limit, or the global one, is used up. `retryAfter` is seconds until the next UTC midnight. | Rate-limited failure, with `retryAfter`. |
| `attestation_failed` | `401` | Missing or bad headers; challenge unknown, used or expired; key id unknown (never registered, or expired after 180 days unused); signature, app id or counter check failed; or a bypass header where it isn't allowed. | Re-attest once (new key, new challenge, register), then retry once. If it fails again, server error. |
| `bad_request` | `400` | Body malformed, over a limit, or breaking a conversation rule. | A bug: server error, don't retry. |
| `upstream_unavailable` | `503` | Anthropic is overloaded (529), rate limiting (429), erroring (5xx) or unreachable, or the request ran past the 110 s deadline (counted from its start). | Server error ("try again shortly"). |
| `server_error` | `500` | Anything else: a store outage, a misconfiguration, an unexpected stop reason. | Server error. |
| `coach_disabled` | `503` | The kill switch is off (`COACH_ENABLED` isn't `true`). Nothing was sent to Anthropic. | Show **"The coach is off right now."** Not a transport failure; no retry loop. |

The counter in each assertion must be **strictly greater** than the last one the server
accepted for that key (App Attest increments it for you). Send one reply at a time per key:
two concurrent requests can arrive out of order, and the older counter is then rejected.

#### Example

```text
POST /api/coach/reply
x-steady-attest-key-id: 3Jc...=
x-steady-attest-assertion: omlzaWduYXR1cmVY...
x-steady-attest-challenge: q9Xm3...
content-type: application/json

{"kind":"chat","weekContext":"Days, oldest first (...)\nMon Nov 2: logged fully","turns":[{"role":"person","text":"Which days did I skip?"}]}
```

```text
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8

event: snapshot
data: {"text":"You skipped"}

event: snapshot
data: {"text":"You skipped Tuesday and had no check-in on Sunday."}

event: done
data: {"stopReason":"end_turn"}

```

### Dev bypass

App Attest isn't supported in the Simulator. A debug build there sends
`x-steady-dev-bypass: <token>` instead of the three attestation headers (no challenge
needed). The server honours it only when **all** hold:

- `VERCEL_ENV` isn't `production`, **and**
- `APP_ATTEST_ENV` isn't `production`, **and**
- `COACH_DEV_BYPASS_TOKEN` is set; the header is compared to it in constant time.

Anywhere else, a request carrying the header is rejected outright (`401
attestation_failed`), even if it also carries a valid assertion. Bypass requests share one
daily counter (`dev-bypass`).

### Vercel Deployment Protection (for #150 / #151)

Vercel puts **Preview** deployments behind Vercel Authentication by default, which answers
the app with a login page before the proxy runs. Either turn it off for Preview (Project →
Settings → Deployment Protection), or have debug builds send Vercel's
`x-vercel-protection-bypass: <Protection Bypass for Automation secret>` header as well.
Production deployments are public; App Attest is what protects them.

## Server-owned instructions

`src/coach/instructions.ts` and `src/coach/weekly.ts` hold the coach's instructions,
**word for word** from the app (`coach_domain/lib/src/coach_instructions.dart` and
`coach_weekly.dart`): `rules`, `weeklySession`, `chat`, `summary`, `summaryRequest`,
`forSession`'s layout and `weeklyTopicPrompt`, plus `CoachCopy.helpLine` for the tests.
`contextSummary` wasn't moved: it existed only for the on-device 4,096-token window. The
app's copies go away in #152.

- **System**: the kind's instructions (with a `cache_control` breakpoint), then
  `The person's data:\n<weekContext>` as a second block. Together they read as the app's
  `forSession(kind, data)`.
- **The person's text only ever goes in user turns**, never the system prompt.
- `test/instructions.test.ts` asserts every guardrail, one test per constraint, for each
  session kind (ported from the Dart test), so an edit can't silently drop one.

## Model settings

| Setting | Value | Why |
|---|---|---|
| `model` | `claude-opus-5-5` | |
| `thinking` | left out (runs adaptive) | Opus 5.5 can't disable thinking: `{type: "disabled"}` is a 400 at every effort. |
| `output_config.effort` | `low` for chat, weekly and summary | Opus 5.5 defaults to `medium`, so it's set explicitly. Measure quality, latency and cost before raising it. |
| `max_tokens` | 4,096 (chat, weekly), 2,048 (summary) | Covers thinking **and** the reply together, so it's generous; the instructions keep replies to two to five sentences. |
| `fallbacks` | `"default"`, beta `server-side-fallback-2026-07-01` | A classifier refusal is re-run server-side on the model Anthropic recommends for that refusal category. After a mid-stream fallback the text already streamed stays valid and the snapshot keeps growing. Only a refusal by the whole chain reaches the app (`refusal`). |
| `temperature`, `top_p`, `top_k` | not sent | Rejected on current models. |
| `metadata.user_id` | 12-hex-char hash of the key id | Lets Anthropic tell devices apart for abuse handling; reveals nothing about the person. |
| Client | `@anthropic-ai/sdk`, `client.beta.messages.stream`, 1 retry, 100 s timeout | |

Stop reasons: `end_turn` → `done end_turn`; `max_tokens` → `done max_tokens`; `refusal` →
`error refusal` (before any output or mid-stream). The stop reason is read from the final
message only after the stream ends.

**Prompt caching.** The instruction block carries a `cache_control` breakpoint, and chat
and weekly requests also use top-level automatic caching, so each turn reads the previous
turn's prefix. **The instruction blocks are under Opus 5.5's 512-token minimum cacheable
prefix** (chat ≈ 1,360 characters, weekly ≈ 1,770, summary ≈ 810; roughly 300 to 450
tokens), so the breakpoint on them alone caches nothing, silently. That's fine. The
automatic breakpoint covers instructions, week context and conversation, which passes 512
tokens after a turn or two. Check `cacheReadTokens` in the function logs on the second
and later turns of a session (the smoke script prints how).

**Preserved thinking.** Opus 5.5 ties thinking blocks to the model and the conversation,
and rejects a replayed block whose earlier conversation was edited. The proxy is
stateless: it sends coach turns back as **plain text, with no thinking blocks**. Per the
current docs the check applies only to thinking blocks that are replayed, so with none
sent there's nothing to validate and no 400 can come from it. The cost is that each turn
re-plans without the previous turns' reasoning; at `low` effort on short replies that's
small. The same docs say a fallback model (e.g. Claude Opus 5) can't read Opus 5.5's blocks
anyway.

## App Attest verification

`src/attest/`, following Apple's "Validating apps that connect to your server".

**Attestation** (`attestation.ts`, once per key):

1. Decode the CBOR attestation object: `fmt` must be `apple-appattest`, with
   `attStmt.x5c` (credential certificate, intermediate) and `authData`.
2. The credential certificate is issued and signed by the intermediate, and the
   intermediate by the **pinned Apple App Attestation Root CA**
   (`src/attest/apple-root.ts`, with its source URL and SHA-256 fingerprint; a test checks
   the fingerprint). Both CAs must be CAs; all three certificates in their validity period.
3. nonce = SHA-256(authData ‖ SHA-256(challenge)) must equal the credential certificate's
   extension `1.2.840.113635.100.8.2`.
4. SHA-256 of the credential public key (uncompressed P-256 point) must equal the key id.
5. authData: RP ID hash = SHA-256(`APP_ATTEST_APP_ID`); counter 0; AAGUID
   `appattest\0\0\0\0\0\0\0` when `APP_ATTEST_ENV=production`, `appattestdevelop` when
   `development` (each environment accepts only its own); credential id = key id.
6. Store the public key (SPKI DER) and counter 0, for 180 days, renewed on every assertion.

**Assertion** (`assertion.ts`, every reply): decode `{signature, authenticatorData}`;
check the RP ID hash; verify the ECDSA P-256 signature over
SHA-256(authenticatorData ‖ clientDataHash) with the stored key (`crypto.verify("sha256",
nonce, ...)`, DER signature); then atomically set the counter if it's strictly greater
(a Lua compare-and-set in Redis). The challenge is taken (GETDEL) before any of this.

**Verifier choice: small and hand-written, on Node's built-ins plus one CBOR decoder.**

- Certificates, chain and signatures: **Node's `crypto.X509Certificate`** (`checkIssued`,
  `verify`, `ca`, validity) and `crypto.verify`, which are OpenSSL underneath and ship
  with the runtime.
- CBOR: **[`cborg`](https://github.com/rvagg/cborg)** 6.2.1 (maintained, no dependencies,
  used across the IPFS ecosystem), with duplicate map keys rejected.
- The nonce extension: Node's `X509Certificate` doesn't expose extensions by OID, so
  `der.ts` has about 60 lines of strict DER reading for exactly that path (definite,
  minimal lengths, no trailing bytes).

Why not a library: the npm App Attest wrappers are small single-maintainer packages that
haven't kept up, and the whole check is about 150 lines here, every step tested.
`@peculiar/x509` was tried for reading the extension, but it needs a global
`reflect-metadata` polyfill at runtime, so it's a **dev dependency only**: the tests use
it to build a throwaway CA, intermediate and device certificates and produce real
attestations and assertions (`test/helpers/attest-fixtures.ts`). Production code takes
the trusted roots as a parameter and is always given Apple's.

What the tests can't prove is Apple's real byte layout. The first attestation from a
physical iPhone (#150) is the end-to-end check.

## Cost caps and the kill switch

- **Kill switch:** `COACH_ENABLED` must be exactly `true`. Otherwise `/api/coach/reply`
  answers `coach_disabled` (503) before reading the body or touching Redis or Anthropic.
  Change the variable and redeploy (Vercel applies env changes to new deployments) to turn
  the coach off without an app update.
- **Per device:** `COACH_DAILY_LIMIT` replies per attested key per UTC day (default 60).
- **Global:** `COACH_GLOBAL_DAILY_LIMIT` replies across all devices per UTC day (default
  1,000), a backstop so a burst of new attestations can't run past the Console spend limit.
  A device over its own limit doesn't use up the global allowance.
- Both answer `rate_limited` (429) with `retryAfter` (seconds to the next UTC midnight).
  Keep the Anthropic Console spend limit set as well.

Rough cost per reply at `low` effort: a few thousand input tokens ($4/MTok, cache reads
$0.20/MTok) and a few hundred output tokens ($20/MTok), so around 2 to 4 cents; the
4,096-token output cap bounds the worst case near 10 cents. Measure with the logged token
counts.

## Logging

One JSON line per request (`src/log.ts`), with a fixed set of fields: route, HTTP status,
latency, error code and reason (from fixed lists), `kind`, a 12-hex-char hash of the key id
(or `dev-bypass`), `stopReason`, refusal category, the serving model and whether a fallback
ran, input / output / cache-read / cache-write token counts, the time before calling
Anthropic (`preStreamMs`: body, Redis and verification) and from then to the first text
(`firstTextMs`), an
upstream error's class and status, and whether the app cancelled.

**Never logged:** request or response bodies, the week context, turns, reply text, the raw
key id, attestation or assertion bytes, challenges, the bypass token, or upstream error
messages (they can quote a request). `test/reply.test.ts` checks a request's secrets
don't appear in its log line.

Vercel's runtime logs hold what the function prints plus request metadata (method, path,
status, duration); they don't record request or response bodies. This repo configures no
log drain, and **none should be added that captures bodies**: the Vercel project doesn't
exist yet (#148), so check Project → Settings → Log Drains (and the team's) after
importing.

## Environment variables

Set in Vercel → Project → Settings → Environment Variables, per environment. `.env.example`
lists the names.

| Variable | Production | Preview | Development (`vercel dev`) |
|---|---|---|---|
| `COACH_ENABLED` | `true` | `true` | `true` |
| `ANTHROPIC_API_KEY` | the key (Sensitive) | the key, or a separate one | the key, or a separate one |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | set by the Upstash integration | same | same |
| `APP_ATTEST_APP_ID` | `UXZV3C926U.com.jmagic.steady` | same | same |
| `APP_ATTEST_ENV` | `production` | `development` | `development` |
| `COACH_DAILY_LIMIT` | e.g. `60` | e.g. `200` | e.g. `200` |
| `COACH_GLOBAL_DAILY_LIMIT` | e.g. `1000` | e.g. `300` | e.g. `300` |
| `COACH_DEV_BYPASS_TOKEN` | **unset** | a long random string | a long random string |

- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are read first if present, for a
  database created outside the Marketplace.
- `APP_ATTEST_ENV` matches the app's entitlement: debug builds (development
  `appattest-environment`) talk to Preview, TestFlight and App Store builds (production) to
  Production. Unset means `production`.
- An unusable value (`APP_ATTEST_ENV=staging`, `COACH_DAILY_LIMIT=0`) fails every request
  with `server_error` rather than guessing.
- Consider separate Upstash databases for Preview and Production, so test traffic doesn't
  share counters or keys with real devices.

## Local development

Node 22 (CI and Vercel use 22; Node 20 works locally with an engines warning).

```sh
npm ci
npm run lint && npm run typecheck && npm test

vercel link                  # once: link to the Vercel project
vercel env pull .env.local   # Development env vars into .env.local (gitignored)
vercel dev                   # http://localhost:3000

# In another terminal: a real reply through the bypass (costs a few cents).
node --env-file=.env.local --import tsx scripts/smoke.ts http://localhost:3000 chat
node --env-file=.env.local --import tsx scripts/smoke.ts http://localhost:3000 weekly
node --env-file=.env.local --import tsx scripts/smoke.ts http://localhost:3000 summary

# Against a Preview deployment (add VERCEL_AUTOMATION_BYPASS_SECRET if it's protected).
COACH_DEV_BYPASS_TOKEN=... npm run smoke -- https://<preview-url> weekly
```

The smoke script fetches a challenge (checks Redis), sends a sample request, prints each
SSE event with its timing, then the time to the first snapshot. Run it twice within 5
minutes and read `cacheReadTokens` in the function logs.

## Deploying

For Jordan, once (#148):

1. **Import the repo** in Vercel (Add New → Project → `jnnabugwu/steady-backend`).
   Framework preset: Other. Root directory: the repo root. No build command or output
   directory. Production branch: `main`. Every other branch and PR gets a Preview
   deployment.
2. **Connect Upstash**: Project → Storage (or Marketplace) → Upstash for Redis → create a
   database and connect it to the project. It sets `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` (and others this proxy doesn't use).
3. **Set the environment variables** per environment, as in the table above.
   `COACH_DEV_BYPASS_TOKEN` in Preview and Development only. Mark `ANTHROPIC_API_KEY` and
   the bypass token as Sensitive.
4. **Set `COACH_ENABLED=true`** in each environment where the coach should answer.
5. **Redeploy** (Deployments → … → Redeploy) so the variables apply.
6. Check: Settings → Functions shows Fluid compute on (see `maxDuration` below);
   Settings → Log Drains has none; Deployment Protection is set the way #150 needs for
   Preview. Run the smoke script against the Preview URL.

**`maxDuration`.** `vercel.json` gives `api/coach/reply.ts` **120 s** (10 s for the
challenge, 15 s for register). A low-effort streamed reply takes seconds; 120 s leaves room
for a long one, and the proxy's own 110 s deadline makes sure the stream still ends with an
`error` event before the platform cuts it. On the Hobby plan, 120 s needs **Fluid compute**
(the default for new projects, where Hobby allows up to 300 s). Without Fluid compute
Hobby caps functions at 60 s; then lower `maxDuration` to 60 and `REPLY_DEADLINE_MS` /
`UPSTREAM_TIMEOUT_MS` to about 50 s.

## Tests and CI

`npm test` (vitest) covers request validation, prompt assembly for each kind (the person's
text never in the system prompt), every SSE path (each stop reason, refusal before and
mid-stream, fallback, upstream errors before and mid-stream, cancel), the guardrails, the
kill switch, rate limits, attestation and assertion verification against generated
fixtures (each check failing on its own), the challenge and counter rules, and the dev
bypass being rejected in production. No test calls Anthropic or Redis: the client is a
scripted fake and the store is in memory. `UpstashStore` itself is thin and exercised by
the smoke script against a deployment.

`.github/workflows/ci.yml` runs `npm ci`, lint, typecheck and test on every push to `main`
and every PR. It has no secrets.

## Secrets

`ANTHROPIC_API_KEY` and the Upstash variables live in the Vercel project's environment
variables only. For local development, `vercel env pull .env.local`; `.env*` files (except
`.env.example`) and `.vercel/` are gitignored. Never commit a key.
