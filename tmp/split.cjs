var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/split.ts
var split_exports = {};
__export(split_exports, {
  MAX_LANES: () => MAX_LANES,
  MIN_LANES: () => MIN_LANES,
  laneBrief: () => laneBrief,
  parsePlan: () => parsePlan,
  splitPayload: () => splitPayload
});
module.exports = __toCommonJS(split_exports);

// src/shared/promptSchema.ts
var ESC = String.fromCharCode(27);
var CTRL_U = String.fromCharCode(21);
var PASTE_START = ESC + "[200~";
var PASTE_END = ESC + "[201~";
var OSC = new RegExp(ESC + "\\][^\\u0007]*(?:\\u0007|" + ESC + "\\\\)", "g");
var CSI = new RegExp(ESC + "[[\\]()#;?]*[0-9;?]*[ -/]*[@-~]", "g");
var BARE_ESC = new RegExp(ESC, "g");
var C0_EXCEPT_NEWLINE = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f]", "g");
var PASTE_MARKERS = new RegExp("\\u001b?\\[20[01]~", "g");
function extractJson(stdout) {
  const text = stdout.replace(OSC, "").replace(CSI, "");
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const candidates = fence ? [fence[1], text] : [text];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

// src/main/split.ts
var MIN_LANES = 2;
var MAX_LANES = 4;
var BRIEF_LIMIT = 1200;
var NAME_LIMIT = 60;
var OWNS_LIMIT = 24;
function splitPayload(mission, files = []) {
  const tree = files.length ? `
Top-level entries in the repository:
${files.slice(0, 60).join("\n")}
` : "";
  return [
    "You are planning how to build one task with several coding agents at the same time.",
    "Each agent gets its OWN git worktree - a separate checkout of this repository - so",
    "two agents can never edit the same file. That is also the constraint: a file can be",
    "owned by exactly one workstream.",
    "",
    `Task:
${mission.trim()}`,
    tree,
    "Answer with JSON and nothing else, in this shape:",
    '{"contracts":"...","lanes":[{"name":"...","brief":"...","owns":["src/x.ts","src/y/"]}]}',
    "",
    `- Between ${MIN_LANES} and ${MAX_LANES} lanes. Each is a deliverable someone could finish alone.`,
    '- "owns" lists the repo-relative files or directories that workstream will write.',
    "  These MUST NOT overlap between lanes, not even by containing directory. If two",
    "  workstreams both need one file, they are one workstream.",
    '- "brief" is what that agent should build, standalone: it will not see the others.',
    '- "contracts" is what all lanes must agree on before they start - shared types,',
    '  config keys, function signatures, test script names. Leave "" if there are none.',
    "",
    "If the work cannot be split - the steps feed each other, it is one feature, it is",
    "small, or everything touches one file - answer exactly:",
    '{"refused":"<one sentence saying why>"}'
  ].join("\n");
}
function normalise(p) {
  let s = String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  s = s.replace(/\/\*+$/, "");
  return s === "." || s === "*" ? "" : s;
}
function collide(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const wild = (s) => s.split("*")[0].replace(/\/+$/, "");
  const x = wild(a);
  const y = wild(b);
  if (!x || !y) return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
function escapes(p) {
  return !p || p.startsWith("/") || /^[a-z]:/i.test(p) || p.split("/").includes("..");
}
function parsePlan(text) {
  const none = (refused) => ({ lanes: [], contracts: "", refused });
  const parsed = extractJson(text ?? "");
  if (!parsed || typeof parsed !== "object")
    return none("The planner did not answer with a plan.");
  const raw = parsed;
  if (typeof raw.refused === "string" && raw.refused.trim())
    return none(raw.refused.trim().slice(0, 300));
  const list = Array.isArray(raw.lanes) ? raw.lanes : [];
  const lanes = [];
  const seenName = /* @__PURE__ */ new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const l = item;
    const name = String(l.name ?? "").trim().slice(0, NAME_LIMIT);
    const brief = String(l.brief ?? "").trim().slice(0, BRIEF_LIMIT);
    if (!name || !brief) continue;
    const key = name.toLowerCase();
    if (seenName.has(key)) continue;
    const owns = [];
    for (const o of Array.isArray(l.owns) ? l.owns : []) {
      const n = normalise(String(o));
      if (!n) return none(`\u201C${name}\u201D claims the whole repository - that is not a lane.`);
      if (escapes(n)) return none(`A lane claimed a path outside the project: ${String(o)}`);
      if (!owns.includes(n)) owns.push(n);
      if (owns.length >= OWNS_LIMIT) break;
    }
    if (!owns.length) continue;
    seenName.add(key);
    lanes.push({ name, brief, owns });
    if (lanes.length >= MAX_LANES) break;
  }
  if (lanes.length < MIN_LANES)
    return none("There is only one workstream here - build it in this pane.");
  for (let i = 0; i < lanes.length; i++)
    for (let j = i + 1; j < lanes.length; j++)
      for (const a of lanes[i].owns)
        for (const b of lanes[j].owns)
          if (collide(a, b))
            return none(
              `\u201C${lanes[i].name}\u201D and \u201C${lanes[j].name}\u201D both own ${a === b ? a : `${a} and ${b}`} - that is one workstream, not two.`
            );
  return {
    lanes,
    contracts: String(raw.contracts ?? "").trim().slice(0, BRIEF_LIMIT)
  };
}
function laneBrief(plan, index, mission) {
  const me = plan.lanes[index];
  const others = plan.lanes.filter((_, i) => i !== index);
  return [
    `You are one of ${plan.lanes.length} agents building this in parallel, each in its own git worktree of this repository.`,
    `The whole task: ${mission.trim()}`,
    "",
    `Your workstream: ${me.name}`,
    me.brief,
    "",
    `You own these paths and may edit them: ${me.owns.join(", ")}.`,
    others.length ? `Owned by other agents you cannot see - do not edit, do not fix, leave a note in your final message instead: ${others.map((o) => `${o.name} (${o.owns.join(", ")})`).join("; ")}.` : "",
    plan.contracts ? `Agreed with the other agents before anyone started - implement exactly this, do not redesign it: ${plan.contracts}` : "",
    "Commit your work on this worktree\u2019s own branch when it is done and verified. Do not merge, do not release, do not touch another branch."
  ].filter(Boolean).join("\n");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_LANES,
  MIN_LANES,
  laneBrief,
  parsePlan,
  splitPayload
});
