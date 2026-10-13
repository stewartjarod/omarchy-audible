#!/usr/bin/env node
// Marketplace pre-flight: what plugins.omarchy.org will say about your committed HEAD, before you submit.
//
//   node tests/marketplace-preflight.mjs [--scripts DIR] [--root DIR] [--strict] [--json]
//
// 1. LISTING RULES (ported from the marketplace's build-catalog.mjs; kept small and explicit):
//    one manifest.json at the repo root, valid manifest, entry points exist, no symlinks, root README
//    and LICENSE, an optional root preview.* image.
// 2. AUTOMATED SECURITY BASELINE: the marketplace's own scanner (scripts/security-baseline-*.mjs), run
//    UNMODIFIED against your committed HEAD. A tiny fake of the GitHub API serves your local git tree to it,
//    so scope, size limits and detection rules are exactly the marketplace's. Nothing is executed.
//    Outcome  passed          -> verified automatically
//             review-required -> a maintainer must accept the listed capabilities (slower; avoid if you can)
//             needs-fixes     -> findings; must be fixed before listing
//
// It scans COMMITTED files at HEAD (like the marketplace scans a commit). Exit 0 = ok, 1 = would fail,
// 2 = could not run (scanner scripts missing: run tests/fetch-marketplace.sh).
// --strict also fails on review-required (use it when you want to ship without human review).
// This is not a security audit, and neither is the marketplace's check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = resolve(opt("--root") || join(HERE, ".."));

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const gitText = (...a) => git(...a).toString("utf8").trim();

// ---------------------------------------------------------------- listing rules
const FIELD_LIMITS = { id: 128, name: 120, version: 64, author: 120, description: 500, license: 120 };
const KINDS = new Set(["bar", "bar-widget", "menu", "overlay", "panel", "service"]);
const entryKey = (k) => (k === "bar-widget" ? "barWidget" : k);

function listingProblems(tree) {
  const out = [];
  const blobs = tree.filter((e) => e.type === "blob");
  const root = blobs.filter((e) => !e.path.includes("/"));
  if (!root.some((e) => /^readme(?:\.[^/]+)?$/i.test(e.path))) out.push("a root README is required");
  if (!root.some((e) => /^(?:licen[cs]e|copying)(?:\.[^/]+)?$/i.test(e.path))) out.push("a root license file is required");
  const manifests = blobs.filter((e) => /^(?:[^/]+\/)?manifest\.json$/i.test(e.path)).map((e) => e.path);
  if (manifests.length !== 1 || manifests[0] !== "manifest.json") {
    out.push("new submissions need exactly one plugin manifest, at the repository root");
    if (!manifests.includes("manifest.json")) return out;
  }
  if (tree.some((e) => e.mode === "120000")) out.push("symlinks are not allowed in plugin folders");
  let m;
  try { m = JSON.parse(gitText("show", "HEAD:manifest.json")); } catch { out.push("manifest.json is not valid JSON"); return out; }
  const bad = (msg) => out.push(`manifest.json: ${msg}`);
  if (m.schemaVersion !== 1) bad('"schemaVersion" must be exactly 1');
  for (const f of ["id", "name", "version", "author", "description"]) {
    const v = m[f];
    if (typeof v !== "string" || !v.trim()) { bad(`"${f}" is required`); continue; }
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(v)) bad(`"${f}" contains control characters`);
    if (v.trim().length > FIELD_LIMITS[f]) bad(`"${f}" must not exceed ${FIELD_LIMITS[f]} characters`);
  }
  if (m.license !== undefined && (typeof m.license !== "string" || !m.license.trim() || m.license.length > FIELD_LIMITS.license)) bad('"license" must be a short non-empty string');
  if (typeof m.id === "string") {
    if (m.id !== m.id.trim()) bad('"id" must not have leading or trailing whitespace');
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(m.id) || m.id.includes("..")) bad('"id" contains unsupported characters');
    if (m.id !== m.id.toLowerCase()) bad("community ids must be lowercase");
    if (m.id.toLowerCase().startsWith("omarchy.")) bad("the omarchy.* namespace is reserved");
  }
  if (!Array.isArray(m.kinds) || !m.kinds.length || m.kinds.some((k) => !KINDS.has(k))) bad('"kinds" contains unsupported values');
  const eps = m.entryPoints;
  if (!eps || typeof eps !== "object" || Array.isArray(eps)) { bad('"entryPoints" must be an object'); return out; }
  for (const k of Array.isArray(m.kinds) ? m.kinds : []) if (!Object.hasOwn(eps, entryKey(k))) bad(`entry point for "${k}" is missing`);
  const files = Object.values(eps);
  if (!files.length || files.some((p) => typeof p !== "string" || !p.trim() || p.startsWith("/") || p.includes("..") || /[\\:\r\n\0]/.test(p))) bad("entry points must be safe relative paths");
  else for (const p of files) if (!tree.some((e) => e.type === "blob" && e.path === p)) bad(`declared entry point ${p} is missing from the commit`);
  const ds = m.barWidget?.defaultSection;
  if (ds !== undefined && !["left", "center", "right"].includes(ds)) bad('"barWidget.defaultSection" must be left, center, or right');
  return out;
}

