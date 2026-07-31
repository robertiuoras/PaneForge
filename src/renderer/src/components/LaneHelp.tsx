/**
 * What lanes are, for someone who never read the release script.
 *
 * Every other lane surface (the chip on a card, the strip, the per-pane dialog) states
 * facts about ONE lane in as few words as fit. This card is the one place the system is
 * allowed a paragraph, so the words here assume nothing: no "worktree", no "master", no
 * command names. Each of those surfaces links here, which is what lets them stay terse.
 */
interface Props {
  onClose: () => void
}

export default function LaneHelp({ onClose }: Props): JSX.Element {
  return (
    <div className="overlay confirm-overlay" onMouseDown={onClose}>
      <div className="dialog confirm lane-help" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>How lanes work</strong>
        </div>
        <div className="confirm-body">
          <p>
            Several chats can work on the same project at once. So they don&apos;t overwrite
            each other, each gets a <b>lane</b>: its own copy of the project&apos;s folder.
            You never set one up — a chat is handed a lane when a second chat opens the same
            project, and it&apos;s cleaned up when the work is merged back.
          </p>
          <p>
            <span className="chip">w2</span> on a pane means that pane is working in its own
            copy of the project it opened. Click the chip to see what&apos;s in there and
            merge it back when you want it.
          </p>
          <p>
            <span className="chip pf-lane">PF lane a</span> means that chat is editing
            PaneForge itself in a shared lane. Finished lanes are folded together and go out
            as <b>one update</b>, at most every half hour — so &quot;done, waiting&quot; is
            normal, not stuck.
          </p>
          <p>
            <b>Stuck</b> means two chats changed the same lines and the app won&apos;t guess
            a winner. One chat gets a short note in its pane saying exactly what to run;
            everything else still ships, and the stuck work rejoins the next update once
            someone picks.
          </p>
          <p>
            None of this needs managing. The chips are status, not chores — merging,
            shipping and cleanup all happen on their own.
          </p>
        </div>
        <div className="dialog-row">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
