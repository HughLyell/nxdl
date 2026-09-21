# nxdl — Autonomous Nexus Mods Downloader

A toolkit for downloading mods from [Nexus Mods](https://www.nexusmods.com)
from the command line, including **free (non-Premium) accounts**.

Two download paths are provided:

| Path | Command | Works on free accounts? | Needs a browser? |
|------|---------|------------------------|------------------|
| Nexus REST API | `nxdl` | Metadata yes; direct download **Premium only** | No |
| Browser automation | `nxdl-browser` | **Yes** | Yes (Chrome + CDP) |
| `nxm://` link handler | `nxdl nxm <url>` | Yes (site-generated key) | Triggered from browser |

The browser path is the reliable one: it drives your **real, logged-in Chrome**
with *trusted* input events over the Chrome DevTools Protocol, so the site's
"Slow download" button actually works. It then captures the file (or the
tokenized CDN URL) and saves it to your download folder.

---

## Why the browser path is needed

Nexus's `download_link` REST endpoint returns HTTP 403 for non-Premium users:

> *"You don't have permission to get download links from the API without
> visiting nexusmods.com — this is for premium users only."*

Free accounts must go through the website. Browser-extension automation
(Browser MCP, etc.) sends *synthetic* clicks that the site's download handler
ignores. Driving Chrome over **CDP** with `playwright-core` produces real,
trusted input events, which makes the free download flow work end-to-end.

---

## Layout

```
nxdl/
├── bin/
│   ├── nxdl            # REST API client + nxm:// handler + register-handler
│   ├── nxdl-chrome     # launches a debug-enabled Chrome (seeded profile)
│   └── nxdl-browser    # autonomous downloader (wraps src/browser-dl.mjs)
├── src/
│   └── browser-dl.mjs  # Playwright-over-CDP logic
├── package.json
└── README.md
```

---

## Prerequisites

- **Linux** with a Chromium-family browser (`google-chrome` / `chrome`).
- **Node.js >= 18** (global `fetch` is used).
- **curl** (used by `nxdl` and `nxdl-chrome`).
- `nix` is optional; these tools work on any distro.

On NixOS, Node and jq can be installed with:

```bash
nix profile install nixpkgs#nodejs
```

---

## Install

From the repo root:

```bash
# 1) install the Node dependency (playwright-core; no browsers are downloaded)
npm install

# 2) put the scripts on your PATH
mkdir -p ~/.local/bin
install -m755 bin/nxdl         ~/.local/bin/nxdl
install -m755 bin/nxdl-chrome  ~/.local/bin/nxdl-chrome
install -m755 bin/nxdl-browser ~/.local/bin/nxdl-browser

# 3) place the browser driver where nxdl-browser looks for it
mkdir -p ~/.local/share/nxdl
install -m644 src/browser-dl.mjs ~/.local/share/nxdl/browser-dl.mjs
npm install --prefix ~/.local/share/nxdl playwright-core

# 4) store your personal Nexus API key (create one at
#    https://www.nexusmods.com/users/myaccount?tab=api )
mkdir -p ~/.config/nexus-dl
printf '%s' 'YOUR_API_KEY' > ~/.config/nexus-dl/key
chmod 600 ~/.config/nexus-dl/key
```

> `nxdl-browser` also accepts `NXDL_HOME` if you keep `browser-dl.mjs`
> somewhere else.

---

## Setup (one-time)

Log into Nexus Mods in **Chrome** as usual. Then run:

```bash
nxdl-chrome
```

This starts a Chrome instance with `--remote-debugging-port=9222`, using a
**clone of your profile** at `~/.local/share/nxdl/chrome-profile`, so your
existing logins carry over. Leave that Chrome window open.

Verify the API key:

```bash
nxdl whoami
```

---

## Usage

### Autonomous browser download (recommended)

```bash
# main file of a mod -> ~/Downloads
nxdl-browser cyberpunk2077 4198

# a specific file id -> a chosen folder
nxdl-browser cyberpunk2077 107 123169 ~/mods

# a full files URL also works
nxdl-browser "https://www.nexusmods.com/cyberpunk2077/mods/2380?tab=files&file_id=139049"
```

If `file_id` is omitted, the script resolves the mod's primary file through the
Nexus REST API first. Progress and the saved path are printed; the exit code is
`0` on success.

### REST API client

```bash
nxdl whoami                              # account + premium status
nxdl mod   cyberpunk2077 107             # mod metadata
nxdl files cyberpunk2077 107             # file list (id, version, size, name)
nxdl dl    cyberpunk2077 107 123169      # keyless API download (Premium only)
```

### `nxm://` handler

`nxdl` can register itself as the system handler for `nxm://` links:

```bash
nxdl register          # installs x-scheme-handler/nxm and points it at nxdl
nxdl nxm "nxm://cyberpunk2077/mods/107/files/123169?key=...&expires=..."
```

When a compatible `nxm://` link is opened from the browser it is handed to
`nxdl`, which redeems it through the API. If the redeem fails because the link
expired (`HTTP 410`), click **Mod manager download** on the mod page again to
generate a fresh link. (`HTTP 403` from the keyless endpoint means Premium-only.)

---

## Configuration

| Variable | Default | Used by |
|----------|---------|---------|
| `NEXUS_API_KEY` | — | `nxdl`, `nxdl-browser` (overrides key file) |
| `NEXUS_KEY_FILE` | `~/.config/nexus-dl/key` | `nxdl`, `nxdl-browser` |
| `NXDL_DL_DIR` | `~/Downloads` | `nxdl-browser` |
| `NXDL_CDP` | `http://127.0.0.1:9222` | `nxdl-browser` |
| `NXDL_CDP_PORT` | `9222` | `nxdl-chrome` |
| `NXDL_CHROME_PROFILE` | `~/.local/share/nxdl/chrome-profile` | `nxdl-chrome` |
| `NXDL_CHROME_SRC` | `~/.config/google-chrome` | `nxdl-chrome` |
| `NXDL_CHROME` | auto-detected | `nxdl-chrome` |
| `NXDL_TIMEOUT_MS` | `240000` | `nxdl-browser` |
| `NXDL_NODE` | `~/.nix-profile/bin/node` or `node` | `nxdl-browser` |
| `NXDL_LOG` | `~/.cache/nxdl/nxm.log` | `nxdl` |

---

## How it works

1. **`nxdl-chrome`** copies your Chrome profile once, removes stale singleton
   locks, and launches Chrome with `--remote-debugging-port=9222`.
2. **`nxdl-browser`** connects to that Chrome with `playwright-core`
   (`chromium.connectOverCDP`) and enables downloads via
   `Browser.setDownloadBehavior`.
3. It navigates to the file's download page (`?tab=files&file_id=<id>`) and
   clicks **Slow download** using Playwright (real CDP input → *trusted*
   gesture). Chrome downloads the file with its proper filename.
4. The script waits until a new, size-stable file appears in the output folder.
   As a fallback it reads the tokenized `files.nexus-cdn.com` URL from the
   **"Start download manually"** link and fetches it directly.

---

## Troubleshooting

- **`Bad credentials` / API 401** — your Nexus API key is wrong or expired;
  regenerate it on the account API page.
- **`not logged in on this Chrome profile`** — log into Nexus in the debug
  Chrome window once; it persists in `~/.local/share/nxdl/chrome-profile`.
- **`nxdl-chrome: chrome did not expose port 9222`** — another process may hold
  the port, or the browser failed to start; run `google-chrome-stable` manually
  to see errors.
- **No file downloaded / timeout** — the site layout may have changed; run with
  a visible Chrome (`nxdl-chrome`) and watch the window. Try passing an explicit
  `file_id`.
- **`nxdl dl` returns 403** — expected on free accounts; use `nxdl-browser`.

---

## Caveats

- This automates **your own logged-in account** for personal use. Nexus Mods'
  Terms of Service discourage automated access — use it responsibly, keep
  volumes human, and don't redistribute mod files.
- The debug Chrome exposes port `9222` on localhost; any local process can
  control that browser while it runs. Close the debug window when not in use
  (`nxdl-browser` will relaunch it next time).
- `browser-dl.mjs` never stores your API key or cookies; the key is read at
  runtime from `~/.config/nexus-dl/key`.

## License

MIT — see [LICENSE](LICENSE).