// ---------------------------------------------------------------- a local git tree, served as the GitHub API
function localTree() {
  const raw = git("ls-tree", "-r", "-l", "-z", "HEAD").toString("utf8").split("\0").filter(Boolean);
  return raw.map((line) => {
    const tab = line.indexOf("\t");
    const [mode, type, , size] = line.slice(0, tab).split(/\s+/);
    return { path: line.slice(tab + 1), mode, type, size: type === "blob" ? Number(size) : undefined };
  });
}

function repoIdentity() {
  let owner = "local-preflight", name = basename(ROOT).replace(/[^A-Za-z0-9_.-]/g, "-") || "plugin";
  try {
    const m = gitText("remote", "get-url", "origin").match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (m) [, owner, name] = m;
  } catch { /* no origin yet: use a placeholder identity */ }
  return { owner, name };
}

function fakeGitHub({ owner, name, sha, treeSha, tree }) {
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  const notFound = () => new Response("not found", { status: 404 });
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.github.com") {
      const p = u.pathname;
      if (p === `/repos/${owner}/${name}`) return json({ private: false, disabled: false, archived: false, default_branch: "main", full_name: `${owner}/${name}` });
      if (p === `/repos/${owner}/${name}/commits/${sha}`) return json({ sha, commit: { tree: { sha: treeSha } } });
      if (p === `/repos/${owner}/${name}/git/trees/${treeSha}`) return json({ truncated: false, tree });
      return notFound();
    }
    if (u.hostname === "raw.githubusercontent.com") {
      const prefix = `/${owner}/${name}/${sha}/`;
      if (!u.pathname.startsWith(prefix)) return notFound();
      const path = decodeURIComponent(u.pathname.slice(prefix.length));
      let body;
      try { body = git("show", `${sha}:${path}`); } catch { return notFound(); }
      const range = init.headers?.Range?.match(/^bytes=0-(\d+)$/);
      if (range) {
        const end = Math.min(body.length, Number(range[1]) + 1);
        return new Response(body.subarray(0, end), { status: 206, headers: { "content-length": String(end), "content-range": `bytes 0-${end - 1}/${body.length}` } });
      }
      return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
    }
    return notFound();
  };
}

