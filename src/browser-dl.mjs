import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const CDP = process.env.NXDL_CDP || "http://127.0.0.1:9222";
const HOME = process.env.HOME || ".";
const DEFAULT_OUT = process.env.NXDL_DL_DIR || path.join(HOME, "Downloads");
const TIMEOUT = Number(process.env.NXDL_TIMEOUT_MS || 240000);
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

const log = (...a) => console.log("[nxdl-browser]", ...a);

const JSON_MODE = process.env.NXDL_JSON === "1";
function emitOk(file) {
  console.log(JSON_MODE ? JSON.stringify({ ok: true, file }) : "SAVED " + file);
}
function die(msg, code = 1) {
  if (JSON_MODE) console.error(JSON.stringify({ ok: false, error: msg }));
  else console.error(msg);
  process.exit(code);
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
      "Application-Version": "0.1.0",
      "User-Agent": "nxdl/0.1.0",
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
  if (!/\.(zip|7z|rar|zipx|tar|gz)$/i.test(name)) {
    // CDN gave an opaque token name; try to recover a real name from a sibling download
    name = name + ".bin";
  }
  fs.writeFileSync(out, buf);
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  if (!a[0]) {
    console.error("usage: nxdl-browser <nexusmods-files-url> [outdir]");
    console.error("       nxdl-browser <game> <mod_id> [file_id] [outdir]");
    process.exit(1);
  }

  let target, outArg;
  if (/^https?:\/\//.test(a[0])) {
    target = a[0];
    outArg = a[1];
  } else {
    const [game, mod, third, fourth] = a;
    if (!game || !mod) {
      console.error("usage: nxdl-browser <game> <mod_id> [file_id] [outdir]");
      process.exit(1);
    }
    let file = null, out = null;
    if (third && /^\d+$/.test(third)) { file = third; out = fourth; } else { out = third; }
    if (!file) file = await resolveFileId(game, mod);
    target = `https://www.nexusmods.com/${game}/mods/${mod}?tab=files&file_id=${file}`;
    outArg = out;
  }
  const outDir = outArg || DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const before = new Set(fs.readdirSync(outDir));

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("no browser context over CDP");
  const page =
    ctx.pages().find((p) => /nexusmods\.com/.test(p.url())) ||
    ctx.pages()[0] ||
    (await ctx.newPage());

  const cdp = await ctx.newCDPSession(page).catch(() => null);
  if (cdp) {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: outDir, eventsEnabled: true }).catch(() => {});
  }

  log("navigating", target);
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
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

  // Preferred: let Chrome download it (trusted click gives a proper filename).
  let stable = null, last = null, stableCount = 0;
  while (Date.now() < deadline) {
    const c = newest();
    if (c) {
      if (last && c.p === last.p && c.size === last.size) stableCount++;
      else stableCount = 0;
      last = c;
      if (stableCount >= 2) { stable = c.p; break; }
    }
    await page.waitForTimeout(1000);
  }
  if (stable) {
    log("saved (chrome) " + stable);
    emitOk(stable);
    process.exit(0);
  }

  // Fallback: pull the tokenized CDN URL from "Start download manually".
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
    try {
      const saved = await fetchDirect(href, outDir);
      log("saved (direct) " + saved);
      emitOk(saved);
      process.exit(0);
    } catch (e) {
      log("direct fetch failed: " + e.message);
    }
  }

  die("timeout: no file downloaded to " + outDir, 2);
}

main().catch((e) => {
  die("error: " + (e?.message || e), 1);
});
