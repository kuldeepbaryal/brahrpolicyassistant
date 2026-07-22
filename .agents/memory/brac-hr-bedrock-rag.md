---
name: BRAC HR Bedrock RAG quirks
description: Citation plumbing and model routing gotchas for the Bedrock RetrieveAndGenerate setup.
---

- A custom `generationConfiguration.promptTemplate` MUST contain `$output_format_instructions$` or Bedrock returns answers with zero `citations[]`/`retrievedReferences` — answers look grounded but no sources attach. **Why:** that placeholder injects the citation-markup instructions Bedrock parses.
- Model is Claude Opus 4.6 via the account-scoped `global.` cross-region inference profile — the only Opus 4.6 route from ap-south-1 (no `apac.` profile). Foundation-model IAM needs region wildcard since global routes anywhere.
- Citation-less answers are never cached: usually session-memory replies, and caching one pins "no policy cited" for the whole TTL.
- Citation "Open" links require `CITATION_DOC_BUCKETS` (baked at Amplify build time) + `s3:GetObject` on the KB doc bucket (`brachrpolicy`); the endpoint is default-deny by bucket allowlist.
- Amplify env plumbing: only vars listed in the `grep -E` allowlist in root `amplify.yml` reach the SSR server. New runtime vars must be added there or they silently vanish.
- Prod admin access no longer depends on env vars: seed emails in code always count as admin (allowlist semantics), immune to DB demotion.
