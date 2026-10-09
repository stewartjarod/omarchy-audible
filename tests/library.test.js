// Run: node --test tests/library.test.js   (from ~/Projects/jarod-audible)
"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// LibraryModel.js starts with `.pragma library` (a QML directive). Node cannot parse that line,
// so swap it for a comment with the same length and evaluate the file in this realm.
function loadModel() {
  const file = path.join(__dirname, "..", "LibraryModel.js")
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library/, "//")
  const m = { exports: {} }
  new Function("module", "exports", src)(m, m.exports)
  return m.exports
}

const L = loadModel()
const RAW_TEXT = fs.readFileSync(path.join(__dirname, "..", "fixtures", "library-api.json"), "utf8")
const RAW = JSON.parse(RAW_TEXT)
const FIXTURE = L.parseApiPage(RAW_TEXT)
const BOOKS = FIXTURE.books
const BY = Object.fromEntries(BOOKS.map(b => [b.asin, b]))
const rawItem = asin => RAW.result.items.find(i => i.asin === asin)

function book(overrides) {
  return Object.assign({
    asin: "X", title: "Title", subtitle: "", authors: [], author: "", narrators: [],
    coverUrl: "", runtimeSec: 3600, series: null, percentComplete: 0, remainingSec: 0,
    finished: false, listenable: true, releaseDate: "", purchaseDate: "",
    local: false, download: null, resumeSec: 0, lastListenedAt: 0
  }, overrides)
}

// ---------------------------------------------------------------- parseApiPage

test("parseApiPage reads the whole fixture", () => {
  assert.equal(FIXTURE.error, null)
  assert.equal(BOOKS.length, 40)
  assert.equal(new Set(BOOKS.map(b => b.asin)).size, 40)
})

test("parseApiPage: invalid JSON returns empty books and an error", () => {
  const r = L.parseApiPage("{not json")
  assert.deepEqual(r.books, [])
  assert.equal(typeof r.error, "string")
  assert.ok(r.error.length > 0)
})

test("parseApiPage: CLI error envelope surfaces the message", () => {
  const r = L.parseApiPage(JSON.stringify({ error: { message: "is locked" }, result: null }))
  assert.deepEqual(r.books, [])
  assert.equal(r.error, "is locked")
})

test("parseApiPage: string error envelope", () => {
  assert.equal(L.parseApiPage({ error: "boom" }).error, "boom")
})

test("parseApiPage: empty and non-object input never throws", () => {
  for (const input of [null, undefined, 42, "", true]) {
    const r = L.parseApiPage(input)
    assert.deepEqual(r.books, [])
    assert.equal(typeof r.error, "string")
  }
})

test("parseApiPage: empty result is a valid empty library", () => {
  assert.deepEqual(L.parseApiPage(JSON.stringify({ error: null, result: { items: [] } })), { books: [], error: null })
  assert.deepEqual(L.parseApiPage(JSON.stringify({ error: null, result: [] })), { books: [], error: null })
})

test("parseApiPage: result without items is an error", () => {
  const r = L.parseApiPage(JSON.stringify({ error: null, result: { nope: 1 } }))
  assert.deepEqual(r.books, [])
  assert.ok(r.error)
})

test("parseApiPage: accepts bare {items} and bare array shapes", () => {
  assert.equal(L.parseApiPage({ items: RAW.result.items }).books.length, 40)
  assert.equal(L.parseApiPage(RAW.result.items).books.length, 40)
})

test("parseApiPage: skips junk items and duplicate asins", () => {
  const items = [null, 7, "x", { title: "no asin" }, rawItem("B0DTRR458T"), rawItem("B0DTRR458T")]
  const r = L.parseApiPage({ result: { items } })
  assert.equal(r.books.length, 1)
  assert.equal(r.books[0].asin, "B0DTRR458T")
})

// ---------------------------------------------------------------- normalize

test("normalize maps the first fixture item exactly", () => {
  assert.deepEqual(BY["B0DTRR458T"], {
    asin: "B0DTRR458T",
    title: "Never Ask for the Sale",
    subtitle: "Supercharge Your Business with the Power of Passionate Ambivalence",
    authors: ["Sue Heilbronner"],
    author: "Sue Heilbronner",
    narrators: ["Sue Heilbronner"],
    coverUrl: "https://m.media-amazon.com/images/I/51ozMq2TXvL._SL500_.jpg",
    runtimeSec: 30660,
    series: null,
    percentComplete: 0,
    remainingSec: 30660,
    finished: false,
    finishedAt: 0,
    description: "A tech leader and executive coach's actionable guide for anyone looking to supercharge their selling prowess and close the deal with authenticity and integrity. Sue Heilbronner launched an executive coaching, facilitation, and speaking solo",
    publisher: "Balance",
    rating: 0,
    ratingCount: 0,
    format: "",
    listenable: true,
    releaseDate: "2025-09-09",
    purchaseDate: "2025-11-04T16:25:23.271Z",
    local: false,
    download: null,
    resumeSec: 0,
    lastListenedAt: 0
  })
})

test("normalize: every fixture item yields a Book with the full shape", () => {
  const keys = Object.keys(BOOKS[0]).sort()
  for (const b of BOOKS) {
    assert.deepEqual(Object.keys(b).sort(), keys, b.asin)
    assert.equal(typeof b.title, "string")
    assert.ok(b.title.length > 0)
    assert.ok(b.percentComplete >= 0 && b.percentComplete <= 100)
    assert.ok(b.runtimeSec >= 0)
    assert.equal(typeof b.finished, "boolean")
    assert.equal(typeof b.listenable, "boolean")
  }
})

test("normalize: non-listenable item with null listening_status and null runtime", () => {
  const b = BY["B08JJNTGNS"]
  assert.equal(b.listenable, false)
  assert.equal(b.runtimeSec, 0)
  assert.equal(b.percentComplete, 0)
  assert.equal(b.remainingSec, 0)
  assert.equal(b.finished, false)
  assert.deepEqual(b.narrators, [])
  assert.equal(b.series, null)
})

test("normalize: series with empty sequence keeps the title and empty string", () => {
  assert.deepEqual(BY["B077BG38NM"].series, { title: "Incerto", sequence: "" })
})

test("normalize: series with a sequence number", () => {
  assert.deepEqual(BY["B0CW23CC7L"].series, { title: "Bobiverse", sequence: "5" })
})

test("normalize: 99 percent counts as finished", () => {
  const b = BY["B0CQQCYBQH"]
  assert.equal(b.percentComplete, 99)
  assert.equal(b.finished, true)
})

test("normalize: is_finished true at 0 percent counts as finished", () => {
  assert.equal(BY["B0C6YK4917"].percentComplete, 0)
  assert.equal(BY["B0C6YK4917"].finished, true)
  assert.equal(BY["B08D9TXF3H"].finished, true)
})

test("normalize: 100 percent finished", () => {
  assert.equal(BY["B085L1MKYX"].finished, true)
  assert.equal(BY["B085L1MKYX"].percentComplete, 100)
})

test("normalize: 98 percent with no finish stamp stays in progress", () => {
  assert.equal(BY["B008O8964Q"].percentComplete, 98)
  assert.equal(BY["B008O8964Q"].finished, false)
})

test("normalize: a stale finished_at with partial progress is NOT finished", () => {
  // Real data: restarted books keep finished_at_timestamp. They must stay in Continue listening.
  assert.equal(BY["B09WY6Z8KD"].percentComplete, 48)
  assert.equal(BY["B09WY6Z8KD"].finished, false)
  assert.equal(BY["B07622TL7W"].percentComplete, 16)
  assert.equal(BY["B07622TL7W"].finished, false)
})

test("normalize: multiple narrators and authors", () => {
  const b = BY["B0CTJ3LJ51"]
  assert.equal(b.narrators.length, 7)
  assert.equal(b.authors.length, 7)
  assert.equal(b.author, "Jim Rohn, Zig Ziglar, Wayne Dyer, Brian Tracy, Napoleon Hill, Earl Nightingale, Denis Waitley")
})

