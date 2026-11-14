# Lessons learned: steady-backend

Problems that reached a real device, what caused them, and what to change so the next one
is caught earlier. Newest first. Each entry ends with follow-ups; tick them off here.

---

## 2026-11-14: The coach failed on every reply from the first TestFlight build

**Symptom.** TestFlight build 1.0.0 (7), the first build with the hosted coach, showed "The
coach couldn't reply just now." on the first message of every session. The app never
showed why, and nothing on the phone logged the cause.

**Impact.** No coach reply ever succeeded from a real device. The Simulator and Preview had
worked throughout, because they use the dev bypass (below).

**Fixed by.** Three PRs, merged and deployed the same day:

| PR | Production log | Cause | Fix |
|---|---|---|---|
| #6 | `attestation_failed`, `unknown_key`, two seconds after `register` returned 204 | `UpstashStore` runs with `automaticDeserialization: false`. In `@upstash/redis` 1.41.0 that also skips HGETALL's conversion of Redis's flat `[field, value, …]` reply into an object. `getKey` read `hash.publicKey` off an array, got `undefined`, and treated every registered key as unknown. | Read the flat array (`fieldsOf`). |
| #7 | `attestation_failed`, `assertion` | Not a bug: the reason covered five checks (CBOR, format, authenticator data, RP ID, signature), so the log couldn't say which failed. | Log `assertion_<check>`, from the fixed set. |
| #8 | `attestation_failed`, `assertion_auth_data` | Assertions were parsed with the WebAuthn-style `parseAuthData`. When flag 0x40 (attested credential data) is set, it expects credential data after the 37-byte header. Apple's assertions set that flag but carry only the header. | `parseAssertionAuthData` reads only the 37-byte header and ignores the flags, as `node-app-attest` does. |

Confirmed after #8: a full weekly session from the phone, eight `weekly` replies and the
`summary`, all `200`, `stopReason: end_turn`.

### How it was found

1. **What the screen said.** "The coach couldn't reply just now." is `CoachServerFailure`.
   The availability check had passed, so the build had a proxy URL and App Attest was
   supported. Every path to that failure fetches a challenge first, so the requests had to
   be reaching Vercel.
2. **Production logs, from the CLI:**
   `vercel logs --project steady-backend --environment production --since 30m --expand`.
   Each request writes one metadata-only JSON line. The sequence `unknown_key` → `register
   204` → `unknown_key` showed that registration worked and the lookup didn't.
3. **The library source.** `node_modules/@upstash/redis` showed that the option swaps every
   command's deserializer for the identity function, HGETALL's included.
4. **A specific reason in the log** (#7), then the parser that reason pointed to (#8).

### Why the tests missed all three

- **The fakes agreed with our assumptions, not with reality.** Every test used `MemoryStore`,
  which returns objects, so nothing exercised `UpstashStore` against the shape Upstash
  actually sends. The App Attest fixtures were built from our own reading of the spec. They
  always cleared flag 0x40 on assertions, so the tests confirmed the parser against
  assertions we made up, never against Apple's.
- **The dev bypass skipped the path we were shipping.** Every Preview and Simulator test
  used `x-steady-dev-bypass`, which never reads a key or parses an assertion. The App
  Attest code had passing unit tests and had never run end to end.
- **No real-device check before TestFlight.** The first time the production path ran on
  hardware was the TestFlight build, which made each round trip slow: change, deploy, retest
  on the phone.

### Lessons

1. **A fake proves your code matches your understanding, not reality.** Wherever a
   third-party system's behavior matters (Redis replies, Apple's bytes), have at least one
   test fed real output from that system:
   - a contract test for each `ProxyStore` implementation that runs the same cases against
     `MemoryStore` and `UpstashStore`;
   - golden fixtures recorded from a real device, not generated.
2. **Test the path you ship, not a convenient one.** A bypass is fine for iterating on
   prompts, but the release path needs its own end-to-end run before it reaches testers.
3. **Make every failure name its cause.** A collapsed reason (`assertion`) cost a full deploy
   and retest just to learn which check failed. Use reasons from a fixed set, so they stay
   safe to log, and make each one specific.
4. **The app should keep its own evidence.** A release build drops the failure's `cause`, so
   the phone could only say "couldn't reply". The server logs saved this one, but a failure
   before the network (App Attest on the device, say) would have left nothing to read.

### Follow-ups

- [ ] **Golden App Attest fixtures:** record one real attestation and one real assertion
  from a development-environment install (a Debug build on a physical iPhone against a
  Preview deployment) and test `verifyAttestation` and `verifyAssertion` against those exact
  bytes. These would have caught #8. Use a throwaway key, since the repo is public.
- [ ] **Store contract tests:** one suite that runs against `MemoryStore` and `UpstashStore`,
  the latter on a separate Upstash database (CI secret) or a recorded REST transcript.
  `test/upstash-store.test.ts` covers `getKey` only.
- [ ] **Pre-TestFlight check:** a Debug build on a physical iPhone, without
  `COACH_DEV_BYPASS_TOKEN`, against a Preview deployment: register, then one weekly reply.
  Add it to the release checklist.
- [ ] **App-side failure logging (steady):** a release-safe log line in `HostedCoachModel`
  with the failure type and the proxy's error code, never the conversation.
