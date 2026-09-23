# nxdl

Download mods from Nexus Mods from the command line, including on **free
(non-Premium) accounts**. Built for agents and scripts: non-interactive,
stable output, meaningful exit codes.

**No browser extension is required.** `nxdl-browser` drives your real Chrome
directly over the DevTools Protocol (CDP), which produces trusted input so the
site's "Slow download" button works.

## Requirements

- Linux with Chrome/Chromium (`google-chrome` or `chrome`)
- Node.js >= 18
- `curl`
- A Nexus Mods account, logged into Chrome

## Install

```bash
npm install
install -m755 bin/nxdl bin/nxdl-chrome bin/nxdl-browser ~/.local/bin/
mkdir -p ~/.local/share/nxdl
install -m644 src/browser-dl.mjs ~/.local/share/nxdl/browser-dl.mjs
npm install --prefix ~/.local/share/nxdl playwright-core

# personal API key: https://www.nexusmods.com/users/myaccount?tab=api
mkdir -p ~/.config/nexus-dl
printf '%s' 'YOUR_API_KEY' > ~/.config/nexus-dl/key
chmod 600 ~/.config/nexus-dl/key
```

## One-time setup

Log into Nexus Mods in Chrome, then:

```bash
nxdl-chrome     # starts Chrome with --remote-debugging-port=9222
```

It clones your Chrome profile to `~/.local/share/nxdl/chrome-profile` (keeps
your logins). Leave it running; `nxdl-browser` relaunches it when needed.

## Commands

```bash
nxdl-browser <game> <mod_id> [file_id] [outdir]   # download one mod (main entry)
nxdl-browser <nexusmods-files-url> [outdir]
nxdl-browser --batch <list-file> [--delay <sec>]  # download many, sequentially
nxdl whoami                                        # account / premium status
nxdl files <game> <mod_id>                         # file ids and sizes
nxdl mod <game> <mod_id>                           # metadata
nxdl register                                      # install nxm:// handler
nxdl nxm "<nxm://...>"                             # redeem an nxm link
```

Examples:

```bash
nxdl-browser cyberpunk2077 4198                 # main file -> ~/Downloads
nxdl-browser cyberpunk2077 107 123169 ~/mods    # specific file -> ~/mods
nxdl-browser --batch mods.txt --delay 5         # batch, 5s between items
```

Batch file format (one target per line, `#` comments allowed, `-` reads stdin):

```
# game                mod    file_id  outdir
cyberpunk2077         4198
cyberpunk2077         107    123169   ~/mods
skyrimspecialedition  191276
https://www.nexusmods.com/cyberpunk2077/mods/2380?tab=files&file_id=139049
```

`game` is the URL slug, e.g. `cyberpunk2077`, `skyrimspecialedition`.
If `file_id` is omitted, the primary file is resolved via the Nexus API.

## Output contract

Single download — one machine-readable line, exit `0`:

```
SAVED /home/user/Downloads/ArchiveXL 4198 1.27.3 ....zip
```

Batch — one line per item, then exit `0` only if all succeeded:

```
SAVED /home/user/Downloads/TweakXL ....zip
SAVED /home/user/Downloads/ArchiveXL ....zip
FAILED skyrimspecialedition/191276: timeout
```

Add `--json` (or `NXDL_JSON=1`) for JSON on stdout (logs go to stderr):

```json
{"ok":true,"file":"/home/user/Downloads/ArchiveXL ....zip"}
{"ok":false,"results":[{"target":"cyberpunk2077/4197/154092","ok":true,"file":"..."},
  {"target":"skyrimspecialedition/191276","ok":false,"error":"timeout"}],"succeeded":1,"failed":1}
```

Exit codes: `0` success, `1` error/any item failed, `2` timeout (no file).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `NEXUS_API_KEY` / `NEXUS_KEY_FILE` | `~/.config/nexus-dl/key` | API auth |
| `NXDL_JSON` | `0` | JSON output |
| `NXDL_DL_DIR` | `~/Downloads` | download folder |
| `NXDL_HOME` | `~/.local/share/nxdl` | where `browser-dl.mjs` lives |
| `NXDL_CDP` | `http://127.0.0.1:9222` | CDP endpoint |
| `NXDL_CDP_PORT` | `9222` | debug port |
| `NXDL_CHROME_PROFILE` | `~/.local/share/nxdl/chrome-profile` | debug profile |
| `NXDL_TIMEOUT_MS` | `240000` | per-download timeout |
| `NXDL_NODE` | `~/.nix-profile/bin/node` or `node` | node binary |

## Troubleshooting

- `401 Bad credentials` — regenerate the Nexus API key.
- `not logged in on this Chrome profile` — log into Nexus in the debug Chrome
  window once.
- Fix nothing else? Run `nxdl-chrome` and watch the window; pass an explicit
  `file_id` if the layout changed.
- `nxdl dl` returns `403` — keyless API download is Premium-only; use
  `nxdl-browser` (the only free-account path).

## Notes

- Automates your own logged-in account for personal use. Nexus Mods discourages
  automated access — keep volume human and do not redistribute files.
- The debug Chrome exposes port `9222` on localhost while it runs; close the
  window when idle.
- No secrets are stored by these tools; the API key is read at runtime.

## License

MIT
