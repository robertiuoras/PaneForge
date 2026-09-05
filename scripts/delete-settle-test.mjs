// Run the shipped delayed correction against slow/stale CLI frames.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync, transformSync } from "esbuild";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  join(root, "src/renderer/src/components/TerminalPane.tsx"),
  "utf8",
);
const from = source.indexOf("        const owed = (): void => {");
assert.ok(from >= 0);
const end = source.indexOf("\n        window.setTimeout(owed", from);
const code = transformSync(source.slice(from, end), { loader: "ts" }).code;
const build = buildSync({
  entryPoints: [join(root, "src/shared/cursorMove.ts")],
  bundle: true,
  format: "esm",
  write: false,
});
const { leftoverBackspaces } = await import(
  "data:text/javascript;base64," +
    Buffer.from(build.outputFiles[0].text).toString("base64")
);
let cases = 0;
function fixture({ before = 10, want = 0, rowsCrossed = 1, wholeInput = true } = {}) {
  const state = {
    seen: before,
    typedAt: { current: 0 },
    revision: { current: 1 },
    sent: [],
  };
  const owed = new Function(
    "wholeInput",
    "typedAt",
    "keyRevision",
    "sentRevision",
    "sentAt",
    "composerLength",
    "before",
    "want",
    "rowsCrossed",
    "leftoverBackspaces",
    "sendKeys",
    "BACKSPACE",
    code + "; return owed",
  )(
    wholeInput,
    state.typedAt,
    state.revision,
    1,
    100,
    () => state.seen,
    before,
    want,
    rowsCrossed,
    leftoverBackspaces,
    (keys) => {
      state.sent.push(keys);
      state.revision.current++;
    },
    "\x7f",
  );
  return { state, owed };
}
{
  const { state, owed } = fixture({ before: 10, want: 9, rowsCrossed: 0 });
  owed();
  owed();
  assert.deepEqual(
    state.sent,
    [],
    "unchanged frame must not repeat a single-character delete",
  );
  cases++;
}
{
  const { state, owed } = fixture();
  state.seen = 1;
  owed();
  owed();
  assert.deepEqual(
    state.sent,
    ["\x7f"],
    "two timers on one stale leftover send one correction",
  );
  cases++;
}
{
  const { state, owed } = fixture();
  state.seen = 1;
  state.revision.current++;
  owed();
  assert.deepEqual(
    state.sent,
    [],
    "a later app cursor move/delete cancels old correction",
  );
  cases++;
}
{
  const { state, owed } = fixture();
  state.seen = 1;
  state.typedAt.current = 101;
  owed();
  assert.deepEqual(state.sent, [], "typing cancels old correction");
  cases++;
}
{
  const { state, owed } = fixture();
  owed();
  state.seen = 0;
  owed();
  assert.deepEqual(
    state.sent,
    [],
    "late successful redraw needs no correction",
  );
  cases++;
}
console.log(`delete settle: ${cases} behavioral cases passed`);

{
 const {state,owed}=fixture({before:192,want:155,wholeInput:false});
 state.seen=156; owed(); owed();
 assert.deepEqual(state.sent,[], 'suffix reflow must not delete an unselected wrap space'); cases++;
}
console.log(`delete settle including partial selection: ${cases} cases passed`);