test("normalize: null/invalid input returns null", () => {
  assert.equal(L.normalize(null), null)
  assert.equal(L.normalize(undefined), null)
  assert.equal(L.normalize("B0XXXX"), null)
  assert.equal(L.normalize([]), null)
  assert.equal(L.normalize({ title: "no asin" }), null)
  assert.equal(L.normalize({ asin: "   " }), null)
})

test("normalize: cover picks the largest usable size", () => {
  const img = images => L.normalize({ asin: "A", product_images: images }).coverUrl
  assert.equal(img({ "100": "https://a/100.jpg", "500": "https://a/500.jpg", "1000": "https://a/1000.jpg" }), "https://a/1000.jpg")
  assert.equal(img({ "500": "https://a/500.jpg", "100": "https://a/100.jpg" }), "https://a/500.jpg")
  assert.equal(img({ "500": "http://insecure.example/x.jpg" }), "")
  assert.equal(img({ "500": "file:///home/u/cover.jpg" }), "file:///home/u/cover.jpg")
  assert.equal(img({ "500": 12 }), "")
  assert.equal(img(null), "")
  assert.equal(img(undefined), "")
  assert.equal(img([]), "")
})

test("normalize: missing product_images gives an empty cover", () => {
  assert.equal(L.normalize({ asin: "A", title: "T" }).coverUrl, "")
})

test("normalize: percent falls back to top-level percent_complete and is clamped", () => {
  assert.equal(L.normalize({ asin: "A", percent_complete: 40 }).percentComplete, 40)
  assert.equal(L.normalize({ asin: "A", listening_status: { percent_complete: 150 } }).percentComplete, 100)
  assert.equal(L.normalize({ asin: "A", listening_status: { percent_complete: -5 } }).percentComplete, 0)
  assert.equal(L.normalize({ asin: "A", listening_status: { percent_complete: "33" } }).percentComplete, 33)
  assert.equal(L.normalize({ asin: "A", listening_status: { percent_complete: null } }).percentComplete, 0)
})

test("normalize: string and null runtimes", () => {
  assert.equal(L.normalize({ asin: "A", runtime_length_min: "10" }).runtimeSec, 600)
  assert.equal(L.normalize({ asin: "A", runtime_length_min: null }).runtimeSec, 0)
  assert.equal(L.normalize({ asin: "A", runtime_length_min: -4 }).runtimeSec, 0)
})

test("normalize: purchase date falls back to library_status.date_added", () => {
  const b = L.normalize({ asin: "A", library_status: { date_added: "2024-01-01T00:00:00Z" } })
  assert.equal(b.purchaseDate, "2024-01-01T00:00:00Z")
})

test("normalize: unicode titles and missing title", () => {
  assert.equal(L.normalize({ asin: "A", title: "  Café Ø Ñandú  " }).title, "Café Ø Ñandú")
  assert.equal(L.normalize({ asin: "A" }).title, "Untitled")
  assert.equal(L.normalize({ asin: "A", title: null }).title, "Untitled")
})

test("normalize: remaining time is never negative", () => {
  assert.equal(L.normalize({ asin: "A", listening_status: { time_remaining_seconds: -10 } }).remainingSec, 0)
})

test("normalize: a null authors list gives an empty author string", () => {
  const b = L.normalize({ asin: "A", authors: null, narrators: [{ name: "  " }, { name: "Ann" }] })
  assert.equal(b.author, "")
  assert.deepEqual(b.narrators, ["Ann"])
})

// ---------------------------------------------------------------- merge

test("merge: marks local books, downloads and resume state", () => {
  const out = L.merge(BOOKS, {
    localAsins: { B0C7WJXBRL: true },
    downloads: { B06XRN58LM: { state: "downloading", fraction: 0.42, error: "" } },
    resume: { B0C7WJXBRL: { position: 3600, updatedAt: "2026-10-01T10:00:00.000Z" } }
  })
  const a = out.find(b => b.asin === "B0C7WJXBRL")
  assert.equal(a.local, true)
  assert.equal(a.resumeSec, 3600)
  assert.equal(a.lastListenedAt, Date.parse("2026-10-01T10:00:00.000Z"))
  const s = out.find(b => b.asin === "B06XRN58LM")
  assert.equal(s.local, false)
  assert.deepEqual(s.download, { state: "downloading", fraction: 0.42 })
  assert.equal(out.find(b => b.asin === "B0DTRR458T").download, null)
})

test("merge: a done download is local even without localAsins", () => {
  const out = L.merge([book({ asin: "Q" })], { downloads: { Q: { state: "done", fraction: 1 } } })
  assert.equal(out[0].local, true)
  assert.deepEqual(out[0].download, { state: "done", fraction: 1 })
})

test("merge: does not mutate its inputs", () => {
  const input = [book({ asin: "Q" })]
  const snapshot = JSON.parse(JSON.stringify(input))
  const local = { localAsins: { Q: true }, downloads: {}, resume: {} }
  const out = L.merge(input, local)
  assert.deepEqual(input, snapshot)
  assert.notEqual(out[0], input[0])
  assert.equal(out[0].local, true)
})

test("merge: missing or malformed local state gives defaults", () => {
  const out = L.merge(BOOKS, undefined)
  assert.equal(out.length, 40)
  assert.ok(out.every(b => b.local === false && b.download === null && b.resumeSec === 0 && b.lastListenedAt === 0))
  assert.equal(L.merge(BOOKS, "nonsense").length, 40)
  assert.equal(L.merge(BOOKS, { localAsins: null, downloads: 5, resume: [] }).length, 40)
})

test("merge: malformed downloads, resume values and bad books", () => {
  const out = L.merge([book({ asin: "A" }), null, 3, { title: "no asin" }], {
    downloads: { A: { state: "downloading", fraction: 7 } },
    resume: { A: { position: "not a number", updatedAt: "garbage" } }
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].download.fraction, 1)
  assert.equal(out[0].resumeSec, 0)
  assert.equal(out[0].lastListenedAt, 0)
})

test("merge: null or non-array books gives an empty list", () => {
  assert.deepEqual(L.merge(null, {}), [])
  assert.deepEqual(L.merge(undefined, {}), [])
})

test("merge: updatedAt given as epoch milliseconds passes through", () => {
  const out = L.merge([book({ asin: "A" })], { resume: { A: { position: 5, updatedAt: 1700000000000 } } })
  assert.equal(out[0].lastListenedAt, 1700000000000)
})

// ---------------------------------------------------------------- fold + filter

test("fold lowercases and strips diacritics", () => {
  assert.equal(L.fold("Café Ø"), "cafe o")
  assert.equal(L.fold("Ångström"), "angstrom")
  assert.equal(L.fold("Straße"), "strasse")
  assert.equal(L.fold("Æther"), "aether")
  assert.equal(L.fold(null), "")
})

test("filter: empty and whitespace queries return every book in order", () => {
  assert.deepEqual(L.filter(BOOKS, "").map(b => b.asin), BOOKS.map(b => b.asin))
  assert.equal(L.filter(BOOKS, "   ").length, 40)
  assert.equal(L.filter(BOOKS, undefined).length, 40)
})

test("filter: case-insensitive title prefix", () => {
  assert.deepEqual(L.filter(BOOKS, "SALES PITCH").map(b => b.asin), ["B0CQQCYBQH"])
  assert.deepEqual(L.filter(BOOKS, "celiac").map(b => b.title), ["Celiac Disease", "Celiac Straight Talk"])
})

