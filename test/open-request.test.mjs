import { test } from "node:test";
import assert from "node:assert/strict";
import * as relay from "../mods/prompt-jump/relay.js";

const now = 1_000_000;
const request = { terminal: "t7", n: "request-1" };

test("an unseen request wakes a never-started panel and survives that panel's initialization", () => {
  const forwarded = relay.forwardOpenRequest(request, null, null, 10_000, now);
  assert.equal(forwarded.wake, true);
  assert.equal(relay.initialOpenNonce(forwarded, now), null);
});

test("the relay does not replay a seen request or wake an already-running panel", () => {
  assert.equal(relay.forwardOpenRequest(request, request.n, null, 10_000, now), null);
  const running = relay.forwardOpenRequest(request, null, { at: now }, 10_000, now);
  assert.equal(running.wake, false);
  assert.equal(relay.initialOpenNonce(running, now), request.n);
});

test("a cold-open wake is accepted until the last millisecond but never at expiry or after clock rollback", () => {
  const wake = relay.forwardOpenRequest(request, null, null, 10_000, now);
  assert.equal(relay.initialOpenNonce(wake, now + relay.WAKE_MS - 1), null);
  assert.equal(relay.initialOpenNonce(wake, now + relay.WAKE_MS), request.n);
  assert.equal(relay.initialOpenNonce(wake, now - 1), request.n);
});

test("historical and already-consumed requests are not replayed by a new copy", () => {
  assert.equal(relay.initialOpenNonce(request, now), request.n);
  const wake = relay.forwardOpenRequest(request, null, null, 10_000, now);
  assert.equal(relay.initialOpenNonce({ ...wake, wake: false }, now), request.n);
  assert.equal(relay.initialOpenNonce(null, now), null);
});
