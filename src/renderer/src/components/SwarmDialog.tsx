import { useEffect, useRef, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { modelLabel, modelValue, supportsModel } from '@shared/agents'
import type { Project, SplitPlan, SwarmRole } from '@shared/types'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'
import { Segmented } from './Controls'
import Select from './Select'

const api = window.api

/**
 * What the dialog was opened WITH, when something other than the toolbar opened it.
 *
 * The split offer chip in a pane knows all three answers already - the folder that pane is
 * in and the words in its prompt box - and re-typing them into a dialog is the reason a
 * feature that exists goes unused. `plan` starts the planner on open, which is still a
 * deliberate action: it is the click on the chip.
 */
export interface SwarmStart {
  mode?: 'roles' | 'split'
  cwd?: string
  mission?: string
  plan?: boolean
}

interface Props {
  projects: Project[]
  agents: AgentInfo[]
  roles: SwarmRole[]
  defaultModels: Record<string, string>
  initial?: SwarmStart
  onSaveRoles: (roles: SwarmRole[]) => void
  onClose: () => void
  onLaunched: (count: number) => void
}

/**
 * Two ways to put several agents on one job, and the difference between them is the
 * only thing this dialog really has to explain.
 *
 * **Roles** is one mission, several agents, ONE folder. Right when the agents interleave
 * - a builder and a reviewer want the same files, and the shared memory file is the
 * handover between them. What keeps them apart is their briefs.
 *
 * **Split** is one task cut into workstreams, each in its OWN git worktree. Right when
 * the parts are independent, and the reason to prefer it there is that "do not edit
 * another agent's files" stops being a sentence in a prompt and becomes a fact about the
 * checkout: they are not looking at the same files. The plan comes from the local coding
 * CLI, and it is a proposal - every lane here is editable, and unticking one leaves its
 * files to nobody.
 */
export default function SwarmDialog({
  projects,
  agents,
  roles,
  defaultModels,
  initial,
  onSaveRoles,
  onClose,
  onLaunched
}: Props): JSX.Element {
  const [cwd, setCwd] = useState(initial?.cwd ?? projects[0]?.path ?? '')
  const [mission, setMission] = useState(initial?.mission ?? '')
  const [local, setLocal] = useState<SwarmRole[]>(roles)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [mode, setMode] = useState<'roles' | 'split'>(initial?.mode ?? 'roles')
  const [plan, setPlan] = useState<SplitPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  // Planning is a whole CLI start-up plus a real answer - measured at 22-33s for the
  // improver on this machine. A button that looks stuck for half a minute reads as a
  // broken feature, so the seconds are on screen while it thinks.
  const [waited, setWaited] = useState(0)
  const [worker, setWorker] = useState('')
  const [openLane, setOpenLane] = useState<number | null>(null)

  const usable = agents.filter((a) => a.available)
  const chosen = local.filter((r) => r.enabled)
  const lanes = plan?.lanes.filter((l) => l.enabled !== false) ?? []

  useEffect(() => {
    if (!planning) return
    const started = Date.now()
    const t = setInterval(() => setWaited(Math.round((Date.now() - started) / 1000)), 500)
    return () => clearInterval(t)
  }, [planning])

  const patchLane = (i: number, p: Partial<SplitPlan['lanes'][number]>): void =>
    setPlan((prev) =>
      prev ? { ...prev, lanes: prev.lanes.map((l, j) => (j === i ? { ...l, ...p } : l)) } : prev
    )

  const makePlan = async (): Promise<void> => {
    if (!cwd || !mission.trim() || planning) return
    setPlanning(true)
    setWaited(0)
    setPlan(null)
    try {
      setPlan(await api.planSplit({ cwd, mission, agent: worker || undefined }))
    } catch {
      setPlan({ lanes: [], contracts: '', refused: 'The planner could not be run.' })
    } finally {
      setPlanning(false)
    }
  }

  // Opened from a pane's own offer: the folder and the words are already here, so the
  // planner starts without a second click. Once only - re-planning is the button.
  const autoPlanned = useRef(false)
  useEffect(() => {
    if (autoPlanned.current || !initial?.plan || !cwd || !mission.trim()) return
    autoPlanned.current = true
    void makePlan()
  }, [initial, cwd, mission])

  const launchSplit = async (): Promise<void> => {
    if (!plan || !lanes.length || busy) return
    setBusy(true)
    try {
      const started = await api.startSplit({
        cwd,
        mission,
        plan,
        agent: (worker || usable[0]?.id) as never,
        model: defaultModels[worker || usable[0]?.id || ''] || undefined
      })
      onLaunched(started.length)
    } finally {
      setBusy(false)
    }
  }

  const patch = (id: string, p: Partial<SwarmRole>): void =>
    setLocal((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const launch = async (): Promise<void> => {
    if (!cwd || !mission.trim() || !chosen.length || busy) return
    setBusy(true)
    onSaveRoles(local)
    try {
      const started = await api.startSwarm({
        cwd,
        mission,
        // Roles fall back to the agent's remembered default model when none is set.
        roles: local.map((r) => ({ ...r, model: r.model || defaultModels[r.agent] || undefined }))
      })
      onLaunched(started.length)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Swarm</strong>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'roles' | 'split')}
            options={[
              { value: 'roles', label: 'Roles' },
              { value: 'split', label: 'Split' }
            ]}
          />
          <span className="hint">
            {mode === 'roles'
              ? 'one mission, one pane per role, all in the same folder'
              : 'one task cut into workstreams, each in its own worktree'}
          </span>
        </div>
        <Blurb id="swarm" />

        <div className="setting">
          <label>Project</label>
          <Select
            value={cwd}
            onChange={setCwd}
            menuWidth={420}
            placeholder="Pick a folder"
            options={projects.map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
          />
        </div>

        <div className="setting">
          <label>Mission</label>
          <textarea
            className="mission"
            autoFocus
            rows={3}
            placeholder="Add offer replies to the dashboard, with tests."
            value={mission}
            onChange={(e) => setMission(e.target.value)}
          />
        </div>

        {mode === 'roles' && (
        <div className="setting">
          <div className="setting-row">
            <label>Roles ({chosen.length} panes)</label>
            <button
              className="ghost small"
              onClick={() =>
                setLocal((rs) => [
                  ...rs,
                  {
                    id: `r${Date.now().toString(36)}`,
                    name: 'New role',
                    agent: usable[0]?.id ?? 'claude',
                    brief: 'You own ...',
                    enabled: true
                  }
                ])
              }
            >
              Add role
            </button>
          </div>

          <div className="roles">
            {local.map((r) => {
              const spec = agents.find((a) => a.id === r.agent)
              return (
                <div key={r.id} className={'role' + (r.enabled ? '' : ' off')}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  />
                  <input
                    className="role-name"
                    value={r.name}
                    onChange={(e) => patch(r.id, { name: e.target.value })}
                  />
                  <Select
                    size="sm"
                    menuWidth={240}
                    value={r.agent}
                    onChange={(v) => patch(r.id, { agent: v, model: '' })}
                    options={usable.map((a) => ({
                      value: a.id,
                      label: a.label,
                      icon: <AgentLogo id={a.id} spec={a} size={13} />
                    }))}
                  />
                  {supportsModel(spec) && (
                    <Select
                      size="sm"
                      menuWidth={240}
                      value={r.model ?? ''}
                      placeholder="default"
                      onChange={(v) => patch(r.id, { model: v })}
                      options={[
                        { value: '', label: 'Default model' },
                        ...(spec?.models ?? []).map((m) => ({
                          value: modelValue(m),
                          label: modelLabel(m)
                        }))
                      ]}
                    />
                  )}
                  <button
                    className="ghost small"
                    title="Edit what this role is told to do"
                    onClick={() => setEditing(editing === r.id ? null : r.id)}
                  >
                    Brief
                  </button>
                  <button className="x" title="Remove role" onClick={() => setLocal((rs) => rs.filter((x) => x.id !== r.id))}>
                    x
                  </button>
                  {editing === r.id && (
                    <textarea
                      className="brief"
                      rows={3}
                      value={r.brief}
                      onChange={(e) => patch(r.id, { brief: e.target.value })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
        )}

        {mode === 'split' && (
          <div className="setting">
            <div className="setting-row">
              <label>Lanes{plan && lanes.length ? ` (${lanes.length} panes)` : ''}</label>
              <Select
                size="sm"
                menuWidth={240}
                value={worker}
                placeholder="Agent"
                onChange={setWorker}
                options={usable.map((a) => ({
                  value: a.id,
                  label: a.label,
                  icon: <AgentLogo id={a.id} spec={a} size={13} />
                }))}
              />
              <button
                className="ghost small"
                disabled={!cwd || !mission.trim() || planning}
                onClick={makePlan}
              >
                {planning ? `Planning... ${waited}s` : plan ? 'Plan again' : 'Plan the split'}
              </button>
            </div>

            {plan?.refused && (
              <p className="hint refused">
                {plan.refused} Build it in one pane, or reword the task and plan again.
              </p>
            )}

            {!plan && !planning && (
              <p className="hint">
                The agent above reads this project and proposes who builds what. Nothing
                starts until you launch.
              </p>
            )}

            {plan && lanes.length > 0 && (
              <>
                <div className="roles">
                  {plan.lanes.map((l, i) => (
                    <div key={i} className={'role' + (l.enabled === false ? ' off' : '')}>
                      <input
                        type="checkbox"
                        checked={l.enabled !== false}
                        onChange={(e) => patchLane(i, { enabled: e.target.checked })}
                      />
                      <input
                        className="role-name"
                        value={l.name}
                        onChange={(e) => patchLane(i, { name: e.target.value })}
                      />
                      <span className="hint owns" title={l.owns.join('\n')}>
                        {l.owns.join(', ')}
                      </span>
                      <button
                        className="ghost small"
                        title="What this lane is told to build"
                        onClick={() => setOpenLane(openLane === i ? null : i)}
                      >
                        Brief
                      </button>
                      {openLane === i && (
                        <textarea
                          className="brief"
                          rows={4}
                          value={l.brief}
                          onChange={(e) => patchLane(i, { brief: e.target.value })}
                        />
                      )}
                    </div>
                  ))}
                </div>
                <label className="sub">Every lane is told this</label>
                <textarea
                  className="brief"
                  rows={2}
                  placeholder="Shared types, config keys, script names - what they must all implement the same."
                  value={plan.contracts}
                  onChange={(e) =>
                    setPlan((prev) => (prev ? { ...prev, contracts: e.target.value } : prev))
                  }
                />
              </>
            )}
          </div>
        )}

        <div className="dialog-row">
          <span className="hint">
            {mode === 'roles' ? (
              <>
                Each pane is told its role, the mission, and to read{' '}
                <code>.paneforge/MEMORY.md</code> first.
              </>
            ) : (
              'Each lane opens in its own worktree on its own branch. Merge them from the lane strip when they are done.'
            )}
          </span>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          {mode === 'roles' ? (
            <button className="primary" disabled={!cwd || !mission.trim() || !chosen.length || busy} onClick={launch}>
              {busy ? 'Starting...' : `Launch ${chosen.length} agents`}
            </button>
          ) : (
            <button className="primary" disabled={!lanes.length || busy} onClick={launchSplit}>
              {busy ? 'Starting...' : `Launch ${lanes.length} lanes`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