test("filter: diacritics-insensitive in both directions", () => {
  const books = [
    book({ asin: "1", title: "Café Ø" }),
    book({ asin: "2", title: "Cafeteria" }),
    book({ asin: "3", title: "Plain" })
  ]
  assert.deepEqual(L.filter(books, "cafe").map(b => b.asin), ["1", "2"])
  assert.deepEqual(L.filter(books, "CAFÉ").map(b => b.asin), ["1", "2"])
  assert.deepEqual(L.filter(books, "ø").map(b => b.asin), ["1"])
  assert.deepEqual(L.filter(books, "o").map(b => b.asin), ["1"])
})

test("filter: multi-token AND across fields", () => {
  assert.deepEqual(L.filter(BOOKS, "pitch dunford").map(b => b.asin), ["B0CQQCYBQH"])
  assert.deepEqual(L.filter(BOOKS, "pitch hormozi"), [])
  // one token in the author, one in the subtitle
  assert.deepEqual(L.filter(BOOKS, "heilbronner ambivalence").map(b => b.asin), ["B0DTRR458T"])
})

test("filter: prefix beats contains; word prefix beats mid-word", () => {
  const books = [
    book({ asin: "contains", title: "Lessons in Frameworks" }),
    book({ asin: "wordprefix", title: "The Work Ethic" }),
    book({ asin: "prefix", title: "Working Class" }),
    book({ asin: "author", title: "Something Else", author: "Work Man" })
  ]
  assert.deepEqual(L.filter(books, "work").map(b => b.asin), ["prefix", "wordprefix", "contains", "author"])
})

test("filter: title beats author beats other fields", () => {
  const books = [
    book({ asin: "other", title: "A", subtitle: "deep dive" }),
    book({ asin: "author", title: "B", author: "Deepak Chopra" }),
    book({ asin: "contains", title: "Undeepened" }),
    book({ asin: "prefix", title: "Deep Work" }),
    book({ asin: "wordprefix", title: "The Deep End" })
  ]
  assert.deepEqual(L.filter(books, "deep").map(b => b.asin), ["prefix", "wordprefix", "contains", "author", "other"])
})

test("filter: stable for equal rank (input order kept)", () => {
  const books = [book({ asin: "1", title: "Alpha Two" }), book({ asin: "2", title: "Alpha One" }), book({ asin: "3", title: "Alpha Three" })]
  assert.deepEqual(L.filter(books, "alpha").map(b => b.asin), ["1", "2", "3"])
})

test("filter: each token may match a different field; best tier wins", () => {
  const books = [
    book({ asin: "A", title: "Deep Work", author: "Cal Newport" }),
    book({ asin: "B", title: "Something", author: "Cal Deep" })
  ]
  // "deep" ranks A as title-prefix (0); B only has it in the author (3)
  assert.deepEqual(L.filter(books, "deep cal").map(b => b.asin), ["A", "B"])
})

test("filter: series title and narrators are searchable", () => {
  assert.deepEqual(L.filter(BOOKS, "incerto").map(b => b.asin), ["B077BG38NM"])
  assert.deepEqual(L.filter(BOOKS, "hofstadter").map(b => b.asin), ["B07HJ9NHHM"])
})

test("filter: punctuation in the query splits words and matches", () => {
  assert.deepEqual(L.filter(BOOKS, "pragmatic, 20th").map(b => b.asin), ["B0833FMYH9"])
})

test("filter: non-listenable books are still searchable", () => {
  assert.deepEqual(L.filter(BOOKS, "beyond celiac").map(b => b.asin), ["B08JJNTGNS"])
})

test("filter: no match gives an empty list and ignores non-objects", () => {
  assert.deepEqual(L.filter(BOOKS, "zzzqqq"), [])
  assert.deepEqual(L.filter([null, book({ asin: "A", title: "Zed" })], "zed").map(b => b.asin), ["A"])
  assert.deepEqual(L.filter(null, "x"), [])
})

// ---------------------------------------------------------------- sections

const ASINS = list => list.map(b => b.asin)

test("sections: no query gives continue, downloaded and all sections", () => {
  const out = L.sections(BOOKS, { query: "", now: 0 })
  assert.deepEqual(out.map(s => s.id), ["continue", "all"])
  assert.deepEqual(out.map(s => s.title), ["Continue listening", "All books"])
})

test("sections: continue holds in-progress, unfinished, listenable books only", () => {
  const cont = L.sections(BOOKS)[0]
  assert.equal(cont.id, "continue")
  assert.deepEqual(new Set(ASINS(cont.books)), new Set([
    "B0C7WJXBRL", "B06XRN58LM", "B07HS14W46", "B07HJ9NHHM", "197733394X",
    "B0BZB9BZ5G", "B0C82P8W17", "B0CTJ3LJ51", "B008O8964Q",
    "B09WY6Z8KD", "B07622TL7W"   // restarted books: stale finished_at, still in progress
  ]))
  assert.equal(cont.books.length, 11)
})

test("sections: continue ordering without local data is highest percent first", () => {
  const cont = L.sections(BOOKS)[0]
  assert.deepEqual(cont.books.map(b => b.percentComplete), [98, 80, 79, 54, 52, 48, 24, 17, 16, 16, 1])
})

test("sections: continue ordering is newest lastListenedAt first, then percent", () => {
  const merged = L.merge(BOOKS, {
    resume: {
      B0C82P8W17: { position: 10, updatedAt: "2026-10-05T00:00:00Z" },
      B06XRN58LM: { position: 900, updatedAt: "2026-09-01T00:00:00Z" }
    }
  })
  const cont = L.sections(merged)[0]
  assert.deepEqual(cont.books.slice(0, 2).map(b => b.asin), ["B0C82P8W17", "B06XRN58LM"])
  assert.deepEqual(cont.books.slice(2).map(b => b.percentComplete), [98, 80, 54, 52, 48, 24, 17, 16, 16])
})

test("sections: a book with resume position but zero percent is continue", () => {
  const books = [book({ asin: "R", percentComplete: 0, resumeSec: 120, purchaseDate: "2020" })]
  const out = L.sections(books)
  assert.deepEqual(out.map(s => s.id), ["continue"])
})

test("sections: finished books are excluded from continue but kept in all", () => {
  const out = L.sections(BOOKS)
  const cont = out.find(s => s.id === "continue")
  const all = out.find(s => s.id === "all")
  assert.equal(cont.books.some(b => b.asin === "B0CQQCYBQH"), false)
  assert.equal(all.books.some(b => b.asin === "B0CQQCYBQH"), true)
  assert.equal(all.books.some(b => b.asin === "B085L1MKYX"), true)
})

test("sections: non-listenable books are excluded from continue and dimmed in all", () => {
  const merged = L.merge(BOOKS, { resume: { B08JJNTGNS: { position: 50, updatedAt: "2026-10-05T00:00:00Z" } } })
  const out = L.sections(merged)
  assert.equal(out.find(s => s.id === "continue").books.some(b => b.asin === "B08JJNTGNS"), false)
  assert.equal(out.find(s => s.id === "all").books.some(b => b.asin === "B08JJNTGNS"), true)
})

test("sections: every book appears in exactly one section", () => {
  const merged = L.merge(BOOKS, {
    localAsins: { B0C7WJXBRL: true, B085L1MKYX: true, B08JJNTGNS: true },
    downloads: { B06XRN58LM: { state: "queued", fraction: 0 } },
    resume: { B06XRN58LM: { position: 20, updatedAt: "2026-10-05T00:00:00Z" } }
  })
  const out = L.sections(merged)
  const seen = ASINS(out.flatMap(s => s.books))
  assert.equal(seen.length, 40)
  assert.equal(new Set(seen).size, 40)
  assert.deepEqual(new Set(seen), new Set(BOOKS.map(b => b.asin)))
})

test("sections: a downloaded in-progress book goes to continue, not downloaded", () => {
  const merged = L.merge(BOOKS, { localAsins: { B0C7WJXBRL: true } })
  const out = L.sections(merged)
  assert.equal(out.find(s => s.id === "continue").books.some(b => b.asin === "B0C7WJXBRL"), true)
  assert.equal(out.find(s => s.id === "downloaded"), undefined)
})

