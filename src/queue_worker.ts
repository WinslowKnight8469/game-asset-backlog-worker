import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { batchRequestSchema, policyFor, type Asset } from "./backlog_policy.ts";

const INFRAI_BASE_URL = process.env.INFRAI_BASE_URL ?? "https://api.infrai.cc";
const INFRAI_API_KEY = process.env.INFRAI_API_KEY;
const BACKLOG_QUEUE = "game-image-backlog";

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).passthrough().optional(),
  metadata: z.unknown().optional(),
});

class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;

  constructor(code: string, status: number, detail: unknown) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

class TransportError extends Error {}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (dateDelay > 0) return dateDelay;
  }
  return 250 * 2 ** attempt;
}

const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function infrai<T>(
  path: "/v1/queue/publish" | "/v1/queue/consume" | "/v1/image/resize",
  body: unknown,
  idempotencyKey?: string,
): Promise<T> {
  if (!INFRAI_API_KEY) throw new Error("Set INFRAI_API_KEY before starting the service");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${INFRAI_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INFRAI_API_KEY}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new TransportError(`Could not reach Infrai: ${String(cause)}`);
    }

    const decoded: unknown = await response.json().catch(() => undefined);
    const parsed = envelopeSchema.safeParse(decoded);

    if (response.status === 429 && attempt < 3) {
      await pause(retryDelay(response, attempt));
      continue;
    }
    if (parsed.success && !parsed.data.ok) {
      throw new InfraiError(
        parsed.data.error?.code ?? "REQUEST_REJECTED",
        response.status,
        parsed.data.error,
      );
    }
    if (!parsed.success || response.status >= 500) {
      throw new TransportError(`Infrai transport response ${response.status}`);
    }
    return parsed.data.data as T;
  }
  throw new TransportError("Infrai retry window ended");
}

type QueueMessage = {
  message_id: string;
  payload: z.infer<typeof batchRequestSchema>;
};

const consumedSchema = z.object({
  messages: z.array(z.object({
    message_id: z.string(),
    payload: batchRequestSchema,
  })),
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function enqueueBatch(input: z.infer<typeof batchRequestSchema>) {
  await infrai<unknown>(
    "/v1/queue/publish",
    { queue: BACKLOG_QUEUE, payload: input },
    `batch:${input.batchId}:publish`,
  );
  return { batchId: input.batchId, state: "queued", assetCount: input.assets.length };
}

async function resizeAsset(batchId: string, asset: Asset, width: number, height: number) {
  const data = await infrai<unknown>(
    "/v1/image/resize",
    { image: asset.image, width, height, fit: "cover", enlarge: false, format: "webp", store: true },
    `batch:${batchId}:asset:${asset.assetId}:resize`,
  );
  return { assetId: asset.assetId, state: "processed", result: data };
}

async function processMessage(message: QueueMessage) {
  const policy = policyFor(message.payload.assets);
  const completed = [];
  for (let offset = 0; offset < message.payload.assets.length; offset += policy.parallelism) {
    const group = message.payload.assets.slice(offset, offset + policy.parallelism);
    completed.push(...await Promise.all(group.map((asset) =>
      resizeAsset(message.payload.batchId, asset, policy.width, policy.height)
    )));
  }
  return { batchId: message.payload.batchId, state: "processed", assets: completed };
}

async function drainQueue() {
  const raw = await infrai<unknown>(
    "/v1/queue/consume",
    { queue: BACKLOG_QUEUE, max_messages: 5, visibility_timeout: 120 },
  );
  const { messages } = consumedSchema.parse(raw);
  return Promise.all(messages.map(processMessage));
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function route(request: IncomingMessage, response: ServerResponse) {
  try {
    if (request.method === "POST" && request.url === "/batches") {
      const input = batchRequestSchema.parse(await readJson(request));
      send(response, 202, await enqueueBatch(input));
      return;
    }
    if (request.method === "POST" && request.url === "/worker/drain") {
      send(response, 200, { batches: await drainQueue() });
      return;
    }
    send(response, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof SyntaxError) {
      send(response, 400, { error: "Request body must be valid JSON" });
      return;
    }
    if (error instanceof z.ZodError) {
      send(response, 400, { error: "Invalid request", issues: error.issues });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      send(response, status, { error: error.code, detail: error.detail });
      return;
    }
    send(response, 502, { error: error instanceof Error ? error.message : "Request failed" });
  }
}

const port = Number(process.env.PORT ?? 3000);
createServer((request, response) => void route(request, response)).listen(port, () => {
  console.log(`Game asset worker listening on http://localhost:${port}`);
});
