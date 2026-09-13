# Successor layout alternatives

Three interactive prototypes of the private PaneForge successor, same content, same sample task, same ember identity. Planning artefacts only: fictional work and messages, no agent, provider, voice or Taskdriver connection. Open `index.html` for the comparison, or any `layout-*.html` directly.

| File | Layout | Idea under test |
| --- | --- | --- |
| `layout-a.html` | Left navigation | Chat / Work / Code are the top of the sidebar, above projects and saved chats (closest to the current studio demo). |
| `layout-b.html` | Top mode control | A centred segmented Chat / Work / Code in the title bar; the sidebar holds only projects and saved chats. |
| `layout-c.html` | Task-first | No global mode. One list of projects with their tasks and chats; the selected task carries Conversation / Result / Code tabs; ⌘K finds anything. |

`shared.css` carries the tokens (from `../paneforge-directions/studio-polish.css`), the light scheme, reduced motion and the handheld breakpoint. `shared.js` renders the shared view bodies, runs the five-step task, and counts actions, wrong turns and recoveries in the strip at the bottom of every page (an evaluation harness, not product UI). Design reference followed for cards and surfaces: `claude-memory/toolstash/design-vault/linear.app.md` (hairline borders instead of shadows, small-step surface ladder, two-duration motion).

## The shared task

1. Start a project called "Harbour Studio launch".
2. Switch this conversation's agent to Claude.
3. Find the decision that is waiting and approve the focused scope.
4. Open the saved chat "Weekly business review".
5. Return to the code for "Improve the project view".

Keyboard in every layout: ⌘/Ctrl 1·2·3 views, ⌘K find anything, ⌘N new project, `/` search, Esc closes, Tab/Enter/Space on every control, arrows inside the palette.

## Evidence

`node check.mjs` drives the isolated Chrome Automation bundle headlessly (throwaway profile, GuardDeck row while it runs) and writes `validation.json` plus `shot-<layout>-desktop.png` / `shot-<layout>-phone.png`. It fails on: the task not completing by click or by keyboard, any wrong turn on the intended path, a control without a name or focus, an image without alt, body or secondary text under 4.5:1 or labels under 3:1 in either colour scheme, a transition surviving reduced motion, a control under 44px or a horizontal scroll at 390px, the sidebar not becoming a drawer, or the Work view losing its "Open in Taskdriver" link on the phone.

Last run (2026-09-13): all three layouts pass. Click path 11 / 11 / 9 actions with 0 wrong turns (A / B / C); keyboard path 20 actions each; muted text 7.13:1 dark, 7.02:1 light. Machine counts say nothing about which layout people prefer or where they get lost. That is what the user evaluation in `../../research/successor-product-plan.md` is for.