// ---------------------------------------------------------------- run
async function main() {
  const scripts = resolve(opt("--scripts") || process.env.MARKETPLACE_SCRIPTS || join(ROOT, ".omarchy-ref/marketplace/default/scripts"));
  if (!existsSync(join(scripts, "security-baseline-scanner.mjs"))) {
    console.log(`marketplace-preflight: scanner not found at ${scripts} (run tests/fetch-marketplace.sh, then pass --scripts or set MARKETPLACE_SCRIPTS); skipped`);
    process.exit(2);
  }
  const sha = gitText("rev-parse", "HEAD");
  const treeSha = gitText("rev-parse", "HEAD^{tree}");
  const tree = localTree();
  const dirty = gitText("status", "--porcelain");
  const problems = listingProblems(tree);
  const { owner, name } = repoIdentity();

  const { runSecurityBaseline } = await import(pathToFileURL(join(scripts, "security-baseline-scanner.mjs")).href);
  const { verifiedPublicationDisposition } = await import(pathToFileURL(join(scripts, "security-baseline-policy.mjs")).href);
  let baseline, scanError;
  try {
    baseline = await runSecurityBaseline(`https://github.com/${owner}/${name}`, sha, {
      fetchImpl: fakeGitHub({ owner, name, sha, treeSha, tree }),
      token: "",
    });
  } catch (e) { scanError = e; }

  const strict = flag("--strict");
  // marketplace-expected.json declares the capabilities you accept knowingly. Anything else is a regression:
  // somebody added a sudo/systemctl/installer/package-manager mention and the plugin now needs human review.
  let accepted = [];
  try { accepted = JSON.parse(readFileSync(join(ROOT, "marketplace-expected.json"), "utf8")).acceptedCapabilities ?? []; } catch { /* default: none */ }
  const detected = (baseline?.capabilities ?? []).map((c) => (typeof c === "string" ? c : c.id));
  const unaccepted = detected.filter((c) => !accepted.includes(c));
  const gone = accepted.filter((c) => baseline && !detected.includes(c));
  const hasPreview = tree.some((e) => e.type === "blob" && /^preview\.(png|jpe?g|webp|avif)$/i.test(e.path));
  const result = {
    commit: sha,
    dirtyWorkingTree: Boolean(dirty),
    listingProblems: problems,
    scanError: scanError ? `${scanError.code || "error"}: ${scanError.message}` : null,
    outcome: baseline?.outcome ?? null,
    findings: baseline?.findings ?? [],
    capabilities: baseline?.capabilities ?? [],
    unacceptedCapabilities: unaccepted,
    hasPreview,
    disposition: baseline ? verifiedPublicationDisposition(baseline) : null,
  };
  const fail = problems.length > 0 || Boolean(scanError) || result.outcome === "needs-fixes" || unaccepted.length > 0 || (strict && result.outcome === "review-required");

  if (flag("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`marketplace-preflight: commit ${sha.slice(0, 12)}${dirty ? " (uncommitted changes are NOT scanned)" : ""}`);
    for (const p of problems) console.log(`  listing: ${p}`);
    if (scanError) console.log(`  scan failed (the marketplace fails closed too): ${result.scanError}`);
    if (baseline) {
      const label = { passed: "passed -> verified automatically", "review-required": "review-required -> a maintainer must accept these capabilities", "needs-fixes": "needs-fixes -> fix before listing" }[result.outcome] || result.outcome;
      console.log(`  security baseline: ${label}`);
      for (const f of result.findings) {
        console.log(`    FINDING     ${f.ruleId || f.id}  ${f.title || ""}`);
        for (const a of (f.actions || []).slice(0, 2)) console.log(`      fix: ${a}`);
        for (const ev of (f.evidence || []).slice(0, 3)) console.log(`      ${ev.path}:${ev.line}  ${String(ev.snippet || "").replace(/\s+/g, " ").slice(0, 90)}`);
      }
      for (const c of result.capabilities) {
        console.log(`    capability  ${c.id || c}${accepted.includes(c.id || c) ? "  (accepted)" : ""}`);
        for (const ev of (c.evidence || []).slice(0, 3)) console.log(`      ${ev.path}:${ev.line}  ${String(ev.snippet || "").replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
    if (unaccepted.length) console.log(`  not accepted in marketplace-expected.json: ${unaccepted.join(", ")}\n    -> remove what triggers it (evidence above), or accept it knowingly: {"acceptedCapabilities": [...]}`);
    if (gone.length) console.log(`  note: accepted but no longer detected: ${gone.join(", ")} (you can drop it from marketplace-expected.json)`);
    if (!hasPreview) console.log("  note: no root preview.png/.jpg/.webp/.avif (optional, but every popular plugin ships one)");
    console.log(fail ? "marketplace-preflight: WOULD NOT PASS" : "marketplace-preflight: ok");
  }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
