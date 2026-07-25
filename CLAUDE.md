# PaneForge

Electron app that hosts coding agents in panes. It hosts the chat you are reading this
in, which shapes every rule below.

## Never close the app you are running inside

`PaneForge.exe` under `AppData\Local\Programs\claude-orchestrator` is the live app and
killing it ends this session mid-turn. To see a change, open a **second** copy:

```
npm run try -- --minimized      # builds, opens as its own profile, never takes focus
```

Profiles (`src/main/profile.ts`) give that copy its own userData, single-instance lock,
config and taskbar button, so the live app is untouched. The profile name comes from the
folder name, so each checkout opens its own window.

## Lanes: more than one chat works on this repo

Chats get started from other projects ("add X to PaneForge" from one, "fix Y" from
another) and would otherwise share this checkout: two builds writing one `out/`, two
version bumps, two releases minutes apart.

A hook assigns each session a lane automatically - `main` (this folder, master) or a
worktree `claude-orchestrator-a` / `-b` on `lane-a` / `lane-b`. Work only in the lane you
were given; writing into another chat's checkout is refused by a PreToolUse hook, not by
convention. `node scripts/lane.mjs status` shows who holds what.

## Releasing is batched, never per-chat

```
node scripts/lane.mjs ready --session <id>   # this lane's work is done and verified
npm run ship                                 # merges every ready lane into ONE version
```

`npm version`, `git tag vX`, and pushing a version tag by hand are blocked. A second chat
that ships while a release is running is told its work is already included and stops -
that is deliberate, do not retry it.

## Checks

`npm run typecheck` before committing. `npm run smoke` exercises the pty layer.
