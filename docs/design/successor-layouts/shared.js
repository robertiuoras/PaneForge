/* Successor layout prototypes: one script, three layouts.
   The layout page supplies the DOM; every control carries data-action="<verb>[:<arg>]".
   This file renders the shared sample content, runs the shared five-step task script,
   counts wrong turns and recoveries, and exposes window.__pfProto for the headless check.
   Fictional data. Nothing here connects to an agent, a provider or Taskdriver. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const layout = document.body.dataset.layout || 'unknown';
  const BRANDS = '../paneforge-directions/assets/brands/';
  const AGENTS = [
    { id: 'Codex', img: 'codex.svg' },
    { id: 'Claude', img: 'claude.svg' },
    { id: 'Antigravity', img: 'antigravity.png' },
  ];
  const PROJECTS = ['Harbour Studio', 'Taskdriver', 'PaneForge'];
  const THREADS = [
    { id: 'launch', title: 'The launch plan', project: 'Harbour Studio' },
    { id: 'review', title: 'Weekly business review', project: 'Taskdriver' },
    { id: 'projectview', title: 'Improve the project view', project: 'PaneForge' },
  ];
  const TASKS = [
    { id: 'launch-pack', project: 'Harbour Studio', title: 'Prepare the launch pack', state: 'In progress', who: 'Research teammate', agent: 'Codex' },
    { id: 'scope', project: 'Taskdriver', title: 'Choose the proposal scope', state: 'Needs your decision', who: 'Sales support', agent: 'Claude' },
    { id: 'projectview', project: 'PaneForge', title: 'A cleaner project view', state: 'Ready to review', who: 'Engineering teammate', agent: 'Codex' },
  ];

  // ---- shared task script (identical in every layout) -------------------
  const SCRIPT = [
    { n: 1, say: 'Start a project called "Harbour Studio launch"', accept: ['confirm-project'], neutral: ['new-project', 'open-nav', 'palette', 'palette-pick:new-project', 'focus-search'] },
    { n: 2, say: 'Switch the agent on this conversation to Claude', accept: ['agent:Claude'], neutral: ['agent-menu', 'palette', 'palette-pick:agent:Claude', 'mode:chat', 'tab:chat'] },
    { n: 3, say: 'Find the decision that is waiting and approve the focused launch scope', accept: ['approve'], neutral: ['mode:work', 'tab:work', 'open-task:scope', 'open-approval', 'pick:focused', 'palette', 'palette-pick:open-task:scope', 'open-nav', 'task:scope'] },
    { n: 4, say: 'Open the saved chat "Weekly business review"', accept: ['thread:review'], neutral: ['focus-search', 'search', 'palette', 'palette-pick:thread:review', 'mode:chat', 'tab:chat', 'open-nav'] },
    { n: 5, say: 'Go back to the code for "Improve the project view"', accept: ['mode:code', 'tab:code', 'open-task:projectview', 'task:projectview'], neutral: ['palette', 'palette-pick:mode:code', 'open-nav', 'thread:projectview'] },
  ];
  // Layout C has no global mode: step 5 completes when the projectview task is opened AND its code tab shown.
  const state = {
    layout, mode: 'chat', project: 'Harbour Studio', thread: 'launch', agent: 'Codex', task: null, approval: null, pick: null,
    step: 0, started: 0, log: [], wrongTurns: 0, recoveries: 0, lastWrongAt: 0, recoverMs: [], stepStart: 0, stepMs: [], done: false, newProjectPending: false,
  };

  // ---- helpers ---------------------------------------------------------------
  const toast = t => { const el = $('.toast'); if (el) el.textContent = t || ''; };
  const now = () => performance.now();
  const brandImg = id => BRANDS + (AGENTS.find(a => a.id === id) || AGENTS[0]).img;

  function log(action, source) {
    const t = now();
    const step = SCRIPT[state.step];
    const entry = { t: Math.round(t), action, source, step: step ? step.n : null };
    if (step && !state.done) {
      if (!state.started) { state.started = t; state.stepStart = t; }
      const ok = step.accept.some(a => action === a || (a.endsWith(':') && action.startsWith(a)));
      const neutral = step.neutral.some(a => action === a);
      if (ok) {
        entry.result = 'step-complete';
        if (state.lastWrongAt) { state.recoveries++; state.recoverMs.push(Math.round(t - state.lastWrongAt)); state.lastWrongAt = 0; }
        state.stepMs.push(Math.round(t - state.stepStart));
        state.step++; state.stepStart = t;
        if (state.step >= SCRIPT.length) { state.done = true; entry.result = 'task-complete'; }
      } else if (!neutral && !action.startsWith('type') && action !== 'close') {
        entry.result = 'wrong-turn';
        state.wrongTurns++; if (!state.lastWrongAt) state.lastWrongAt = t;
      } else entry.result = 'neutral';
    }
    state.log.push(entry);
    renderGuide();
  }

  // ---- rendering -----------------------------------------------------------
  function setMode(m) {
    state.mode = m;
    $$('.view').forEach(v => v.hidden = v.dataset.view !== m);
    $$('[data-action^="mode:"],[data-action^="tab:"]').forEach(b => {
      const on = b.dataset.action.split(':')[1] === m;
      if (b.hasAttribute('aria-selected')) b.setAttribute('aria-selected', String(on));
      if (b.hasAttribute('aria-current') || b.classList.contains('nav-btn')) b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $$('.approval-view').forEach(v => v.hidden = m !== 'work' || !state.approval);
    $('.work-grid') && ($('.work-grid').hidden = m !== 'work' || !!state.approval);
  }
  function renderChat() {
    const th = THREADS.find(t => t.id === state.thread);
    const tk = TASKS.find(t => t.id === state.task);
    const title = state.newProjectPending ? 'Harbour Studio launch' : (th ? th.title : tk ? tk.title : 'New conversation');
    const project = state.newProjectPending ? 'Harbour Studio launch' : state.project;
    $$('[data-bind="project-title"]').forEach(e => e.textContent = project);
    $$('[data-bind="thread-title"]').forEach(e => e.textContent = title);
    $$('[data-bind="eyebrow"]').forEach(e => e.textContent = project + ' / ' + title);
    $$('[data-bind="agent-name"]').forEach(e => e.textContent = state.agent);
    $$('[data-bind="agent-img"]').forEach(e => e.src = brandImg(state.agent));
    const msg = state.thread === 'review' ? 'Help me review the business this week.' : state.newProjectPending ? 'Set up the Harbour Studio launch and tell me what needs a decision.' : 'Can you get the launch ready and show me what needs a decision?';
    const ans = state.thread === 'review' ? 'I would bring together the pipeline, delivery commitments and open decisions from Taskdriver, then say what deserves your time. Sample conversation.' : 'Yes. I would start with the client brief, prepare the campaign drafts, then bring the work back here for review. Nothing goes to the client until you approve it.';
    $$('[data-bind="user-msg"]').forEach(e => e.textContent = msg);
    $$('[data-bind="answer"]').forEach(e => e.textContent = ans);
    $$('[data-action^="thread:"]').forEach(b => b.setAttribute('aria-current', String(b.dataset.action === 'thread:' + state.thread)));
    $$('[data-action^="project:"]').forEach(b => b.setAttribute('aria-current', String(b.dataset.action === 'project:' + state.project)));
    $$('.agent-menu button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.action === 'agent:' + state.agent)));
  }
  function renderWork() {
    const grid = $('.work-grid'); if (!grid) return;
    const groups = ['In progress', 'Needs your decision', 'Ready to review'];
    grid.innerHTML = groups.map(g => `<div class="column"><h2>${g}</h2>${TASKS.filter(t => t.state === g).map(t => `
      <article class="card ${g === 'Needs your decision' ? 'needs' : ''}"><small>${t.project}</small><h3>${t.title}</h3>
      <p>${t.who} · <img src="${brandImg(t.agent)}" alt="" style="width:12px;height:12px;vertical-align:-2px"> ${t.agent}</p>
      ${g === 'Needs your decision' ? `<button class="btn" data-action="open-approval">Review the decision</button>` : g === 'Ready to review' ? `<button class="btn" data-action="mode:code">Open changes</button>` : `<button class="btn quiet" data-action="thread:launch">Open conversation</button>`}
      <a class="btn quiet" href="#" data-action="taskdriver-link" style="font-size:12px;margin-top:4px;text-decoration:none">Open in Taskdriver ↗</a></article>`).join('')}</div>`).join('');
  }
  function renderApproval() {
    const v = $('.approval-view'); if (!v) return;
    v.innerHTML = `<div class="approval"><small style="color:var(--dim);letter-spacing:1px;font-size:10px">TASKDRIVER · CHOOSE THE PROPOSAL SCOPE</small>
      <h2 style="color:var(--text);font-size:18px;margin:8px 0 4px">Which scope should the proposal carry?</h2>
      <p style="color:var(--muted);margin:0">Sales support prepared two options from the enquiry. Your choice sets the work to prepare. The same decision shows on your phone in Taskdriver.</p>
      <div class="options" role="radiogroup" aria-label="Scope options">
        <div class="opt" role="radio" tabindex="0" aria-checked="${state.pick === 'focused'}" data-action="pick:focused"><b>Focused launch package</b><p style="color:var(--muted);margin:4px 0 0;font-size:12.5px">Brief, campaign drafts, one review round.</p></div>
        <div class="opt" role="radio" tabindex="0" aria-checked="${state.pick === 'broad'}" data-action="pick:broad"><b>Ongoing campaign</b><p style="color:var(--muted);margin:4px 0 0;font-size:12.5px">Monthly assets, reporting, retainer.</p></div>
      </div>
      <div class="evidence">Evidence: enquiry notes, two comparable past proposals, budget line from the brief. <a href="#" data-action="taskdriver-link">Open in Taskdriver ↗</a></div>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="btn primary" data-action="approve" ${state.pick ? '' : 'disabled'}>Approve ${state.pick === 'broad' ? 'the ongoing campaign' : 'the focused scope'}</button><button class="btn" data-action="back-work">Back to work</button></div>
      ${state.approval === 'done' ? '<p class="state ok" style="margin-top:12px">Approved · recorded in Taskdriver (sample)</p>' : ''}</div>`;
  }
  function renderTaskList() {
    const list = $('.task-list'); if (!list) return;
    list.innerHTML = PROJECTS.map(p => `<small class="section-label">${p}</small>` + TASKS.filter(t => t.project === p).map(t =>
      `<button class="rowitem" data-action="task:${t.id}" aria-current="${state.task === t.id}"><b>${t.title}</b><span class="meta">${t.state}</span></button>`).join('')
      + THREADS.filter(t => t.project === p).map(t => `<button class="rowitem" data-action="thread:${t.id}" aria-current="${state.thread === t.id && !state.task}"><b>${t.title}</b><span class="meta">chat</span></button>`).join('')).join('');
  }
  function renderGuide() {
    const g = $('.guide'); if (!g) return;
    const step = SCRIPT[state.step];
    $('.guide .say').innerHTML = state.done ? '<b>Task complete.</b> Thank you.' : `Step ${step.n} of ${SCRIPT.length}: <b>${step.say}</b>`;
    $('.guide .steps').innerHTML = SCRIPT.map((s, i) => `<i class="${i < state.step ? 'done' : ''}"></i>`).join('');
    const acts = state.log.filter(e => e.result && e.result !== 'neutral').length;
    $('.guide .stats').innerHTML = `<span>actions ${state.log.length}</span><span>wrong turns ${state.wrongTurns}</span><span>recovered ${state.recoveries}</span>${state.done ? `<span>time ${Math.round((state.log.at(-1).t - state.started) / 1000)}s</span>` : ''}`;
  }
  function renderAll() { renderChat(); renderWork(); renderApproval(); renderTaskList(); setMode(state.mode); renderGuide(); }

  // ---- palette -----------------------------------------------------------------
  const COMMANDS = [
    { id: 'new-project', label: 'New project', k: '⌘N' },
    { id: 'agent:Claude', label: 'Use Claude for this conversation' },
    { id: 'agent:Codex', label: 'Use Codex for this conversation' },
    { id: 'open-task:scope', label: 'Decision: Choose the proposal scope', k: 'needs you' },
    { id: 'thread:review', label: 'Saved chat: Weekly business review' },
    { id: 'thread:launch', label: 'Saved chat: The launch plan' },
    { id: 'open-task:projectview', label: 'Task: A cleaner project view (code)' },
    { id: 'mode:chat', label: 'Go to Chat', k: '⌘1' }, { id: 'mode:work', label: 'Go to Work', k: '⌘2' }, { id: 'mode:code', label: 'Go to Code', k: '⌘3' },
  ];
  function openPalette(prefill = '') {
    let p = $('.palette'); if (p) p.remove();
    p = document.createElement('div'); p.className = 'palette'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Find anything');
    p.innerHTML = `<div class="box"><input placeholder="Find a project, chat, decision or view…" aria-label="Find anything" value="${prefill}"><ul role="listbox"></ul></div>`;
    document.body.appendChild(p);
    const input = $('input', p), ul = $('ul', p);
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const rows = COMMANDS.filter(c => !q || c.label.toLowerCase().includes(q));
      ul.innerHTML = rows.map((c, i) => `<li role="option"><button data-action="palette-pick:${c.id}" aria-selected="${i === 0}">${c.label}<span class="k">${c.k || ''}</span></button></li>`).join('') || '<li style="padding:10px;color:var(--dim)">Nothing matches</li>';
    };
    draw(); input.focus();
    input.oninput = () => { draw(); };
    input.onkeydown = e => {
      if (e.key === 'Escape') { p.remove(); log('close', 'kbd'); }
      if (e.key === 'Enter') { const b = $('button[aria-selected="true"]', p); if (b) b.click(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const bs = $$('li button', p); let i = bs.findIndex(b => b.getAttribute('aria-selected') === 'true');
        i = Math.max(0, Math.min(bs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        bs.forEach((b, j) => b.setAttribute('aria-selected', String(j === i))); e.preventDefault();
      }
    };
    p.onclick = e => { if (e.target === p) { p.remove(); log('close', 'click'); } };
    log('palette', 'open');
  }

  // ---- actions -----------------------------------------------------------------
  function act(action, source = 'click') {
    const [verb, arg] = action.split(/:(.+)/);
    switch (verb) {
      case 'mode': setMode(arg); break;
      case 'tab': setMode(arg); break;
      case 'open-nav': $('.sidebar')?.classList.toggle('open'); break;
      case 'new-project': state.newProjectPending = true; state.thread = null; state.task = null; setMode('chat'); renderChat();
        toast('Name the project, then press Create. Prototype: nothing is written to disk.'); showCreate(true); break;
      case 'confirm-project': state.newProjectPending = false; state.project = 'Harbour Studio launch'; state.thread = null; PROJECTS.includes('Harbour Studio launch') || PROJECTS.unshift('Harbour Studio launch');
        THREADS.unshift({ id: 'newproj', title: 'Harbour Studio launch', project: 'Harbour Studio launch' }); state.thread = 'newproj'; showCreate(false); renderAll(); toast('Project created (sample). Its folder and first conversation are ready.'); break;
      case 'project': state.project = arg; state.task = null; state.thread = THREADS.find(t => t.project === arg)?.id || null; setMode('chat'); renderAll(); break;
      case 'thread': { const th = THREADS.find(t => t.id === arg); if (th) { state.thread = arg; state.project = th.project; state.task = null; state.approval = null; } setMode('chat'); renderAll(); $('.sidebar')?.classList.remove('open'); break; }
      case 'agent-menu': { const m = $('.agent-menu'); const b = $('[data-action="agent-menu"]'); const open = m.hidden; m.hidden = !open; b.setAttribute('aria-expanded', String(open)); if (open) $('button', m)?.focus(); break; }
      case 'agent': state.agent = arg; $('.agent-menu').hidden = true; $('[data-action="agent-menu"]')?.setAttribute('aria-expanded', 'false'); renderChat(); toast(arg + ' will handle this conversation from here. Prototype: no provider connection was made.'); break;
      case 'open-approval': state.approval = 'open'; state.task = 'scope'; renderApproval(); setMode('work'); break;
      case 'open-task': case 'task': { const t = TASKS.find(x => x.id === arg); if (!t) break; state.task = arg; state.project = t.project; state.thread = null;
        if (arg === 'scope') { state.approval = 'open'; renderApproval(); setMode(layout === 'c' ? 'work' : 'work'); }
        else if (arg === 'projectview') { state.approval = null; setMode('code'); }
        else { state.approval = null; setMode('chat'); state.thread = 'launch'; }
        renderAll(); $('.sidebar')?.classList.remove('open'); break; }
      case 'pick': state.pick = arg; renderApproval(); break;
      case 'approve': state.approval = 'done'; renderApproval(); toast('Approved (sample). Taskdriver would record the decision and Sales support would prepare the proposal.'); break;
      case 'back-work': state.approval = null; setMode('work'); break;
      case 'focus-search': $('[data-role="search"]')?.focus(); break;
      case 'palette': openPalette(arg || ''); break;
      case 'palette-pick': $('.palette')?.remove(); log(action, source); act(arg, 'palette'); return;
      case 'taskdriver-link': toast('Would open this record in Taskdriver (phone or web). Prototype: no link.'); break;
      case 'send': toast('Draft kept. Prototype: nothing sent to an agent.'); break;
      case 'voice': toast('Voice is off by default. A live session would start only after you press Start and see the connection confirmed.'); break;
      case 'copy': toast('Copied sample output (prototype).'); break;
      case 'clear': { const o = $('.terminal output'); if (o) o.textContent = 'View cleared. Saved conversation and task evidence remain.'; break; }
      case 'open-folder': toast('Would open the project folder on this Mac.'); break;
      case 'preview': toast('Would open the running preview.'); break;
      case 'close': $('.palette')?.remove(); $('.agent-menu') && ($('.agent-menu').hidden = true); break;
      default: break;
    }
    log(action, source);
  }
  function showCreate(on) { const c = $('.create-row'); if (c) c.hidden = !on; if (on) $('.create-row input')?.focus(); }

  // ---- wiring ------------------------------------------------------------------
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    if (b.tagName === 'A') e.preventDefault();
    act(b.dataset.action, 'click');
  });
  document.addEventListener('keydown', e => {
    const meta = e.metaKey || e.ctrlKey;
    if (e.target.closest('[role="radio"]') && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); act(e.target.dataset.action, 'kbd'); return; }
    if (meta && e.key === 'k') { e.preventDefault(); act('palette', 'kbd'); return; }
    if (meta && e.key === 'n') { e.preventDefault(); act('new-project', 'kbd'); return; }
    if (meta && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); act(['mode:chat', 'mode:work', 'mode:code'][+e.key - 1], 'kbd'); return; }
    if (e.key === '/' && !e.target.matches('input,textarea')) { e.preventDefault(); act(layout === 'c' ? 'palette' : 'focus-search', 'kbd'); return; }
    if (e.key === 'Escape') act('close', 'kbd');
  });
  $('[data-role="search"]')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase(); const list = $('.search-results'); if (!list) return;
    const hits = THREADS.filter(t => t.title.toLowerCase().includes(q));
    list.hidden = !q; list.innerHTML = hits.map(t => `<button class="nav-btn" data-action="thread:${t.id}">${t.title}<span class="k">${t.project}</span></button>`).join('') || '<span style="padding:8px;color:var(--dim)">No saved chat matches</span>';
    if (q.length === 1) log('search', 'type');
  });
  $('.create-row input')?.addEventListener('keydown', e => { if (e.key === 'Enter') act('confirm-project', 'kbd'); });

  // shared view bodies (identical markup in every layout; only the frame around them differs)
  const cv = $('.canvas[data-inject]');
  if (cv) cv.innerHTML = `
  <section class="view" data-view="chat">
    <div class="heading"><div><div class="eyebrow" data-bind="eyebrow"></div><h1><span data-bind="thread-title"></span><span class="period">.</span></h1></div>
      <span class="pill"><span class="spark" aria-hidden="true">✳</span> Astra <span style="color:var(--dim)">· your assistant</span></span></div>
    <div class="create-row" hidden style="display:flex;gap:8px;align-items:center;margin-bottom:16px"><input class="btn" style="flex:1" value="Harbour Studio launch" aria-label="Project name"><button class="btn primary" data-action="confirm-project">Create project</button></div>
    <div class="chat-layout">
      <div>
        <div class="bubble user" data-bind="user-msg"></div>
        <div class="speaker"><span class="spark" aria-hidden="true">✳</span>Astra · <img data-bind="agent-img" alt="" style="width:14px;height:14px;vertical-align:-3px"> <span data-bind="agent-name"></span> session</div>
        <div class="bubble" data-bind="answer"></div>
        <div class="attachment"><span class="mark">DOC</span><div><b>Launch brief</b><br><small style="color:var(--muted)">Sample document · ready to review</small></div><button class="btn act" data-action="taskdriver-link">Review</button></div>
        <div class="composer"><textarea aria-label="Message Astra" placeholder="Ask Astra, or think out loud…"></textarea>
          <div class="row"><button class="btn quiet" data-action="voice">🎙 Talk</button><button class="btn quiet" data-action="taskdriver-link" aria-label="Attach a file">＋</button><span style="margin-left:auto;color:var(--dim);font-size:12px">via <span data-bind="agent-name"></span></span><button class="btn primary" data-action="send">Send ↑</button></div></div>
        <p class="proto-note">Interactive concept · fictional work · no connected voice or agents · Astra is a placeholder name</p>
      </div>
      <aside class="context"><h2 data-bind="project-title"></h2><p>Keep the brief close. Bring in more context when the work needs it.</p>
        <button class="btn" data-action="open-folder">Project folder ↗<small>Briefs, assets and deliverables</small></button>
        <button class="btn" data-action="mode:work">What needs you<small>Decisions and results</small></button>
        <h2 style="margin-top:16px">Teammates on this project</h2>
        <button class="btn" data-action="taskdriver-link">Research<small>Finds sources, clarifies gaps</small></button>
        <button class="btn" data-action="taskdriver-link">Marketing<small>Turns the brief into drafts</small></button></aside>
    </div>
  </section>
  <section class="view" data-view="work" hidden>
    <div class="heading"><div><div class="eyebrow">Across your projects</div><h1>What's moving. What needs you<span class="period">.</span></h1><p class="eyebrow" style="margin-top:6px">The same tasks you see in Taskdriver on your phone.</p></div></div>
    <div class="work-grid"></div>
    <div class="approval-view" hidden></div>
  </section>
  <section class="view" data-view="code" hidden>
    <div class="heading"><div><div class="eyebrow">PaneForge / Improve the project view</div><h1>The details, when you need them<span class="period">.</span></h1></div><button class="btn" data-action="preview">Open preview ↗</button></div>
    <div class="code-layout">
      <aside class="files mono">src/
  components/
    ProjectView.tsx
    ProjectRow.tsx
tests/
  project-view</aside>
      <div class="editor"><header><img data-bind="agent-img" alt=""><span class="mono">ProjectView.tsx</span><span style="margin-left:auto">Proposed change · sample</span></header>
        <pre class="mono">// Illustrative code, not a repository change
function ProjectView({ project }) {
  return (
    &lt;Project title={project.name}&gt;
      &lt;Conversations items={project.conversations} /&gt;
      &lt;Deliverables items={project.deliverables} /&gt;
    &lt;/Project&gt;
  );
}</pre>
        <div class="terminal mono"><div class="actions"><button class="btn" data-action="copy">Copy output</button><button class="btn" data-action="clear">Clear view</button><button class="btn" data-action="open-folder">Open folder</button></div>
          <output>Example verification summary
Project navigation · passed in sample
Conversation history · passed in sample
These are illustrative results, not actual app tests.</output></div></div>
    </div>
  </section>`;

  // agent menu contents
  const menu = $('.agent-menu'); if (menu) menu.innerHTML = AGENTS.map(a => `<button role="menuitemradio" data-action="agent:${a.id}" aria-checked="${a.id === state.agent}"><img src="${BRANDS + a.img}" alt="">${a.id}</button>`).join('');

  renderAll();

  // ---- exposure for the headless check ------------------------------------
  window.__pfProto = {
    layout, state, SCRIPT, act,
    /* Perform the shared task using the layout's own controls (click path). Returns the tally. */
    runScript(path = 'click') {
      const paths = {
        a: ['new-project', 'confirm-project', 'agent-menu', 'agent:Claude', 'mode:work', 'open-approval', 'pick:focused', 'approve', 'focus-search', 'thread:review', 'mode:code'],
        b: ['new-project', 'confirm-project', 'agent-menu', 'agent:Claude', 'mode:work', 'open-approval', 'pick:focused', 'approve', 'focus-search', 'thread:review', 'mode:code'],
        c: ['new-project', 'confirm-project', 'agent-menu', 'agent:Claude', 'task:scope', 'pick:focused', 'approve', 'thread:review', 'task:projectview'],
        kbd: ['new-project', 'confirm-project', 'palette-pick:agent:Claude', 'palette-pick:open-task:scope', 'pick:focused', 'approve', 'palette-pick:thread:review', 'palette-pick:mode:code'],
      };
      const seq = paths[path === 'click' ? layout : path] || paths.a;
      for (const a of seq) {
        const el = document.querySelector(`[data-action="${a}"]`);
        if (a.startsWith('palette-pick:')) { act('palette', 'kbd'); const b = document.querySelector(`[data-action="${a}"]`); if (!b) throw new Error('palette has no ' + a); b.click(); continue; }
        if (!el && a === 'focus-search') { act(a, 'kbd'); continue; } // the search box is an input, reached by `/` or a click on it
        if (!el) throw new Error(`layout ${layout}: no control for ${a} while on mode ${state.mode}`);
        if (el.offsetParent === null && !el.closest('.sidebar')) throw new Error(`layout ${layout}: control ${a} is not visible`);
        el.click();
      }
      return this.tally();
    },
    tally() { return { layout, done: state.done, steps: state.step, actions: state.log.length, wrongTurns: state.wrongTurns, recoveries: state.recoveries, stepMs: state.stepMs, log: state.log }; },
  };
})();
