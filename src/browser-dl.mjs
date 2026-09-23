import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const CDP = process.env.NXDL_CDP || "http://127.0.0.1:9222";
const HOME = process.env.HOME || ".";
const DEFAULT_OUT = process.env.NXDL_DL_DIR || path.join(HOME, "Downloads");
const TIMEOUT = Number(process.env.NXDL_TIMEOUT_MS || 240000);
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

let jsonMode = process.env.NXDL_JSON === "1";
const log = (...a) => console.error("[nxdl-browser]", ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function die(msg, code = 1) {
  if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  else console.error(msg);
  process.exit(code);
}

function usage() {
  console.error(`usage:
  nxdl-browser <game> <mod_id> [file_id] [outdir]
  nxdl-browser <nexusmods-files-url> [outdir]
  nxdl-browser --batch <list-file> [--delay <sec>] [--json]

batch list lines:
  <game> <mod_id> [file_id] [outdir]
  <nexusmods-files-url> [outdir]
  # comments and blank lines ignored; use "-" to read stdin`);
}

function apiKey() {
  if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY.trim();
  const kf = process.env.NEXUS_KEY_FILE || path.join(HOME, ".config/nexus-dl/key");
  return fs.readFileSync(kf, "utf8").trim();
}

async function resolveFileId(game, mod) {
  const res = await fetch(`https://api.nexusmods.com/v1/games/${game}/mods/${mod}/files.json`, {
    headers: {
      apikey: apiKey(),
      "Application-Name": "nxdl",
      "Application-Version": "1.0.0",
      "User-Agent": "nxdl/1.0.0",
    },
  });
  if (!res.ok) throw new Error("files.json HTTP " + res.status);
  const data = await res.json();
  const files = Array.isArray(data) ? data : data.files || [];
  const primary = files.find((f) => f.is_primary) || files[0];
  if (!primary || !primary.file_id) throw new Error("no downloadable file found");
  log(`resolved file_id=${primary.file_id} (${primary.name || primary.file_name || "?"})`);
  return String(primary.file_id);
}

async function fetchDirect(href, outDir) {
  const res = await fetch(href, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("CDN HTTP " + res.status);
  let name = null;
  const cd = res.headers.get("content-disposition");
  if (cd) {
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
    if (m) name = decodeURIComponent(m[1].replace(/"/g, "").trim());
  }
  if (!name) {
    try { name = decodeURIComponent(new URL(href).pathname.split("/").pop()); } catch {}
  }
  name = (name || "download.bin").replace(/[\\/:*?"<>|]/g, "_");
  const out = path.join(outDir, name);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("CDN returned 0 bytes");
  fs.writeFileSync(out, buf);
  return out;
}

function parseLine(line, defaultOut) {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (!toks.length || toks[0].startsWith("#")) return null;
  if (/^https?:\/\//.test(toks[0])) {
    return { target: toks[0], outDir: toks[1] || defaultOut, label: toks[0] };
  }
  const [game, mod, third, fourth] = toks;
  if (!game || !mod) throw new Error("bad line: " + line);
  let file = null, out = null;
  if (third && /^\d+$/.test(third)) { file = third; out = fourth; } else { out = third; }
  return { game, mod, file, outDir: out || defaultOut, label: `${game}/${mod}${file ? "/" + file : ""}` };
}

function parseArgs(argv) {
  const jobs = [];
  const positionals = [];
  let batchFile = null;
  let delay = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--json") jsonMode = true;
    else if (a === "--batch" || a === "-b") batchFile = argv[++i];
    else if (a.startsWith("--batch=")) batchFile = a.slice(8);
    else if (a === "--delay") delay = Number(argv[++i] || 0);
    else if (a.startsWith("--delay=")) delay = Number(a.slice(8));
    else if (a.startsWith("-") && a !== "-") { usage(); die("unknown option: " + a); }
    else positionals.push(a);
  }

  if (batchFile) {
    const text = batchFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(batchFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const job = parseLine(line, DEFAULT_OUT);
      if (job) jobs.push(job);
    }
  } else if (positionals.length) {
    jobs.push(parseLine(positionals.join(" "), DEFAULT_OUT));
  } else {
    usage();
    process.exit(1);
  }
  return { jobs, delay };
}

async function downloadOne(page, job, cdp) {
  if (!job.target) {
    if (!job.file) job.file = await resolveFileId(job.game, job.mod);
    job.target = `https://www.nexusmods.com/${job.game}/mods/${job.mod}?tab=files&file_id=${job.file}`;
    job.label = `${job.game}/${job.mod}/${job.file}`;
  }
  const outDir = job.outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const before = new Set(fs.readdirSync(outDir));

  if (cdp) {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: outDir, eventsEnabled: true }).catch(() => {});
  }

  log("navigating", job.target);
  await page.goto(job.target, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const slow = page.locator('button:has-text("Slow download"), a:has-text("Slow download")').first();
  const manual = page.getByRole("link", { name: /manual download/i }).first();
  if ((await manual.count()) > 0 && !(await slow.isVisible().catch(() => false))) {
    log("clicking Manual download");
    await manual.click({ timeout: 15000 }).catch((e) => log("manual click:", e.message));
    await page.waitForTimeout(2000);
  }
  try {
    await slow.waitFor({ state: "visible", timeout: 30000 });
    log("clicking Slow download");
    await slow.click({ timeout: 15000 });
  } catch (e) {
    log("slow button:", e.message);
  }

  const deadline = Date.now() + TIMEOUT;
  const newest = () => {
    let best = null;
    for (const f of fs.readdirSync(outDir)) {
      if (before.has(f) || f.endsWith(".crdownload")) continue;
      const p = path.join(outDir, f);
      try {
        const s = fs.statSync(p);
        if (s.size > 0 && (!best || s.mtimeMs > best.mtimeMs)) best = { p, mtimeMs: s.mtimeMs, size: s.size };
      } catch {}
    }
    return best;
  };

  let stable = null, last = null, count = 0;
  while (Date.now() < deadline) {
    const c = newest();
    if (c) {
      if (last && c.p === last.p && c.size === last.size) count++;
      else count = 0;
      last = c;
      if (count >= 2) { stable = c.p; break; }
    }
    await page.waitForTimeout(1000);
  }
  if (stable) return stable;

  const manualLink = page.locator('a:has-text("Start download manually")').first();
  let href = null;
  while (Date.now() < deadline) {
    if (await manualLink.count()) {
      const h = await manualLink.getAttribute("href").catch(() => null);
      if (h && /^https?:\/\//.test(h)) { href = h; break; }
    }
    await page.waitForTimeout(1000);
  }
  if (href) {
    log("cdn url: " + href);
    return await fetchDirect(href, outDir);
  }
  throw new Error("timeout: no file downloaded");
}

async function main() {
  const { jobs, delay } = parseArgs(process.argv.slice(2));
  if (!jobs.length) die("no jobs", 1);

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("no browser context over CDP");
  const page =
    ctx.pages().find((p) => /nexusmods\.com/.test(p.url())) ||
    ctx.pages()[0] ||
    (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page).catch(() => null);

  const results = [];
  let failed = 0;
  for (const job of jobs) {
    try {
      const saved = await downloadOne(page, job, cdp);
      results.push({ target: job.label, ok: true, file: saved });
      log("saved " + saved);
      if (!jsonMode) console.log("SAVED " + saved);
    } catch (e) {
      failed++;
      const msg = e?.message || String(e);
      results.push({ target: job.label, ok: false, error: msg });
      log("failed " + job.label + ": " + msg);
      if (!jsonMode) console.log("FAILED " + job.label + ": " + msg);
    }
    if (delay) await sleep(delay);
  }

  if (jsonMode) {
    if (results.length === 1 && results[0].ok) {
      process.stdout.write(JSON.stringify({ ok: true, file: results[0].file }) + "\n");
    } else if (results.length === 1) {
      process.stdout.write(JSON.stringify({ ok: false, error: results[0].error }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ ok: failed === 0, results, succeeded: results.length - failed, failed }) + "\n");
    }
  } else if (jobs.length > 1) {
    log(`done: ${results.length - failed}/${results.length} ok`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  die("error: " + (e?.message || e), 1);
});
