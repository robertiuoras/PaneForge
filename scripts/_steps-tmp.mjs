import { diffCommits } from './try-diff.mjs'
import { buildSteps } from '../src/shared/tour.ts'
const root = new URL('..', import.meta.url).pathname
const { commits } = diffCommits(root)
const steps = buildSteps(commits)
steps.forEach((s,i)=>console.log(`${i+1}. [${s.open}|${s.spot||'-'}] ${s.text}\n     where=${s.where} checks=${s.checks.length}`))