test("sections: downloaded (not in progress) books get their own section; sort 'added' = newest purchase first", () => {
  const merged = L.merge(BOOKS, {
    localAsins: { B085L1MKYX: true, B0DTRR458T: true, B0833FMYH9: true }
  })
  const out = L.sections(merged, { sort: "added" })
  assert.deepEqual(out.map(s => s.id), ["continue", "downloaded", "all"])
  const dl = out.find(s => s.id === "downloaded")
  // purchase dates: B0DTRR458T 2025-11, B085L1MKYX 2024-12, B0833FMYH9 2024-02
  assert.deepEqual(ASINS(dl.books), ["B0DTRR458T", "B085L1MKYX", "B0833FMYH9"])
  // Downloaded books are not repeated in All
  assert.equal(out.find(s => s.id === "all").books.some(b => b.local), false)
})

test("sections: with sort 'added' the all section is sorted by purchaseDate descending", () => {
  const all = L.sections(BOOKS, { sort: "added" }).find(s => s.id === "all").books
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].purchaseDate >= all[i].purchaseDate, `${all[i - 1].asin} before ${all[i].asin}`)
  }
  assert.equal(all[0].asin, "B0DTRR458T")
})

test("sections: empty sections are omitted", () => {
  const finishedOnly = [book({ asin: "F", finished: true, percentComplete: 100, purchaseDate: "2020" })]
  assert.deepEqual(L.sections(finishedOnly).map(s => s.id), ["all"])
  assert.deepEqual(L.sections([]), [])
  assert.deepEqual(L.sections(null), [])
})

test("sections: a non-empty query gives one ranked results section", () => {
  const out = L.sections(BOOKS, { query: "celiac" })
  assert.equal(out.length, 1)
  assert.equal(out[0].id, "results")
  assert.equal(out[0].title, "Results")
  assert.deepEqual(ASINS(out[0].books), ASINS(L.filter(BOOKS, "celiac")))
})

test("sections: a query with no hits gives an empty list", () => {
  assert.deepEqual(L.sections(BOOKS, { query: "no such book here" }), [])
})

test("sections: whitespace-only query behaves like no query", () => {
  assert.deepEqual(L.sections(BOOKS, { query: "   " }).map(s => s.id), ["continue", "all"])
})

test("sections: tolerates missing opts and junk entries", () => {
  assert.deepEqual(L.sections([null, 5, book({ asin: "A", purchaseDate: "2020" })]).map(s => s.id), ["all"])
})

// ---------------------------------------------------------------- moveSelection

test("moveSelection: list (columns 1) moves by one and clamps at both ends", () => {
  const mv = (index, dy, count = 5) => L.moveSelection({ index, count, columns: 1, dx: 0, dy })
  assert.equal(mv(0, 1), 1)
  assert.equal(mv(4, 1), 4)
  assert.equal(mv(0, -1), 0)
  assert.equal(mv(3, -1), 2)
  assert.equal(mv(2, 3), 4)
})

test("moveSelection: list ignores horizontal moves", () => {
  assert.equal(L.moveSelection({ index: 2, count: 5, columns: 1, dx: 1, dy: 0 }), 2)
  assert.equal(L.moveSelection({ index: 2, count: 5, columns: 1, dx: -1, dy: 0 }), 2)
})

test("moveSelection: grid vertical steps by columns and clamps to the last item", () => {
  const mv = (index, dy) => L.moveSelection({ index, count: 10, columns: 4, dx: 0, dy })
  assert.equal(mv(0, 1), 4)
  assert.equal(mv(5, -1), 1)
  assert.equal(mv(2, -1), 0)
  assert.equal(mv(8, 1), 9)
  assert.equal(mv(9, 1), 9)
  assert.equal(mv(9, -2), 1)
})

test("moveSelection: grid horizontal is linear and clamped, no wrap past ends", () => {
  const mv = (index, dx) => L.moveSelection({ index, count: 10, columns: 4, dx, dy: 0 })
  assert.equal(mv(3, 1), 4)
  assert.equal(mv(4, -1), 3)
  assert.equal(mv(0, -1), 0)
  assert.equal(mv(9, 1), 9)
})

test("moveSelection: empty list returns 0", () => {
  assert.equal(L.moveSelection({ index: 0, count: 0, columns: 4, dx: 1, dy: 1 }), 0)
  assert.equal(L.moveSelection({ index: 5, count: -3, columns: 1, dx: 0, dy: 1 }), 0)
})

test("moveSelection: out-of-range and junk input is clamped", () => {
  assert.equal(L.moveSelection({ index: 50, count: 10, columns: 1, dx: 0, dy: 0 }), 9)
  assert.equal(L.moveSelection({ index: -4, count: 10, columns: 1, dx: 0, dy: 0 }), 0)
  assert.equal(L.moveSelection({ index: undefined, count: 10, columns: 1, dx: 0, dy: 1 }), 1)
  assert.equal(L.moveSelection({ index: NaN, count: 3, columns: 0, dx: 0, dy: 1 }), 1)
  assert.equal(L.moveSelection(null), 0)
})

test("moveSelection: fractional deltas are truncated toward zero", () => {
  assert.equal(L.moveSelection({ index: 3, count: 10, columns: 4, dx: 0.5, dy: 0 }), 3)
  assert.equal(L.moveSelection({ index: 3, count: 10, columns: 4, dx: -0.9, dy: 0 }), 3)
})

// ---------------------------------------------------------------- rows and cursor

function sample() {
  return [
    { id: "continue", title: "Continue listening", books: [book({ asin: "a" }), book({ asin: "b" }), book({ asin: "c" })] },
    { id: "all", title: "All books", books: [book({ asin: "d" }), book({ asin: "e" })] }
  ]
}

test("buildRows: header per section, books chunked by columns", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(rows.map(r => r.kind), ["header", "books", "books", "header", "books"])
  assert.deepEqual(rows[1].books.map(b => b.asin), ["a", "b"])
  assert.deepEqual(rows[2].books.map(b => b.asin), ["c"])
  assert.equal(rows[0].title, "Continue listening")
  assert.equal(rows[0].count, 3)
  assert.equal(rows[2].sectionId, "continue")
})

test("buildRows: columns 1 gives one book per row; junk columns become 1", () => {
  assert.equal(L.buildRows(sample(), 1).filter(r => r.kind === "books").length, 5)
  assert.equal(L.buildRows(sample(), 0).filter(r => r.kind === "books").length, 5)
  assert.deepEqual(L.buildRows([], 4), [])
  assert.deepEqual(L.buildRows(null, 4), [])
})

test("firstCursor skips headers and handles an empty list", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(L.firstCursor(rows), { row: 1, col: 0 })
  assert.deepEqual(L.firstCursor([]), { row: -1, col: 0 })
})

test("cursorOf finds a book by asin and falls back to the first book", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(L.cursorOf(rows, "e"), { row: 4, col: 1 })
  assert.deepEqual(L.cursorOf(rows, "gone"), { row: 1, col: 0 })
  assert.deepEqual(L.cursorOf(rows, ""), { row: 1, col: 0 })
})

test("asinAt returns the asin under a cursor or empty string", () => {
  const rows = L.buildRows(sample(), 2)
  assert.equal(L.asinAt(rows, { row: 2, col: 0 }), "c")
  assert.equal(L.asinAt(rows, { row: 0, col: 0 }), "")
  assert.equal(L.asinAt(rows, { row: 2, col: 5 }), "")
  assert.equal(L.asinAt([], { row: 0, col: 0 }), "")
})

