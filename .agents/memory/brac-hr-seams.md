---
name: BRAC HR module seams
description: Architecture convention — deep modules behind narrow interfaces, routes are thin adapters
---
The codebase was refactored around deep modules with thin HTTP routes:
- Storage: `Db` split into `UserStore`/`ChatStore`/`InsightsStore`; all provider failures become `StorageError` codes (`permission_denied|not_provisioned|conflict|unavailable`) at the client seam — callers never see DynamoDB vocabulary.
- Roles, insights aggregation, and chat orchestration each live in a `src/lib/*.ts` module with injected deps (store, knowledge-base port, sleep/now/newId) and vitest coverage at the module interface; routes only translate HTTP/SSE.

**Why:** the routes used to BE the implementation, leaving no test surface; behavior-preserving extraction plus dependency injection made rate limiting, caching, no-result flagging, and stats recording testable without AWS.

**How to apply:** new server features should follow the same shape — put orchestration in `src/lib/`, inject external dependencies as ports (Bedrock is `KnowledgeBasePort` in `chat.ts`), keep routes as thin adapters, and test with `MemoryDb` + mock ports. Never sort/mutate arrays returned by injected stores; copy first.
