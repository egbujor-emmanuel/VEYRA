import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSessionLifetime, DEFAULT_SESSION_LIFETIME_POLICY } from "../src/index.js";

test("a session requested well within the lifetime cap is authorized", () => {
  const result = validateSessionLifetime({ policy: DEFAULT_SESSION_LIFETIME_POLICY, requestedExpiry: 1_000_300, nowUnixSeconds: 1_000_000 });
  assert.equal(result.authorized, true);
  assert.equal(result.requestedLifetimeSeconds, 300);
});

test("a session requested at exactly the lifetime cap is authorized (boundary is inclusive)", () => {
  const result = validateSessionLifetime({ policy: DEFAULT_SESSION_LIFETIME_POLICY, requestedExpiry: 1_000_600, nowUnixSeconds: 1_000_000 });
  assert.equal(result.authorized, true);
});

test("a session requested beyond the lifetime cap is refused with an explicit reason", () => {
  const result = validateSessionLifetime({ policy: DEFAULT_SESSION_LIFETIME_POLICY, requestedExpiry: 1_002_000, nowUnixSeconds: 1_000_000 });
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("maxSessionLifetimeSeconds")));
});

test("an expiry already in the past (or exactly now) is refused outright", () => {
  const result = validateSessionLifetime({ policy: DEFAULT_SESSION_LIFETIME_POLICY, requestedExpiry: 999_000, nowUnixSeconds: 1_000_000 });
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("not in the future")));
});

test("a custom, tighter policy is honored, not just the default", () => {
  const result = validateSessionLifetime({ policy: { maxSessionLifetimeSeconds: 60 }, requestedExpiry: 1_000_120, nowUnixSeconds: 1_000_000 });
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("60s")));
});
