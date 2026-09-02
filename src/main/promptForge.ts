// Where the exemplars come from: Robert's own prompt library, on disk.
//
// `shared/promptForge.ts` is pure because the renderer imports it. This file is the disk
// half - it reads `claude-config/promptlib`, the 12 templates mined off 1,482 of his real
// prompts, and turns one into a `ForgeTemplate`. A machine without the library is not a
// failure: `builtInTemplate` answers instead and the prompt is forged with no example in
// it, which is exactly what every prompt in this app did before today.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectsRoot } from "./config";
import {
  builtInTemplate,
  readPromptlibTemplate,
  type ForgeTemplate,
} from "../shared/promptForge";

/** How long a template reading is trusted. The library changes when Robert edits it. */
const CACHE_MS = 5 * 60_000;

/**
 * Where the library lives.
 *
 * Under the projects root, which is already a validated config value (`projectsRoot()`
 * falls back when the saved one vanished). `PF_PROMPTLIB` overrides it, which is how the
 * test points at a fixture rather than at whatever this machine happens to have.
 */
export function promptlibDir(): string {
  return (
    process.env.PF_PROMPTLIB ||
    join(projectsRoot(), "claude-memory", "claude-config", "promptlib")
  );
}

const cache = new Map<string, { at: number; template: ForgeTemplate | null }>();

/**
 * The template with this id, from disk, or the copy this app ships.
 *
 * The parse is `readPromptlibTemplate` in shared, so it is a node test away rather than
 * behind an electron import. This file is the path, the read and the cache.
 */
export function loadTemplate(
  id: string,
  now = Date.now(),
): ForgeTemplate | null {
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_MS) return hit.template;
  let template = builtInTemplate(id);
  const file = join(promptlibDir(), "templates", `${id}.md`);
  try {
    if (existsSync(file) && statSync(file).isFile()) {
      template =
        readPromptlibTemplate(id, readFileSync(file, "utf8")) ?? template;
    }
  } catch {
    /* unreadable is not evidence about the prompt - the built-in copy answers */
  }
  cache.set(id, { at: now, template });
  return template;
}

/** Forget what was read. `config:set` moving the projects root invalidates every path. */
export function forgetTemplates(): void {
  cache.clear();
}
