# One assistant, two places to work

Planning recommendation, 13 September 2026. This describes the proposed product boundary, not an implemented integration.

Taskdriver owns the business record: clients, enquiries, projects, briefs, approvals and delivered results. Its Agents area should explain recurring work in business language and link each run to a client/task. PaneForge is the private desktop workbench: talk to the assistant, investigate its work, use files, inspect code, and supervise computer sessions. A task started on mobile must appear as the same task in the desktop workbench. No separate queue, conflicting status or second approval record.

## The three views in PaneForge

- **Chat:** one personal point of contact, typed or occasional live voice; project context visible beside the conversation. Start with the familiar name Astra as a reversible design placeholder, not a selected model or committed brand. Changing the display name must not change provider routing.
- **Work:** deliverables and exceptions across projects. See what is being prepared, what needs a decision and what has evidence ready. Open a task to inspect its conversation, responsible worker, files and proof. Capacity belongs in an optional technical view.
- **Code:** repository files, changes, terminal sessions, previews and test results. Retain fast Copy output, Clear view and Open folder controls. Clear view never deletes the saved conversation or task evidence.

Taskdriver mobile shows business progress, captures instructions and presents decisions. It should link to a desktop session when useful, rather than recreate an entire IDE on a phone. PaneForge should not become another CRM, invoice system or campaign reporting database.

## Skills, persistent teammates and execution sessions

A skill packages a reusable method. A persistent teammate can own an ongoing responsibility, scoped memory, routines and results across conversations. A worker is the actual execution session used to do a task. Having ten persistent identities does not require ten continuously generating model sessions. The provider/model is a separate execution choice. This refines the original instructions-only proposal after identifying Grok Bot; see [the competitor research](grok-bot-competitor.md).

| Capability | Useful first workflow | Canonical home | Measure | Initial decision |
| --- | --- | --- | --- | --- |
| Research | Brief with sources and unresolved questions | Taskdriver project, opened in PaneForge when investigating | Accepted brief, correction minutes, missing citations | Start here |
| Sales support | Qualify enquiry and prepare proposal draft | Taskdriver enquiry | Proposal turnaround and user edits | Start here |
| Marketing | Produce campaign drafts against an approved brief | Taskdriver client/project | Approved assets per review hour; later actual campaign outcomes | Start here |
| Delivery / operations | Track dependencies and compile evidence of completed work | Taskdriver project | Missed requirements, overdue blockers, review time | Start here |
| Engineering | Implement scoped changes with tests and preview | PaneForge Code, linked Taskdriver task when business work | Accepted changes, regressions and human review time | Start here |
| Finance support | Prepare reconciliations or invoice drafts from authorised records | Taskdriver business workflow | Reconciliation exceptions and corrections | Add for a real recurring workload; no independent payments |
| CEO / strategy | Weekly business review grounded in pipeline, delivery capacity and financial records | Taskdriver business review; discuss in Chat | Decisions adopted and outcomes reviewed | A review workflow, not an autonomous boss |
| Grok Bot | External persistent teammate product and comparison candidate | External service; future Taskdriver linkage only if supported | Accepted work, correction minutes and usage | Product identified; integration and account entitlement unverified |

Default method: deterministic code for calculations, formatting, dispatch and status; one capable subscription worker for an ambiguous bounded task; specialist delegation only for independent work or a justified separate review. Use event-triggered or scheduled runs for recurring work, not an always-thinking agent for each department. Add retrieval when repeated context lookup warrants it, and test smaller/open-weight models on narrow tasks before letting them make consequential decisions.

## Example: a new client request

1. An enquiry and brief enter Taskdriver. The assistant prepares a project-linked draft scope; it does not invent approval to contact the client.
2. Robert discusses it with Astra in Chat or from mobile. The same task retains the brief, decisions and agreed result.
3. A research worker gathers relevant context. Delivery work then uses the required marketing, document or coding skills. Parallel work is limited to genuinely independent parts.
4. PaneForge Work shows the current deliverable and any missing input. Code or a computer session opens only when inspection helps.
5. Tests and source checks accompany the result. Taskdriver presents the evidence and approval action. Nothing is sent or published without the applicable approval.

## What to remove from the concept

Remove orchestration jargon from navigation, synthetic worker counts, arbitrary coloured numbers, duplicate business dashboards and the implication that more agents means better work. Keep one accent colour, explicit status words, clear typography and contextual details. Preserve simple direct controls even when voice can request the same action.

The revised local prototype is `../design/paneforge-directions/studio.html`. Its conversations, tasks and code are fictional examples; it does not start workers or connect either product. This is a design revision, not a Tauri migration or a fix for the current renderer defect.
