import fs from 'node:fs'

const [x64File, armFile, outFile] = process.argv.slice(2)
if (!x64File || !armFile || !outFile) {
  console.error('Aufruf: node scripts/merge-update-info.mjs <x64.yml> <arm64.yml> <out.yml>')
  process.exit(1)
}

const x64Text = fs.readFileSync(x64File, 'utf8')
const armText = fs.readFileSync(armFile, 'utf8')

function extractFilesBlock(yamlText) {
  const lines = yamlText.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === 'files:')
  if (start === -1) return []
  const entries = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break
    entries.push(lines[i])
  }
  return entries
}

const armEntries = extractFilesBlock(armText)
const x64Lines = x64Text.split(/\r?\n/)
const outLines = []
let inserted = false

for (let i = 0; i < x64Lines.length; i += 1) {
  if (!inserted && i > 0 && /^\S/.test(x64Lines[i]) && x64Lines.slice(0, i).some((l) => l.trim() === 'files:')) {
    outLines.push(...armEntries)
    inserted = true
  }
  outLines.push(x64Lines[i])
}
if (!inserted) outLines.push(...armEntries)

fs.writeFileSync(outFile, outLines.join('\n'))