test("stepCursor: down skips the section header and keeps the column", () => {
  const rows = L.buildRows(sample(), 2)
  // row 2 is ["c"], next books row is row 4 (after the "All" header)
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 1 }, 0, 1), { row: 2, col: 0 })
  assert.deepEqual(L.stepCursor(rows, { row: 2, col: 0 }, 0, 1), { row: 4, col: 0 })
})

test("stepCursor: up across a header lands on the previous section's last row", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(L.stepCursor(rows, { row: 4, col: 0 }, 0, -1), { row: 2, col: 0 })
})

test("stepCursor: column is clamped to a shorter target row", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 1 }, 0, 1), { row: 2, col: 0 })
})

test("stepCursor: vertical clamps at the first and last book rows", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 0 }, 0, -1), { row: 1, col: 0 })
  assert.deepEqual(L.stepCursor(rows, { row: 4, col: 1 }, 0, 1), { row: 4, col: 1 })
  assert.deepEqual(L.stepCursor(rows, { row: 4, col: 0 }, 0, 5), { row: 4, col: 0 })
})

test("stepCursor: horizontal stays inside the row", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 0 }, 1, 0), { row: 1, col: 1 })
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 1 }, 1, 0), { row: 1, col: 1 })
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 0 }, -1, 0), { row: 1, col: 0 })
})

test("stepCursor: a list (columns 1) has no horizontal movement", () => {
  const rows = L.buildRows(sample(), 1)
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 0 }, 1, 0), { row: 1, col: 0 })
})

test("stepCursor: an invalid cursor falls back to the first book", () => {
  const rows = L.buildRows(sample(), 2)
  assert.deepEqual(L.stepCursor(rows, { row: 0, col: 0 }, 0, 1), { row: 1, col: 0 })
  assert.deepEqual(L.stepCursor(rows, null, 0, 1), { row: 1, col: 0 })
  assert.deepEqual(L.stepCursor(rows, { row: 99, col: 0 }, 0, 1), { row: 1, col: 0 })
  assert.deepEqual(L.stepCursor([], { row: 0, col: 0 }, 0, 1), { row: -1, col: 0 })
})

test("stepCursor: multi-row jumps keep moving through books only", () => {
  const rows = L.buildRows(sample(), 1)
  // books rows: 1(a) 2(b) 3(c) 5(d) 6(e); from a, two steps down reaches c
  assert.deepEqual(L.stepCursor(rows, { row: 1, col: 0 }, 0, 2), { row: 3, col: 0 })
  assert.deepEqual(L.stepCursor(rows, { row: 6, col: 0 }, 0, -2), { row: 3, col: 0 })
})

// ---------------------------------------------------------------- progressFraction

test("progressFraction uses percent, then resume over runtime, else zero", () => {
  assert.equal(L.progressFraction(book({ percentComplete: 50 })), 0.5)
  assert.equal(L.progressFraction(book({ percentComplete: 150 })), 1)
  assert.equal(L.progressFraction(book({ percentComplete: 0, resumeSec: 300, runtimeSec: 600 })), 0.5)
  assert.equal(L.progressFraction(book({ percentComplete: 0, resumeSec: 900, runtimeSec: 600 })), 1)
  assert.equal(L.progressFraction(book({ percentComplete: 0, resumeSec: 0, runtimeSec: 600 })), 0)
  assert.equal(L.progressFraction(null), 0)
  assert.equal(L.progressFraction(book({ percentComplete: NaN })), 0)
})

// ---------------------------------------------------------------- formatRuntime / formatMeta

test("formatRuntime: hours and minutes", () => {
  assert.equal(L.formatRuntime(27720), "7h 42m")
  assert.equal(L.formatRuntime(30660), "8h 31m")
  assert.equal(L.formatRuntime(3600), "1h")
  assert.equal(L.formatRuntime(7200), "2h")
  assert.equal(L.formatRuntime(3660), "1h 1m")
})

test("formatRuntime: minutes and sub-minute", () => {
  assert.equal(L.formatRuntime(2520), "42m")
  assert.equal(L.formatRuntime(60), "1m")
  assert.equal(L.formatRuntime(3599), "59m")
  assert.equal(L.formatRuntime(1), "<1m")
  assert.equal(L.formatRuntime(59), "<1m")
})

test("formatRuntime: no usable duration gives an empty string", () => {
  for (const v of [0, -5, NaN, Infinity, undefined, null, "abc", {}]) {
    assert.equal(L.formatRuntime(v), "", String(v))
  }
  assert.equal(L.formatRuntime("7200"), "2h")
})

test("formatMeta: author, runtime and percent", () => {
  assert.equal(L.formatMeta(BY["B06XRN58LM"]), "Jay Sullivan · 5h 46m · 79%")
})

test("formatMeta: a finished book shows Finished instead of a percentage", () => {
  assert.equal(L.formatMeta(BY["B0CQQCYBQH"]), "April Dunford · 2h 57m · Finished")
  assert.equal(L.formatMeta(book({ author: "A", runtimeSec: 0, finished: true, percentComplete: 100 })), "A · Finished")
})

test("formatMeta: untouched book shows no percentage", () => {
  assert.equal(L.formatMeta(BY["B0DTRR458T"]), "Sue Heilbronner · 8h 31m")
})

test("formatMeta: rounds the percentage and hides a rounded-to-zero one", () => {
  assert.equal(L.formatMeta(book({ author: "A", runtimeSec: 0, percentComplete: 33.6 })), "A · 34%")
  assert.equal(L.formatMeta(book({ author: "A", runtimeSec: 0, percentComplete: 0.4 })), "A")
})

test("formatMeta: missing parts are omitted, junk gives empty string", () => {
  assert.equal(L.formatMeta(book({ author: "", runtimeSec: 0, percentComplete: 0 })), "")
  assert.equal(L.formatMeta(book({ author: "", runtimeSec: 600 })), "10m")
  assert.equal(L.formatMeta(null), "")
  assert.equal(L.formatMeta("x"), "")
})

test("formatMeta: non-listenable book with no runtime shows only the author", () => {
  assert.equal(L.formatMeta(BY["B08JJNTGNS"]), "Beyond Celiac")
})

test("normalize: unicode author names survive into formatMeta", () => {
  const b = L.normalize({ asin: "U", authors: [{ name: "José Ørsted" }], runtime_length_min: 60 })
  assert.equal(L.formatMeta(b), "José Ørsted · 1h")
})

// ------------------------------------------------------------ last-played ordering

test("sections: default order is last played first (local history beats purchase date)", () => {
  const books = [
    book({ asin: "OLD", purchaseDate: "2026-01-01", finished: true }),
    book({ asin: "NEW", purchaseDate: "2020-01-01", finished: true, lastListenedAt: Date.parse("2026-10-09T10:00:00Z") }),
    book({ asin: "MID", purchaseDate: "2024-01-01", finished: true, lastListenedAt: Date.parse("2026-09-01T10:00:00Z") })
  ]
  const all = L.sections(books).find(s => s.id === "all").books.map(b => b.asin)
  assert.deepEqual(all, ["NEW", "MID", "OLD"])
})

test("sections: Audible's finish date stands in for last played on books played elsewhere", () => {
  const books = [
    book({ asin: "A", purchaseDate: "2026-06-01", finished: true }),
    book({ asin: "B", purchaseDate: "2019-01-01", finished: true, finishedAt: Date.parse("2026-08-01T00:00:00Z") }),
    book({ asin: "C", purchaseDate: "2024-01-01", finished: true, lastListenedAt: Date.parse("2026-09-15T00:00:00Z"), finishedAt: Date.parse("2026-01-01T00:00:00Z") })
  ]
  const all = L.sections(books).find(s => s.id === "all").books.map(b => b.asin)
  assert.deepEqual(all, ["C", "B", "A"])   // C: local 09-15, B: finished 08-01, A: never played
})

