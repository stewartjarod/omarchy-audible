.pragma library

// Audible API requests that keep the request off the command line. Another local user can read any
// process's argv through /proc/<pid>/cmdline, and API paths, queries and bodies name books (ASINs)
// and listening positions. So a request is a plain spec, and the process only ever runs
//   timeout 120 audible api --request-file /dev/stdin -o json
// with the method, path, query and body written to its stdin as a TOML request file (the CLI's own
// `--save-request` format). /proc/<pid>/environ and the stdin pipe are owner-only.
//
// spec: { api: true, method: "GET" | "PUT" | "POST" | "DELETE", path: "/1.0/...",
//         query: { name: string }, body: object }   (query and body optional; one value per query name,
//         which is all the request file format can hold)

var DEADLINE_SEC = 120   // an API call that takes longer than this is stuck; the caller sees a failure
var METHODS = { GET: true, PUT: true, POST: true, DELETE: true }

function request(method, path, query, body) {
  var spec = { api: true, method: method, path: path }
  if (query) spec.query = query
  if (body !== undefined) spec.body = body
  return spec
}

function isRequest(x) {
  return !!x && typeof x === "object" && !Array.isArray(x) && x.api === true
}

// TOML basic strings take JSON's string escapes, so JSON.stringify writes a valid TOML string.
function tomlString(s) { return JSON.stringify(String(s)) }

function toToml(spec) {
  if (!isRequest(spec) || !METHODS[spec.method]) throw new Error("not an API request")
  var path = String(spec.path || "")
  if (!/^\/1\.0\/[A-Za-z0-9_\/.!-]+$/.test(path)) throw new Error("not an API path")
  var lines = ["method = " + tomlString(spec.method), "path = " + tomlString(path)]
  if (spec.body !== undefined) lines.push("body = " + tomlString(JSON.stringify(spec.body)))
  var q = spec.query || {}
  var keys = Object.keys(q)
  if (keys.length) {
    lines.push("", "[query]")
    for (var i = 0; i < keys.length; i++) {
      if (!/^[A-Za-z0-9_]+$/.test(keys[i])) throw new Error("not a query name")
      lines.push(keys[i] + " = " + tomlString(q[keys[i]]))
    }
  }
  return lines.join("\n") + "\n"
}

// -> { argv, input }: what Service.run starts, and what it writes to the process's stdin.
function toProcess(spec) {
  return {
    argv: ["timeout", String(DEADLINE_SEC), "audible", "api", "--request-file", "/dev/stdin", "-o", "json"],
    input: toToml(spec)
  }
}

if (typeof module !== "undefined") module.exports = { DEADLINE_SEC, request, isRequest, toToml, toProcess }
