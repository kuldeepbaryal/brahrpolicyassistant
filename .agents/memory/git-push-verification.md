---
name: Verify pushes actually landed
description: gitPush can report success while the remote branch stays behind; always verify with git fetch when the push matters.
---
The `gitPush` callback once returned `{"success":true,"message":"Pushed to main"}` while `origin/main` remained at the old commit (July 2026, BRAC HR repo). The prod deploy pipeline (Amplify auto-deploy on push) silently rebuilt the old code, making a hotfix appear ineffective.

**Why:** a "successful" push result is not proof the commits landed; a stale/failed push wastes a whole debugging round-trip when deploys hang off the remote.

**How to apply:** after any push that triggers a deployment or that a fix depends on, run `git fetch origin && git log --oneline -1 origin/main` and confirm the expected commit is at the tip before telling the user a rebuild is underway.