test("sections: books never played fall back to newest purchase first", () => {
  const books = [
    book({ asin: "P1", purchaseDate: "2021-01-01" }),
    book({ asin: "P3", purchaseDate: "2025-01-01" }),
    book({ asin: "P2", purchaseDate: "2023-01-01" })
  ]
  assert.deepEqual(L.sections(books).find(s => s.id === "all").books.map(b => b.asin), ["P3", "P2", "P1"])
})

test("sections: sort 'added' ignores play history", () => {
  const books = [
    book({ asin: "PLAYED", purchaseDate: "2020-01-01", lastListenedAt: Date.parse("2026-10-09T00:00:00Z") }),
    book({ asin: "FRESH", purchaseDate: "2026-05-01" })
  ]
  assert.deepEqual(L.sections(books, { sort: "added" }).find(s => s.id === "all").books.map(b => b.asin), ["FRESH", "PLAYED"])
})

test("sections: downloaded section also follows last played", () => {
  const books = [
    book({ asin: "D1", local: true, purchaseDate: "2026-01-01", finished: true }),
    book({ asin: "D2", local: true, purchaseDate: "2019-01-01", finished: true, lastListenedAt: Date.parse("2026-10-01T00:00:00Z") })
  ]
  assert.deepEqual(L.sections(books).find(s => s.id === "downloaded").books.map(b => b.asin), ["D2", "D1"])
})

test("normalize: reads finished_at_timestamp into finishedAt (ms)", () => {
  const b = L.normalize({ asin: "Z", title: "Z", listening_status: { percent_complete: 100, is_finished: true, finished_at_timestamp: "2026-03-31T19:43:59.308Z" } })
  assert.equal(b.finishedAt, Date.parse("2026-03-31T19:43:59.308Z"))
  assert.equal(L.normalize({ asin: "Y", title: "Y" }).finishedAt, 0)
})

// ------------------------------------------------- play counts, finished-here, status filter

test("merge: our play count wins, and an Audible-finished book with no local count is one listen", () => {
  const src = [
    book({ asin: "A", finished: true }),
    book({ asin: "B", finished: false }),
    book({ asin: "C", finished: true })
  ]
  const out = L.merge(src, { plays: { B: { count: 3, lastAt: 1 }, C: { count: 2, lastAt: 1 } } })
  const by = Object.fromEntries(out.map(b => [b.asin, b.playCount]))
  assert.deepEqual(by, { A: 1, B: 3, C: 2 })
})

test("merge: unplayed books have playCount 0", () => {
  assert.equal(L.merge([book({ asin: "Z" })], {})[0].playCount, 0)
})

test("merge: marked finished here (nothing played since) leaves Continue listening", () => {
  const src = [book({ asin: "M", percentComplete: 40, finished: false })]
  const out = L.merge(src, {
    plays: { M: { count: 1, lastAt: 2000 } },
    resume: { M: { position: 0, updatedAt: 2000 } }
  })
  assert.equal(out[0].finishedHere, true)
  assert.equal(out[0].finished, true)
  assert.equal(L.sections(out).some(s => s.id === "continue"), false)
})

test("merge: listening again after marking finished brings it back to Continue", () => {
  const src = [book({ asin: "M", percentComplete: 40, finished: false })]
  const out = L.merge(src, {
    plays: { M: { count: 1, lastAt: 2000 } },
    resume: { M: { position: 600, updatedAt: 9000 } }
  })
  assert.equal(out[0].finishedHere, false)
  assert.equal(out[0].finished, false)
  assert.deepEqual(L.sections(out).find(s => s.id === "continue").books.map(b => b.asin), ["M"])
  assert.equal(out[0].playCount, 1)   // the earlier full listen still counts
})

test("byStatus: downloaded, cloud (playable only) and all", () => {
  const list = [
    book({ asin: "L1", local: true }),
    book({ asin: "C1", local: false }),
    book({ asin: "X1", local: false, listenable: false })
  ]
  assert.deepEqual(L.byStatus(list, "downloaded").map(b => b.asin), ["L1"])
  assert.deepEqual(L.byStatus(list, "cloud").map(b => b.asin), ["C1"])
  assert.deepEqual(L.byStatus(list, "all").map(b => b.asin), ["L1", "C1", "X1"])
  assert.deepEqual(L.byStatus(list).map(b => b.asin), ["L1", "C1", "X1"])
})

test("sections: status filter applies to every section and to search", () => {
  const list = [
    book({ asin: "L1", title: "Alpha local", local: true, percentComplete: 20, resumeSec: 100 }),
    book({ asin: "L2", title: "Alpha two local", local: true }),
    book({ asin: "C1", title: "Alpha cloud", local: false })
  ]
  const dl = L.sections(list, { status: "downloaded" })
  assert.deepEqual(dl.flatMap(s => s.books.map(b => b.asin)).sort(), ["L1", "L2"])
  const cloud = L.sections(list, { status: "cloud" })
  assert.deepEqual(cloud.flatMap(s => s.books.map(b => b.asin)), ["C1"])
  const q = L.sections(list, { status: "downloaded", query: "alpha" })
  assert.deepEqual(q[0].books.map(b => b.asin).sort(), ["L1", "L2"])
  assert.deepEqual(L.sections(list, { status: "cloud", query: "local" }), [])
})

// ----------------------------------------------------------------------- series grouping

const inSeries = (asin, title, seq, extra) => book(Object.assign({
  asin, title, series: { title: title.split(":")[0] === "Sol" ? "Sol Cycle" : "Hyperion Cantos", sequence: seq },
  authors: ["Dan Simmons"], coverUrl: "u/" + asin, purchaseDate: "2024-01-0" + (Number(seq) || 1)
}, extra))

test("seriesNumber parses numbers, decimals and blanks", () => {
  assert.equal(L.seriesNumber({ series: { sequence: "2" } }), 2)
  assert.equal(L.seriesNumber({ series: { sequence: "2.5" } }), 2.5)
  assert.equal(L.seriesNumber({ series: { sequence: "0" } }), 0)
  assert.equal(L.seriesNumber({ series: { sequence: "" } }), null)
  assert.equal(L.seriesNumber({ series: null }), null)
  assert.equal(L.seriesNumber(null), null)
})

test("sortSeriesMembers: by number (2.5 between 2 and 3), unnumbered last by title", () => {
  const m = [
    inSeries("c", "C book", "3"), inSeries("n2", "Zeta novella", ""), inSeries("a", "A book", "1"),
    inSeries("h", "Half book", "2.5"), inSeries("b", "B book", "2"), inSeries("n1", "Alpha novella", "")
  ]
  assert.deepEqual(L.sortSeriesMembers(m).map(b => b.asin), ["a", "b", "h", "c", "n1", "n2"])
})

test("nextUp: first unfinished listenable member, else the first", () => {
  const m = [
    inSeries("1", "One", "1", { finished: true }), inSeries("2", "Two", "2", { finished: true }),
    inSeries("3", "Three", "3"), inSeries("4", "Four", "4")
  ]
  assert.equal(L.nextUp(m).asin, "3")
  assert.equal(L.nextUp(m.map(b => Object.assign({}, b, { finished: true }))).asin, "1")
  assert.equal(L.nextUp([]), null)
})

test("sections without group: series books stay individual (default behaviour unchanged)", () => {
  const list = [inSeries("1", "One", "1"), inSeries("2", "Two", "2"), book({ asin: "S", title: "Solo" })]
  assert.equal(L.sections(list).find(s => s.id === "all").books.length, 3)
})

