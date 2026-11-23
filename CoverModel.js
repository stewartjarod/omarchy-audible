.pragma library

// Book covers. Pure: builds names and argv, runs nothing.
//
// No remote URL ever reaches a QML Image. Qt's pixmap loader reads the whole HTTP reply into memory
// before decoding, and sourceSize does not cap that download, so a hostile or broken cover host could
// grow the shared shell's memory without bound (marketplace review, 2026-10-22). Instead a cover is
// fetched once into a private cache with a hard byte ceiling, checked to be a JPEG or PNG, and the
// Image only ever loads the local file.
//
// The URL names the book, and any local user can read a process's arguments, so it goes to curl on
// stdin (`curl -K -`), never on a command line. The cache file is named by a hash of the URL, also
// passed on stdin; the command line holds only the cache directory.

var MAX_BYTES = 2 * 1024 * 1024      // real covers are 30-100 KB
var DEADLINE_SEC = 30
var CURL_MAX_TIME_SEC = 20
var MAX_PARALLEL = 4

// https only, and only characters that need no quoting inside a curl config string.
function isRemote(url) {
  return typeof url === "string" && url.length <= 2048 &&
    /^https:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]+$/.test(url)
}

function isLocalFile(url) {
  return typeof url === "string" && /^file:\/\//.test(url)
}

// 64-bit FNV-1a as 16 hex digits (two 32-bit halves with different offsets). A cache key, not a
// security boundary: a collision shows the wrong cover.
function cacheName(url) {
  var s = String(url)
  var h1 = 0x811c9dc5, h2 = 0xcbf29ce4
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0
    h2 = (h2 ^ (h1 >>> 7)) >>> 0
  }
  return ("0000000" + h1.toString(16)).slice(-8) + ("0000000" + h2.toString(16)).slice(-8)
}

function isCacheName(name) {
  return typeof name === "string" && /^[0-9a-f]{16}$/.test(name)
}

function cachePath(dir, url) {
  return String(dir) + "/" + cacheName(url) + ".img"
}

// stdin for fetchArgs: the cache name, then a curl config naming the URL.
function fetchInput(url) {
  if (!isRemote(url)) return ""
  return cacheName(url) + "\n" + "url = \"" + url + "\"\n"
}

// Fetch one cover into dir. Exit 0 when the file is in place (already cached or fetched), non-zero
// otherwise. The directory is made owner-only and must not be a symlink; the download lands in a
// mktemp file in the same directory and is renamed into place only when curl succeeded, the reply
// fits the ceiling (head cuts it at MAX+1 bytes, so an endless reply ends there) and it starts with
// a JPEG or PNG signature.
function fetchArgs(dir) {
  var max = MAX_BYTES
  return ["sh", "-c",
    "umask 077; d=$1; " +
    "[ -L \"$d\" ] && exit 1; mkdir -p -m 700 -- \"$d\" && [ -O \"$d\" ] && [ ! -L \"$d\" ] && chmod 700 -- \"$d\" || exit 1; " +
    "IFS= read -r name || exit 1; " +
    "case $name in ''|*[!0-9a-f]*) exit 1;; esac; [ ${#name} -eq 16 ] || exit 1; " +
    "dest=\"$d/$name.img\"; " +
    "[ -f \"$dest\" ] && [ ! -L \"$dest\" ] && exit 0; " +
    "tmp=$(mktemp \"$d/.part.XXXXXX\") || exit 1; trap 'rm -f -- \"$tmp\"' EXIT; " +
    "rc=$( { { curl -fsS --proto '=https' --proto-redir '=https' --max-redirs 3 --max-time " + CURL_MAX_TIME_SEC +
    " --max-filesize " + max + " -K - -o - 3>&-; echo $? >&3; } | head -c " + (max + 1) + " >\"$tmp\"; } 3>&1 ); " +
    "[ \"$rc\" = 0 ] || exit 1; " +
    "size=$(wc -c <\"$tmp\"); [ \"$size\" -gt 0 ] && [ \"$size\" -le " + max + " ] || exit 1; " +
    "sig=$(head -c 4 \"$tmp\" | od -An -tx1 | tr -d ' \\n'); " +
    "case $sig in ffd8ff*|89504e47) ;; *) exit 1;; esac; " +
    "mv -f -- \"$tmp\" \"$dest\"",
    "sh", String(dir)]
}

// Lists the cache names already on disk (one per line), so a restart does not fetch them again.
function listArgs(dir) {
  return ["sh", "-c",
    "[ -d \"$1\" ] && [ ! -L \"$1\" ] || exit 0; find \"$1\" -maxdepth 1 -type f -name '*.img' -printf '%f\\n'",
    "sh", String(dir)]
}

function parseList(out) {
  var names = {}
  var lines = String(out || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var n = lines[i].replace(/\.img$/, "")
    if (isCacheName(n)) names[n] = true
  }
  return names
}

if (typeof module !== "undefined") module.exports = {
  MAX_BYTES, DEADLINE_SEC, MAX_PARALLEL, isRemote, isLocalFile, cacheName, isCacheName, cachePath,
  fetchInput, fetchArgs, listArgs, parseList
}
