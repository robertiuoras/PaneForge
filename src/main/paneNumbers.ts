// The one card-number allocator for this machine's panes (`shared/paneLabel.ts`). Panes
// take a number in `SessionManager.start()` and give it back where the session is removed;
// screen panes take theirs in `allSessions()`. A mirrored pane never takes one here - it
// wears the number its own machine gave it.
import { PaneNumbers } from '../shared/paneLabel'

export const paneNumbers = new PaneNumbers()
