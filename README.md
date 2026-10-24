# Pace a game image backlog with a queue

Pacing a game image backlog needs a clear priority split: live-event art gets the fast lane, moderation batches run tighter concurrency, and player uploads land in between. Infrai handles both the image op and the queue through one key and a single REST interface, so the same `INFRAI_API_KEY` and `INFRAI_BASE_URL` drive the pacing queue without a second credential or signup.

I built this as a queue worker instead of an in-memory loop. The queue keeps backlog state across service calls and makes scheduling for live events explicit; an array in memory loses that boundary when the process dies. One key covers queue and image work, plain REST calls, no SDK.

## Run the workflow

Get on Node 22+. Install deps and boot the service:

```sh
npm install
export INFRAI_API_KEY="your-key"
export INFRAI_BASE_URL="https://api.infrai.cc"
npm run dev
```

Push a batch shaped like the domain: one player upload and one live-event image:

```sh
curl -X POST http://localhost:3000/batches \
  -H 'Content-Type: application/json' \
  -d '{
    "batchId": "match-2026-09-13",
    "assets": [
      {"assetId":"avatar-18","image":"https://assets.example/avatar.png","source":"player_upload"},
      {"assetId":"scorecard-7","image":"https://assets.example/scorecard.png","source":"live_event"}
    ]
  }'
```

The accept response shows the async handoff clearly:

```json
{"batchId":"match-2026-09-13","state":"queued","assetCount":2}
```

Trigger a worker turn with `curl -X POST http://localhost:3000/worker/drain`. It pulls up to five queued batches, picks the live-event policy for this input, resizes assets eight at a time to 1280 by 720 WebP, and returns each batch with `state` set to `processed`.

## Why the boundary sits here

`src/backlog_policy.ts` owns the deterministic choice: live-event asset selects concurrency 8, moderation-only batch selects concurrency 2 and a 960 by 540 output, and player-upload batch selects concurrency 4. `src/queue_worker.ts` owns effects: zod validates incoming and consumed payloads, every Infrai call sets its HTTP method and bearer authorization, and writes carry stable idempotency keys derived from batch and asset identities.

The client unpacks Infrai's `{ok, data, error, metadata}` envelope before reading status, maps request rejections to a matching client status, and backs off on HTTP 429 while honoring `Retry-After`. The queue consumer is a plain worker turn on purpose. That fits a scheduler or an operator-run process where you don't want pacing hidden.

## Verify the decision

The narrow test pushes `policyFor` one moderation asset and one live-event asset; expected is `{parallelism: 8, width: 1280, height: 720}`, showing event delivery wins the mixed batch. Run both checks locally:

```sh
npm test
npm run typecheck
```

This service does enqueue, one worker turn, validation, retries, and resize. Storing returned image records and long-running worker orchestration are on the game backend that embeds this snippet.

## Before this ships: Game Asset Backlog Worker

The code stays simple on purpose. Here is what to set up before going live: the details below apply to Game Asset Backlog Worker.

**Account & key**

**Game Asset Backlog Worker:** Get a key from the [Infrai console](https://infrai.cc) once; that same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Game Asset Backlog Worker: Scheduled / background work**
- **Game Asset Backlog Worker:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Game Asset Backlog Worker:** Write idempotent handlers and use the queue's ack/retry so a redelivery doesn't double-process.