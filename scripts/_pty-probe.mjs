import { spawn } from '@lydell/node-pty'
import { execFileSync } from 'node:child_process'

const p = spawn(process.env.SHELL || '/bin/zsh', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
let out = ''
p.onData(d => { out += d })
const table = () => execFileSync('ps', ['-Ao', 'pid=,ppid=,etime=,command='], { maxBuffer: 16e6 }).toString()
const rows = () => table().split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
const kids = (pid) => rows().filter(m => Number(m[2]) === pid).map(m => `${m[1]} etime=${m[3]} ${m[4].slice(0,60)}`)
const wait = ms => new Promise(r => setTimeout(r, ms))
await wait(1200)
console.log('pty pid', p.pid, 'pty.process idle =', JSON.stringify(p.process))
console.log('children idle:', kids(p.pid))
p.write('sleep 20\r')
await wait(1500)
console.log('pty.process running =', JSON.stringify(p.process))
console.log('children running:', kids(p.pid))
p.kill()
process.exit(0)
