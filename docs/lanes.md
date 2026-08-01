# Lanes

Two agents editing one folder is the setup that reliably breaks. They overwrite each
other's edits, race the same git index, fight over the dev server port, and two `npm run
build` runs write the same `out/` - so the second app to launch is half-written, with no
error anywhere.

A **lane** is one checkout of a project, used by one session.

That is the whole idea. Everything below is the bookkeeping that makes it need no
attention.

## The names

A project has its own folder, and its lanes sit beside it:

```
Projects/
  Toolstash          the project itself, on its own branch (main or master)
  Toolstash-a        lane a, on branch lane-a
  Toolstash-b        lane b, on branch lane-b
  Toolstash-c        lane c, on branch lane-c
```

The project's own folder is called `main`. Lanes are lettered `a` to `h`.

That is one scheme, used by both halves of the system - the app window when it opens a
second pane on a project, and `scripts/lane.mjs` when it hands a lane to a chat. So a pane
sitting in `Toolstash-b` and a chat holding lane b are **the same lane**, not two things
that happen to be near each other.

Lanes are lettered on purpose: a pane already carries a number (its `Ctrl+N` switch key),
and two numbers on one card with nothing to say which is which is exactly the confusion
this replaced.

<details>
<summary>You may still see a folder called <code>&lt;project&gt;-w2</code></summary>

Before 2026-08-02 the app named its lanes `<project>-w2` on branch `pf/w2` while the script
named its own `<project>-a` on `lane-a`. Same thing, two vocabularies - and the numbering
skipped `w1`, because the project's own folder was #1.

Old lanes still work: they are read, merged and swept exactly as before. They are simply
never created again, so they disappear as their work lands. `lane.mjs doctor` names any
that are left.

</details>

## How work gets back

Nobody merges a lane by hand and nobody types a release command.

1. A chat works in its lane and commits there.
2. When it is finished - or when its session ends - the lane is marked **ready**.
3. Ready lanes are merged into the project's branch in **one batch**, behind a lock, and
   the result is released once.

Batching is the point. Without it every finished piece of work cut its own version: 15
releases in one day, on 2026-07-26. Work is never lost by waiting - it sits on the branch
and goes out with the next release, which every later finish triggers.

What "released" means is the repo's own decision, declared in its `.lanes.json`:

| `release` | what finishing a lane does |
|---|---|
| `"version"` | bumps the version, tags, pushes, publishes installers |
| `"merge"` | merges into the branch and pushes. No version is cut. **The default everywhere except PaneForge.** |
| `"none"` | merges locally and stops |

A repo that wants no lanes at all says `{"lanes": false}`. A repo that wants a different
number of them says `{"pool": ["main", "a", "b"]}`.

## What runs on a clock

Two things drive lanes without anyone typing:

- **PaneForge itself**, once a minute, while it is open.
- **A scheduled task**, every 10 minutes, whether it is open or not
  (`scripts/lane-cron.mjs`). This is the one that matters overnight: the app being closed
  used to mean no retry at all, and a stale release lock plus a tagged-but-unpushed
  version once sat for eight hours because of it.

Each tick re-tries conflicts that have stopped being conflicts (the change they disagreed
with shipped), rescues lanes whose chat never came back, clears a release lock left by a
killed session, and releases anything that was waiting on the cooldown.

## When something looks stuck

```
node scripts/lane.mjs doctor                    # this repo
node scripts/lane.mjs doctor --repo <dir>       # any repo on the machine
```

It answers, in sentences: what each lane holds, who is in it, what is waiting to go out
and why, and what leftovers are lying around - folders that look like lanes but git has
forgotten about, lanes from the old naming, and lane branches pushed to a remote that only
make the project look behind.

Typical answers and what they mean:

| It says | What is happening |
|---|---|
| `Waiting on chats still working in: a` | Someone is mid-edit in lane a. A release now would ship half a change. It goes out when they finish. |
| `Work is ready. It goes out in about 12m` | The release cooldown. One release will carry all of it. |
| `A release started 3m ago and is still running` | A build is in progress. It says it is alive as it goes, so this only reads "crashed" after 20 minutes of real silence. |
| `conflicts with master` | The lane and the branch changed the same file. It is re-tried on every tick and usually resolves itself when the other side ships. |
| `looks like a lane but git does not know about it` | Debris. Nothing merges it and nothing will clean it up - look at it, then delete it. |

## Rules worth knowing

- **A lane is never deleted with anything in it.** One uncommitted character, one untracked
  file, or one commit the project does not have, and the folder stays - including a lane
  whose commits were squashed on merge, which cannot be told apart from unmerged work. A
  folder that is still there is a folder with something in it.
- **Uncommitted work is never marked ready.** Nobody releases half an edit.
- **A conflicted lane does not block anyone else's release.** It keeps its ready mark, is
  reported by name, and goes out on the next release once it merges.
- **A lane never cuts its own release.** The batch does.

## The pieces

| File | What it is |
|---|---|
| `scripts/lane.mjs` | The engine: claim, guard, ready, ship, retry, doctor. One copy, driving every project on the machine. |
| `scripts/lane-cron.mjs` | The 10-minute sweep over every project that uses lanes. No app, no AI, no window. |
| `src/main/lanes.ts` | Makes the lane when a second pane opens a project, and seeds it (`.env` files, `node_modules`, dev port, agent history). |
| `src/main/laneWork.ts` | What is in a lane, merging it back, and sweeping the empty ones. |
| `src/shared/place.ts` | What a pane is allowed to say about where it is. |

Tests: `npm run test:lanes`.
