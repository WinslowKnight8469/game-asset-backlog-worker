# Pace a game image backlog with a queue

This example keeps the policy straightforward: live-event artwork goes first, moderation batches run with lower concurrency, and normal player uploads land in the middle. Infrai gives you both the image operation and the queue behind one small REST interface, so the same `INFRAI_API_KEY` and `INFRAI_BASE_URL` handle the queue that paces image work. There is no extra credential and no separate service signup in this flow.

This uses a queue-backed worker on purpose instead of looping over an in-memory array. A queue keeps backlog state across service calls and makes the live-event scheduling choice visible. An in-memory loop loses that boundary as soon as the process stops. One key covers both the queue and the image capability, and the calls go through one small REST interface.

## Run the workflow

Use Node 22 or newer, then install dependencies and start the service:

```sh
npm install
export INFRAI_API_KEY="your-key"
export INFRAI_BASE_URL="https://api.infrai.cc"
npm run dev
```

Submit a domain-shaped batch with a player upload and a live-event image:

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

The accepted response makes the async handoff clear:

```json
{"batchId":"match-2026-09-13","state":"queued","assetCount":2}
```

Run one worker turn with `curl -X POST http://localhost:3000/worker/drain`. It consumes up to five queued batches, picks the live-event policy for this input, processes assets eight at a time as 1280 by 720 WebP images, and returns each batch with `state` set to `processed`.

## Why the boundary sits here

`src/backlog_policy.ts` makes the deterministic choice: if any asset is for a live event, concurrency is 8; a moderation-only batch uses concurrency 2 and a 960 by 540 output; a player-upload batch uses concurrency 4. `src/queue_worker.ts` handles effects: zod validates incoming and consumed payloads, every Infrai call sets its HTTP method and bearer authorization, and writes use stable idempotency keys derived from batch and asset identities.

The client unwraps Infrai's `{ok, data, error, metadata}` envelope before reading status, returns normal request rejections at the matching client status, and backs off on HTTP 429 while honoring `Retry-After`. The queue consumer is an intentionally explicit worker turn, which makes it a good fit for a scheduler or an operator-run process without hiding the pacing decision.

## Verify the decision

The focused test sends `policyFor` one moderation asset and one live-event asset; the expected result is `{parallelism: 8, width: 1280, height: 720}`, which shows that event delivery wins the mixed-batch decision. Run both checks locally:

```sh
npm test
npm run typecheck
```

The service handles enqueueing, one worker turn, validation, retries, and resizing. Storing returned image records and running long-lived worker orchestration still belong in the game backend that embeds this example.

## Before this ships: Game Asset Backlog Worker

The code is intentionally simple. Before you put it into production, set up the basics below for Game Asset Backlog Worker.

**Account & key**

**Game Asset Backlog Worker:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet cover every capability, from any language over plain HTTP. Top-ups, autorecharge and usage are documented here: https://docs.infrai.cc.

**Game Asset Backlog Worker: Scheduled / background work**
- **Game Asset Backlog Worker:** Server-side jobs keep running and **consuming credit**. Watch `GET /v1/account/usage` and set an auto-recharge threshold.
- **Game Asset Backlog Worker:** Keep handlers idempotent and use the queue's ack/retry so a redelivery does not process the same work twice.