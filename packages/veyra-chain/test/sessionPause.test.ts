import { test } from "node:test";
import assert from "node:assert/strict";
import { pauseAllSessions, type SessionRevoker, type RevocableSession } from "../src/sessionPause.js";

function makeSpyRevoker(behavior: (session: unknown) => Promise<{ status: string; transactionHash?: `0x${string}` }>): SessionRevoker & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async revokeSession(session: unknown) {
      calls.push(session);
      return behavior(session);
    },
  };
}

test("all sessions revoke successfully: every outcome reports revoked, counts and allRevoked are correct", async () => {
  const revoker = makeSpyRevoker(async () => ({ status: "CONFIRMED", transactionHash: "0xabc" as `0x${string}` }));
  const sessions: RevocableSession[] = [{ label: "session-A", session: { id: "A" } }, { label: "session-B", session: { id: "B" } }];
  const result = await pauseAllSessions(sessions, revoker);

  assert.equal(result.revokedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(result.allRevoked, true);
  assert.deepEqual(result.outcomes.map((o) => o.revoked), [true, true]);
  assert.equal(revoker.calls.length, 2);
});

test("one session's revoke throws: the rest are still attempted, and the failure is reported without aborting", async () => {
  const revoker = makeSpyRevoker(async (session) => {
    if ((session as { id: string }).id === "B") throw new Error("relay unreachable");
    return { status: "CONFIRMED", transactionHash: "0xabc" as `0x${string}` };
  });
  const sessions: RevocableSession[] = [
    { label: "session-A", session: { id: "A" } },
    { label: "session-B", session: { id: "B" } },
    { label: "session-C", session: { id: "C" } },
  ];
  const result = await pauseAllSessions(sessions, revoker);

  assert.equal(revoker.calls.length, 3, "all three must be attempted even though the second one throws");
  assert.equal(result.revokedCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.allRevoked, false);
  const failed = result.outcomes.find((o) => o.label === "session-B")!;
  assert.equal(failed.revoked, false);
  assert.equal(failed.error, "relay unreachable");
  assert.equal(failed.transactionHash, null);
});

test("every session that DID succeed is still reported correctly even when a later one fails", async () => {
  const revoker = makeSpyRevoker(async (session) => {
    if ((session as { id: string }).id === "A") throw new Error("expired");
    return { status: "CONFIRMED", transactionHash: "0xdef" as `0x${string}` };
  });
  const sessions: RevocableSession[] = [{ label: "session-A", session: { id: "A" } }, { label: "session-B", session: { id: "B" } }];
  const result = await pauseAllSessions(sessions, revoker);

  const ok = result.outcomes.find((o) => o.label === "session-B")!;
  assert.equal(ok.revoked, true);
  assert.equal(ok.transactionHash, "0xdef");
});

test("an empty list is a trivial success -- no sessions, nothing failed", async () => {
  const revoker = makeSpyRevoker(async () => ({ status: "CONFIRMED" }));
  const result = await pauseAllSessions([], revoker);
  assert.equal(result.allRevoked, true);
  assert.equal(result.revokedCount, 0);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.outcomes, []);
});

test("outcome order matches input order, for a legible audit trail", async () => {
  const revoker = makeSpyRevoker(async () => ({ status: "CONFIRMED" }));
  const sessions: RevocableSession[] = [{ label: "first", session: 1 }, { label: "second", session: 2 }, { label: "third", session: 3 }];
  const result = await pauseAllSessions(sessions, revoker);
  assert.deepEqual(result.outcomes.map((o) => o.label), ["first", "second", "third"]);
});

test("the exact session object is passed through to the revoker, unmodified -- no re-derivation, no mutation", async () => {
  const originalSession = { id: "X", nested: { value: 42 } };
  const revoker = makeSpyRevoker(async () => ({ status: "CONFIRMED" }));
  await pauseAllSessions([{ label: "x", session: originalSession }], revoker);
  assert.equal(revoker.calls[0], originalSession, "must be the exact same object reference, not a copy");
});
