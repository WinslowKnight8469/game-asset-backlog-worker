import { z } from "zod";

export const assetSchema = z.object({
  assetId: z.string().min(1),
  image: z.string().url(),
  source: z.enum(["player_upload", "live_event", "moderation_queue"]),
});

export const batchRequestSchema = z.object({
  batchId: z.string().min(1),
  assets: z.array(assetSchema).min(1).max(100),
});

export type Asset = z.infer<typeof assetSchema>;

export type BatchPolicy = {
  parallelism: number;
  width: number;
  height: number;
};

export function policyFor(assets: Asset[]): BatchPolicy {
  if (assets.some((asset) => asset.source === "live_event")) {
    return { parallelism: 8, width: 1280, height: 720 };
  }
  if (assets.some((asset) => asset.source === "moderation_queue")) {
    return { parallelism: 2, width: 960, height: 540 };
  }
  return { parallelism: 4, width: 1280, height: 720 };
}
