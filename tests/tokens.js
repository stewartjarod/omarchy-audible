#!/usr/bin/env node
"use strict"
// Token-existence check: every `Color.x.y`, `Style.x.y`, `Util.x`, `Border.x` this plugin reads must
// exist in the Commons singletons of the Omarchy shell it will run on. When Omarchy renames or
// removes a token the plugin silently loses that colour/size at runtime (QML only warns); this
// catches it at test time instead.
//
//   node tests/tokens.js [--commons DIR] [--root DIR]
//
// Commons directory: --commons, else $OMARCHY_COMMONS, else $OMARCHY_PATH/shell/Commons, else
// /usr/share/omarchy/shell/Commons. Exit 0 ok, 1 unknown tokens, 2 Commons not found (skipped).
const fs = require("fs")
const path = require("path")

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}

const ROOT = path.resolve(arg("--root", path.join(__dirname, "..")))
const COMMONS = arg("--commons",
  process.env.OMARCHY_COMMONS ||
  path.join(process.env.OMARCHY_PATH || "/usr/share/omarchy", "shell", "Commons"))

const SINGLETONS = ["Color", "Style", "Util", "Border"]

function strip(line) {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/\/\/.*$/, "")
}

// Collect the member paths of one singleton file: "bar", "bar.text", "font.family", "space", ...
function members(file) {
  const out = new Set()
  const stack = [] // entries: { path: "bar" } for a named QtObject group, or { path: null } for any other block
  const lines = fs.readFileSync(file, "utf8").split("\n")
  for (const raw of lines) {
    const line = strip(raw)
    const top = stack.length ? stack[stack.length - 1] : null
    let group = null
    // Members only count directly inside the root object or inside a named group.
    const atRoot = stack.length === 1
    const inGroup = top && top.path !== null && stack.length > 1
    if (atRoot || inGroup) {
      const prefix = atRoot ? "" : top.path + "."
      let m = line.match(/^\s*(?:readonly\s+|default\s+|required\s+)*property\s+(?:var|real|int|bool|string|color|url|double|list<[^>]+>|\w+)\s+(\w+)/)
      if (m) {
        out.add(prefix + m[1])
        if (/property\s+QtObject\s/.test(line)) group = prefix + m[1]
      }
      m = line.match(/^\s*(?:function|signal)\s+(\w+)/)
      if (m) out.add(prefix + m[1])
    }
    let first = true
    for (const ch of line) {
      if (ch === "{") { stack.push({ path: first && group ? group : null }); first = false }
      else if (ch === "}") stack.pop()
    }
  }
  return out
}

function loadCommons(dir) {
  const map = {}
  for (const name of SINGLETONS) {
    const f = path.join(dir, name + ".qml")
    if (fs.existsSync(f)) map[name] = members(f)
  }
  return map
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "tests", ".omarchy-ref"].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.(qml|js)$/.test(e.name)) acc.push(p)
  }
  return acc
}

if (!fs.existsSync(COMMONS)) {
  console.log("tokens: Commons not found at " + COMMONS + " (set OMARCHY_COMMONS or run tests/fetch-commons.sh); skipped")
  process.exit(2)
}

const known = loadCommons(COMMONS)
const missingFiles = SINGLETONS.filter((n) => !known[n])
const errors = []
let checked = 0

for (const file of walk(ROOT, [])) {
  const text = fs.readFileSync(file, "utf8")
  // Only files that import the Commons singletons can mean them (QML) or are plain models (JS: skip).
  if (!file.endsWith(".qml") || !/import\s+qs\.Commons/.test(text)) continue
  text.split("\n").forEach((raw, i) => {
    const line = strip(raw)
    const re = /(?<![\w.])(Color|Style|Util|Border)((?:\.[A-Za-z_]\w*)+)/g
    let m
    while ((m = re.exec(line))) {
      const single = m[1]
      if (!known[single]) continue
      const segs = m[2].slice(1).split(".")
      let p = ""
      for (const seg of segs) {
        p = p ? p + "." + seg : seg
        if (!known[single].has(p)) {
          errors.push(path.relative(ROOT, file) + ":" + (i + 1) + "  " + single + "." + p + "  (not in Commons/" + single + ".qml)")
          break
        }
        // a leaf (property/function) ends the chain; only groups continue
        const isGroup = [...known[single]].some((k) => k.startsWith(p + "."))
        if (!isGroup) break
      }
      checked++
    }
  })
}

if (missingFiles.length) console.log("tokens: note: no " + missingFiles.join(", ") + ".qml in " + COMMONS)
if (errors.length) {
  console.log("tokens: " + errors.length + " token(s) this shell does not provide:")
  for (const e of errors) console.log("  " + e)
  process.exit(1)
}
console.log("tokens: " + checked + " token reference(s) all exist in " + COMMONS)
