---
name: Amplify monorepo Next.js deploy
description: Hard-won rules for deploying a pnpm-workspace Next.js app to AWS Amplify WEB_COMPUTE
---

Rules learned across many failed Amplify builds:

- **CWD is inherited between amplify.yml phases.** If preBuild ends with `cd ../../`, the build phase starts at repo root — do NOT `cd ../../` again or you go above the repo. `$CODEBUILD_SRC_DIR` is also unreliable (points to the `/src` parent, not repo root).
- **Amplify's runtime check requires a real `node_modules/next` directory in the build artifact.** pnpm's default isolated linker only produces symlinks into `.pnpm`, which fail this check. Fix: `node-linker=hoisted` in the repo `.npmrc` (npm-style real dirs).
- **In a monorepo, `output: "standalone"` nests the app** under `.next/standalone/<path-from-repo-root>/` (e.g. `.next/standalone/artifacts/brac-hr/`). Flatten it after build (move nested `.next` + `server.js` to standalone root, copy `public`, `.next/static`, `required-server-files.json`), then use `baseDirectory: .next` so Amplify auto-detects the classic single-repo standalone layout.
- **Why:** each Amplify build costs ~5 min and requires the user to manually upload logs — always smoke-test the standalone output locally (`PORT=x node .next/standalone/server.js`) before pushing.
- **Local dev gotcha:** running a production `next build` in the workspace pollutes `.next` and breaks the running dev server (missing chunk errors). `rm -rf .next` and restart the workflow after local prod builds.
- **gitPush can race:** verify with `git fetch && git log origin/main` that the fix commit actually reached GitHub before expecting Amplify to build it.
- Broken pnpm lockfile entries (merge-conflict remnants) block hoisted installs; fix by deleting `pnpm-lock.yaml` and reinstalling in one shell command (a background process can restore deleted files between commands).