test("sections with group: a series of 2+ becomes one tile; singles and unseries'd books stay", () => {
  const list = [
    inSeries("1", "One", "1"), inSeries("2", "Two", "2"), inSeries("3", "Three", "3"),
    book({ asin: "S", title: "Solo" }),
    book({ asin: "L", title: "Lonely", series: { title: "Only One Owned", sequence: "1" } })
  ]
  const all = L.sections(list, { group: true }).find(s => s.id === "all").books
  assert.equal(all.length, 3)
  const tile = all.find(b => b.isSeries)
  assert.equal(tile.title, "Hyperion Cantos")
  assert.equal(tile.seriesCount, 3)
  assert.deepEqual(tile.memberAsins, ["1", "2", "3"])
  assert.equal(tile.asin, "series:hyperion cantos")
  assert.ok(all.some(b => b.asin === "S") && all.some(b => b.asin === "L"))
  assert.equal(all.filter(b => !b.isSeries && b.series && b.series.title === "Hyperion Cantos").length, 0)
})

test("sections with group: Continue listening keeps in-progress members individual; the tile still counts them", () => {
  const list = [
    inSeries("1", "One", "1", { percentComplete: 30, resumeSec: 500 }),
    inSeries("2", "Two", "2"), inSeries("3", "Three", "3")
  ]
  const out = L.sections(list, { group: true })
  assert.deepEqual(out.find(s => s.id === "continue").books.map(b => b.asin), ["1"])
  const tile = out.find(s => s.id === "all").books.find(b => b.isSeries)
  assert.equal(tile.seriesCount, 3)       // opening it shows all three
  assert.equal(out.find(s => s.id === "all").books.length, 1)
})

test("sections with group: one tile in the whole view even when members span Downloaded and All", () => {
  const list = [
    inSeries("1", "One", "1", { local: true }), inSeries("2", "Two", "2"), inSeries("3", "Three", "3", { local: true })
  ]
  const out = L.sections(list, { group: true })
  const tiles = out.flatMap(s => s.books).filter(b => b.isSeries)
  assert.equal(tiles.length, 1)
  assert.equal(tiles[0].localCount, 2)
  assert.equal(out.find(s => s.id === "downloaded").books.length, 1)
  assert.equal(out.find(s => s.id === "all"), undefined)   // its remaining member lives inside the tile
})

test("sections with group: status filter shrinks the series; a series left with one book is a plain tile", () => {
  const list = [inSeries("1", "One", "1", { local: true }), inSeries("2", "Two", "2")]
  const dl = L.sections(list, { group: true, status: "downloaded" }).flatMap(s => s.books)
  assert.equal(dl.length, 1)
  assert.equal(dl[0].isSeries, undefined)
  assert.equal(dl[0].asin, "1")
})

test("sections with group: a search returns plain books, not tiles", () => {
  const list = [inSeries("1", "One", "1"), inSeries("2", "Two", "2")]
  const out = L.sections(list, { group: true, query: "two" })
  assert.deepEqual(out[0].books.map(b => b.asin), ["2"])
})

test("seriesTile aggregates progress, runtime, authors and reading state", () => {
  const m = L.sortSeriesMembers([
    inSeries("1", "One", "1", { finished: true, runtimeSec: 3600 }),
    inSeries("2", "Two", "2", { percentComplete: 50, runtimeSec: 7200, authors: ["Dan Simmons", "Co Author"], local: true })
  ])
  const t = L.seriesTile(m)
  assert.equal(t.runtimeSec, 10800)
  assert.equal(t.finishedCount, 1)
  assert.equal(t.localCount, 1)
  assert.equal(t.percentComplete, 75)       // (1 + 0.5) / 2
  assert.equal(t.finished, false)
  assert.deepEqual(t.authors, ["Dan Simmons", "Co Author"])
  assert.equal(t.author, "2 books · Dan Simmons +1")
  assert.equal(t.coverUrl, "u/1")
  assert.deepEqual(t.covers, ["u/1", "u/2"])
})

test("seriesSections: reading order, honours search and the status filter", () => {
  const list = [
    inSeries("3", "Three", "3", { local: true }), inSeries("1", "One", "1"), inSeries("2", "Two", "2", { local: true }),
    book({ asin: "S", title: "Solo" })
  ]
  const all = L.seriesSections(list, "Hyperion Cantos", {})
  assert.deepEqual(all[0].books.map(b => b.asin), ["1", "2", "3"])
  assert.equal(all[0].title, "Hyperion Cantos")
  assert.deepEqual(L.seriesSections(list, "hyperion cantos", { status: "downloaded" })[0].books.map(b => b.asin), ["2", "3"])
  assert.deepEqual(L.seriesSections(list, "Hyperion Cantos", { query: "three" })[0].books.map(b => b.asin), ["3"])
  assert.deepEqual(L.seriesSections(list, "No Such Series", {}), [])
})

// ------------------------------------------------- one-row "Continue listening" (buildRows limits)

const nBooks = n => Array.from({ length: n }, (_, i) => book({ asin: "B" + i, title: "Book " + i }))

test("buildRows: a long section collapses to one row with the hidden count in its header", () => {
  const secs = [{ id: "continue", title: "Continue listening", books: nBooks(10) }, { id: "all", title: "All", books: nBooks(3) }]
  const rows = L.buildRows(secs, 4, { limits: { continue: 4 } })
  assert.deepEqual(rows[0], { kind: "header", id: "continue", title: "Continue listening", count: 10, collapsible: true, expanded: false, hidden: 6 })
  assert.equal(rows[1].books.length, 4)
  assert.equal(rows[2].kind, "header")          // the next section follows straight after the one row
})

test("buildRows: expanding shows everything and keeps the toggle available", () => {
  const secs = [{ id: "continue", title: "C", books: nBooks(10) }]
  const rows = L.buildRows(secs, 4, { limits: { continue: 4 }, expanded: { continue: true } })
  assert.equal(rows[0].expanded, true)
  assert.equal(rows[0].hidden, 0)
  assert.equal(rows.filter(r => r.kind === "books").reduce((n, r) => n + r.books.length, 0), 10)
})

test("buildRows: a section that already fits is not collapsible", () => {
  const rows = L.buildRows([{ id: "continue", title: "C", books: nBooks(4) }], 4, { limits: { continue: 4 } })
  assert.equal(rows[0].collapsible, false)
  assert.equal(rows[0].hidden, 0)
})

test("buildRows: the limit rounds up to a whole row; no options means no limits", () => {
  const secs = [{ id: "continue", title: "C", books: nBooks(20) }]
  assert.equal(L.buildRows(secs, 6, { limits: { continue: 4 } }).filter(r => r.kind === "books").length, 1)   // 4 -> one row of 6
  assert.equal(L.buildRows(secs, 6).filter(r => r.kind === "books").length, 4)
  assert.equal(L.buildRows(secs, 6, { limits: { continue: 5 } })[1].books.length, 6)
})

test("buildRows: list mode (1 column) can show a few rows", () => {
  const rows = L.buildRows([{ id: "continue", title: "C", books: nBooks(12) }], 1, { limits: { continue: 5 } })
  assert.equal(rows.filter(r => r.kind === "books").length, 5)
  assert.equal(rows[0].hidden, 7)
})

test("cursorOf falls back to the first book when the selection is hidden by a collapsed section", () => {
  const rows = L.buildRows([{ id: "continue", title: "C", books: nBooks(10) }], 4, { limits: { continue: 4 } })
  assert.deepEqual(L.cursorOf(rows, "B9"), { row: 1, col: 0 })
})

// ---------------------------------------------------------------------- wheel / trackpad scrolling

test("wheelStep: one mouse notch is half a grid row, animated; three rows in a list", () => {
  assert.deepEqual(L.wheelStep({ angleY: 120, rowHeight: 260, rows: 0.5, grid: true }), { dy: 130, animate: true })
  assert.deepEqual(L.wheelStep({ angleY: -120, rowHeight: 260, rows: 0.5, grid: true }), { dy: -130, animate: true })
  assert.deepEqual(L.wheelStep({ angleY: 120, rowHeight: 50, grid: false }), { dy: 150, animate: true })
})

test("wheelStep: the rows-per-notch setting scales a notch", () => {
  assert.equal(L.wheelStep({ angleY: 120, rowHeight: 200, rows: 1, grid: true }).dy, 200)
  assert.equal(L.wheelStep({ angleY: 240, rowHeight: 200, rows: 0.25, grid: true }).dy, 100)
})

