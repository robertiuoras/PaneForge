// Just enough electron for a main-side module that only needs userData.
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-electron-stub-'))
module.exports = { app: { getPath: () => dir } }
