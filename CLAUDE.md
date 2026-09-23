@AGENTS.md

## Claude Code only

- Lanes: a hook assigns `main` (master) or worktree `PaneForge-a/-b/-c` on `lane-a/-b/-c`;
  write only there, PreToolUse refuses elsewhere. First edit of a file another lane changed is
  told with line ranges (`guard` exits 0 with text); same region: message that chat first.
