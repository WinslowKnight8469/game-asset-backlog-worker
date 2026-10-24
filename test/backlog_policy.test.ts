import assert from "node:assert/strict";
import test from "node:test";
import { policyFor } from "../src/backlog_policy.ts";

test("a live event batch gets the fast lane even when moderation assets are present", () => {
  const policy = policyFor([
    { assetId: "report-41", image: "https://assets.example/report.png", source: "moderation_queue" },
    { assetId: "final-7", image: "https://assets.example/final.png", source: "live_event" },
  ]);

  assert.deepEqual(policy, { parallelism: 8, width: 1280, height: 720 });
});

test("a moderation-only batch uses bounded concurrency", () => {
  const policy = policyFor([
    { assetId: "report-42", image: "https://assets.example/review.png", source: "moderation_queue" },
  ]);

  assert.deepEqual(policy, { parallelism: 2, width: 960, height: 540 });
});
