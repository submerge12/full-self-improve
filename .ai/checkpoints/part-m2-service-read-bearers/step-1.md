# Step 1 - M2 service read bearers

Worker: D
Date: 2026-06-14

## Scope

- Added service-specific bearer handling for agent-day live read requests.
- Kept `KL_AGENT_READ_BEARER_TOKEN` as the fallback read bearer.
- Kept Multica board writes on `KL_MULTICA_BEARER_TOKEN`.
- Did not touch `docs/AUDIT-MANUAL.md`.

## TDD evidence

RED:

- `npm run test:unit -- src/agents/http-clients.test.ts src/cli/kl.test.ts`
- Failed as expected because all read endpoints still used the legacy fallback read bearer.

GREEN:

- `npm run test:unit -- src/agents/http-clients.test.ts src/cli/kl.test.ts`
- Result: 2 files passed, 103 tests passed.

## Tactical decisions

- The HTTP read client stays service-agnostic and accepts `bearerTokensByOrigin`.
- CLI maps generated agent-day read endpoint origins to service env vars:
  - non-nutritionist read phases use `KL_AGENT_KNOWLEDGE_LOOP_BEARER_TOKEN`.
  - nutritionist read phases use `KL_AGENT_COMPASS_HEALTH_BEARER_TOKEN`.
- Empty or missing service bearer env vars use `KL_AGENT_READ_BEARER_TOKEN` when present; otherwise the origin is recorded as explicitly no-token so same-origin token/no-token conflicts fail closed.
- Error redaction now includes the fallback read bearer and any per-origin read bearers configured for the client.

## Remaining notes

- If two services are intentionally configured to share the same origin while using different service bearer env vars, origin-based authentication cannot distinguish them. The CLI now fails closed before any fetch when such a conflicting same-origin mapping is detected.

## Review Fix

- Quality review found that same-origin Knowledge-Loop and compass-health URLs with different service bearer env vars could silently overwrite one another.
- RED: `npm run test:unit -- src/cli/kl.test.ts` failed before the fix because the command continued instead of rejecting the conflict.
- GREEN: `npm run test:unit -- src/agents/http-clients.test.ts src/cli/kl.test.ts` passed, 104 tests, after adding same-origin conflict detection and secret-free error assertions.
- Re-review found the same-origin conflict also had to compare service-specific tokens against the legacy fallback token when one service token is unset.
- RED: `npm run test:unit -- src/cli/kl.test.ts` failed before the fallback-aware fix because the command continued with a same-origin service/fallback mismatch.
- GREEN: `npm run test:unit -- src/agents/http-clients.test.ts src/cli/kl.test.ts` passed, 105 tests, after comparing effective per-endpoint tokens.
- Final re-review found the same-origin conflict also had to compare a service-specific token against an explicit no-token service when no legacy fallback is configured.
- RED: `npm run test:unit -- src/agents/http-clients.test.ts src/cli/kl.test.ts` failed before the no-token fix because the HTTP read client applied fallback to an explicit no-token origin and the CLI continued with a token/no-token same-origin mismatch.
- GREEN: `npm run test:unit -- src/agents/http-clients.test.ts src/cli/kl.test.ts` passed, 107 tests, after distinguishing missing origin mappings from explicit no-token mappings.