test("wheelStep: trackpad (pixel) events follow the fingers with a speed-dependent gain, never animated", () => {
  const slow = L.wheelStep({ pixelY: 3, rowHeight: 260, grid: true })
  const fast = L.wheelStep({ pixelY: 30, rowHeight: 260, grid: true })
  assert.equal(slow.animate, false)
  assert.equal(fast.animate, false)
  assert.ok(slow.dy > 3 * 2.5 - 0.001)                 // at least the base gain
  assert.ok(fast.dy / 30 > slow.dy / 3)                // a faster swipe is boosted more per pixel
  assert.ok(fast.dy / 30 <= 2.5 * 3.5 + 0.001)         // and the boost is capped
  assert.equal(L.wheelStep({ pixelY: -10, rowHeight: 260, grid: true }).dy, -L.wheelStep({ pixelY: 10, rowHeight: 260, grid: true }).dy)
})

test("wheelStep: the trackpad gain is adjustable", () => {
  const a = L.wheelStep({ pixelY: 10, trackpadGain: 1 }).dy
  const b = L.wheelStep({ pixelY: 10, trackpadGain: 4 }).dy
  assert.ok(Math.abs(b / a - 4) < 1e-9)
})

test("wheelStep: fractional notches (smooth wheels) scroll proportionally without animation", () => {
  const r = L.wheelStep({ angleY: 30, rowHeight: 240, rows: 0.5, grid: true })
  assert.equal(r.dy, 30)                                // a quarter notch of 120
  assert.equal(r.animate, false)
})

test("wheelStep: nothing in, nothing out", () => {
  assert.deepEqual(L.wheelStep({}), { dy: 0, animate: false })
  assert.deepEqual(L.wheelStep(null), { dy: 0, animate: false })
})

// ------------------------------------------------------------------------ details page

test("stripHtml: publisher HTML becomes plain paragraphs", () => {
  assert.equal(L.stripHtml("<b>Bold start.</b><br /><br /> Next &amp; last &quot;quoted&quot; &#39;x&#39;"), "Bold start.\n\nNext & last \"quoted\" 'x'")
  assert.equal(L.stripHtml("<p>One</p><p>Two</p>"), "One\n\nTwo")
  assert.equal(L.stripHtml(null), "")
})

test("clipText: shortens on a word boundary with an ellipsis; short text is untouched", () => {
  assert.equal(L.clipText("short text", 100), "short text")
  const long = ("word ").repeat(50).trim()
  const out = L.clipText(long, 60)
  assert.ok(out.length <= 61 && out.endsWith("\u2026") && !out.includes("wor\u2026"))
})

test("normalize: description prefers the plain summary, falls back to stripped HTML; rating and publisher", () => {
  const a = L.normalize({ asin: "A", title: "A", merchandising_summary: "Plain summary.", publisher_summary: "<b>HTML</b>" })
  assert.equal(a.description, "Plain summary.")
  const b = L.normalize({ asin: "B", title: "B", publisher_summary: "<b>HTML</b><br/>text" })
  assert.equal(b.description, "HTML\ntext")
  const r = L.normalize({ asin: "R", title: "R", publisher_name: "Pub", format_type: "unabridged",
    rating: { overall_distribution: { average_rating: 4.833, num_ratings: 6 } } })
  assert.deepEqual([r.publisher, r.rating, r.ratingCount, r.format], ["Pub", 4.833, 6, "Unabridged"])
})

test("detailFacts: ordered, skips empty values, handles series number and counts", () => {
  const facts = L.detailFacts(book({
    authors: ["A One", "B Two"], narrators: ["N One"], series: { title: "Cantos", sequence: "2" }, runtimeSec: 27000,
    releaseDate: "2022-03-01", publisher: "Pub", rating: 4.5, ratingCount: 1, format: "Unabridged", playCount: 2
  }))
  assert.deepEqual(facts.map(f => f.label), ["Authors", "Narrator", "Series", "Length", "Released", "Publisher", "Rating", "Format", "Listened"])
  assert.equal(facts.find(f => f.label === "Series").value, "Book 2 of Cantos")
  assert.equal(facts.find(f => f.label === "Length").value, "7h 30m")
  assert.equal(facts.find(f => f.label === "Rating").value, "4.5 \u2605  (1 rating)")
  assert.equal(facts.find(f => f.label === "Listened").value, "2 times")
  assert.deepEqual(L.detailFacts(book({})).map(f => f.label), ["Length"])
})

test("detailFacts: an unnumbered series just shows its name", () => {
  const f = L.detailFacts(book({ series: { title: "Incerto", sequence: "" } }))
  assert.equal(f.find(x => x.label === "Series").value, "Incerto")
})

test("detailActions: primary says Play / Continue / Listen again / Resume / Pause", () => {
  assert.equal(L.detailActions(book({}), { local: true }).primary.label, "Play")
  assert.equal(L.detailActions(book({ percentComplete: 46 }), { local: true }).primary.label, "Continue \u00B7 46%")
  assert.equal(L.detailActions(book({ finished: true }), { local: true }).primary.label, "Listen again")
  assert.equal(L.detailActions(book({}), { local: true, isCurrent: true, isPlaying: true }).primary.label, "Pause")
  assert.equal(L.detailActions(book({}), { local: true, isCurrent: true, isPlaying: false }).primary.label, "Resume")
  assert.equal(L.detailActions(book({}), { local: true, isCurrent: true }).primary.id, "toggle")
})

test("detailActions: a book that is not downloaded says it downloads first", () => {
  const a = L.detailActions(book({ runtimeSec: 3600 }), { local: false, mb: 55 })
  assert.equal(a.primary.id, "play")
  assert.match(a.hint, /Downloads first \(about 55 MB\)/)
  assert.equal(a.download.id, "download")
  assert.equal(a.download.label, "Download \u00B7 55 MB")
  assert.equal(L.detailActions(book({}), { local: true }).hint, "")
})

test("detailActions: download button reflects download state", () => {
  const act = (dl, extra) => L.detailActions(book({}), Object.assign({ local: false, mb: 10, dl }, extra)).download
  assert.deepEqual(act({ state: "downloading", fraction: 0.42 }), { id: "none", label: "Downloading 42%", enabled: false })
  assert.deepEqual(act({ state: "queued" }), { id: "none", label: "Queued", enabled: false })
  assert.deepEqual(act({ state: "failed" }), { id: "download", label: "Retry download", enabled: true })
  assert.deepEqual(act(null, { local: true }), { id: "remove", label: "Delete download", enabled: true })
  assert.equal(act(null, { local: true, isCurrent: true }).enabled, false)   // cannot delete what is loaded
})

test("detailActions: unavailable books cannot be played or downloaded", () => {
  const a = L.detailActions(book({ listenable: false }), { local: false })
  assert.equal(a.primary.enabled, false)
  assert.equal(a.download.enabled, false)
})

test("detailActions: finish button toggles with finishedHere", () => {
  assert.deepEqual(L.detailActions(book({}), {}).finish, { id: "finish", label: "Mark finished", enabled: true })
  assert.equal(L.detailActions(book({ finished: true }), {}).finish.label, "Count another listen")
  assert.deepEqual(L.detailActions(book({ finishedHere: true, finished: true }), {}).finish, { id: "unfinish", label: "Undo finished", enabled: true })
})

test("normalize: format_type reads naturally (underscores become spaces)", () => {
  assert.equal(L.normalize({ asin: "F", title: "F", format_type: "original_recording" }).format, "Original recording")
  assert.equal(L.normalize({ asin: "G", title: "G", format_type: "unabridged" }).format, "Unabridged")
  assert.equal(L.normalize({ asin: "H", title: "H" }).format, "")
})
