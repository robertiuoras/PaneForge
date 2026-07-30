// Per-project task board and shared memory.
//
// Both live inside the project folder, in `.paneforge/`, not in the app's own
// data directory. That is the whole point: an agent running in that folder can
// `cat .paneforge/MEMORY.md` and read what the other panes decided, and the
// files travel with the repo if you choose to commit them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectBoard, TaskItem } from '../shared/types'

const FOLDER = '.paneforge'
const TASKS = 'tasks.json'
const MEMORY = 'MEMORY.md'

const MEMORY_HEADER = `# Shared memory

Written by you and by the agents running in this folder through PaneForge.
Anything here is context every pane is told to read before starting work.

`

// Ignores the whole folder, itself included, so nothing here reaches a commit unless
// somebody deletes this file on purpose.
const IGNORE = `# Written by PaneForge: shared notes between the agents running in this folder.
# Free text, so treat it as private. Delete this file if you want it committed.
*
`

function boardDir(path: string): string {
  return join(path, FOLDER)
}

export function memoryPath(path: string): string {
  return join(boardDir(path), MEMORY)
}

export function tasksPath(path: string): string {
  return join(boardDir(path), TASKS)
}

export function readBoard(path: string): ProjectBoard {
  return {
    path,
    tasks: readTasks(path),
    memory: readMemory(path),
    memoryPath: memoryPath(path)
  }
}

function readTasks(path: string): TaskItem[] {
  try {
    const raw = JSON.parse(readFileSync(tasksPath(path), 'utf8')) as TaskItem[]
    return Array.isArray(raw) ? raw.filter((t) => t && typeof t.id === 'string') : []
  } catch {
    return []
  }
}

function readMemory(path: string): string {
  try {
    return readFileSync(memoryPath(path), 'utf8')
  } catch {
    return ''
  }
}

export function writeTasks(path: string, tasks: TaskItem[]): ProjectBoard {
  ensure(path)
  try {
    writeFileSync(tasksPath(path), JSON.stringify(tasks, null, 2), 'utf8')
  } catch {
    /* read-only project folder - the UI keeps the in-memory copy */
  }
  return readBoard(path)
}

export function writeMemory(path: string, memory: string): ProjectBoard {
  ensure(path)
  try {
    writeFileSync(memoryPath(path), memory, 'utf8')
  } catch {
    /* read-only project folder */
  }
  return readBoard(path)
}

/**
 * The line handed to every agent PaneForge starts in a folder that has memory,
 * so panes stop rediscovering the same decisions. Empty when there is nothing
 * worth reading, so a fresh project gets no noise.
 */
export function memoryPrelude(path: string): string {
  const text = readMemory(path).replace(MEMORY_HEADER, '').trim()
  if (!text) return ''
  return `First read ${FOLDER}/${MEMORY} in this folder - it is shared context from the other agents working here.`
}

function ensure(path: string): void {
  try {
    mkdirSync(boardDir(path), { recursive: true })
    const mem = memoryPath(path)
    if (!existsSync(mem)) writeFileSync(mem, MEMORY_HEADER, 'utf8')
    // This folder is created inside whatever project a pane was opened in, and what
    // lands in it is free text several agents write to each other - the place a pasted
    // key or a private detail ends up. PaneForge put it in someone else's repo, so
    // PaneForge is what keeps it out of their next commit; opting in is deleting a
    // file, which is easier than noticing a folder you never made.
    const ig = join(boardDir(path), '.gitignore')
    if (!existsSync(ig)) writeFileSync(ig, IGNORE, 'utf8')
  } catch {
    /* unwritable - callers already tolerate a failed write */
  }
}
