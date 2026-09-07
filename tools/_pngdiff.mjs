// Pixel-diff the same filenames across two capture directories.
//
//   node tools/_pngdiff.mjs dirA dirB frame.png [frame.png ...]
//
// For comparing a frozen copy of `shots/` against a fresh one — which is how any
// honest A/B on the visual gates has to be structured, since another session
// rebuilds `dist/` under a capture run. See tools/_det.mjs.
import fs from 'node:fs'
import { PNG } from 'pngjs'
const read = (p) => PNG.sync.read(fs.readFileSync(p))
for (const name of process.argv.slice(4)) {
  const a = read(`${process.argv[2]}/${name}`), b = read(`${process.argv[3]}/${name}`)
  let n = 0, sum = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i+1] - b.data[i+1]) + Math.abs(a.data[i+2] - b.data[i+2])
    if (d > 6) n++
    sum += d
  }
  const px = a.data.length / 4
  console.log(`${name.padEnd(24)} pixels differing >6: ${(100*n/px).toFixed(2)}%   mean |d| ${(sum/px/3).toFixed(2)}`)
}
