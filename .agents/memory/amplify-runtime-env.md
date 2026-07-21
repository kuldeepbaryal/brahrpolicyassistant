---
name: Amplify SSR runtime env & credential debugging
description: How env vars reach (or don't reach) the Next.js SSR runtime on Amplify Hosting, and how to debug AWS credential rejections safely
---

- **Amplify console env vars exist only at BUILD time.** For a Next.js standalone SSR runtime, bake them in the build phase: `env | grep -E '^(VAR1|VAR2)=' >> <app>/.env.production` before `next build`, and copy `.env.production` into the flattened standalone dir.
- **Amplify WEB_COMPUTE Lambdas have NO ambient AWS credentials** (no AWS_ACCESS_KEY_ID/SESSION_TOKEN; default chain fails). Apps must use explicit keys from env.
- **Next 15 prerenders GET route handlers at build time** unless `export const dynamic = "force-dynamic"` — a diagnostic route without it serves a frozen build-time snapshot.
- **Debugging "UnrecognizedClientException" with seemingly-correct keys:** compare SHA-256 hash prefixes of the runtime value vs a known-good copy. A hand-pasted key in a console UI can contain a middle-character typo invisible to prefix/suffix/length checks. **Why:** this exact case burned hours — secret matched, key ID had one wrong char.
- Diagnostic routes that leak credential shapes/hashes must be stripped back to a bare liveness check once debugging is done (public + unauthenticated).
- **How to apply:** each Amplify debug iteration costs a ~4-min build; make each deployed probe maximally informative (env presence + masked shapes + hashes + default-chain test in one shot).
