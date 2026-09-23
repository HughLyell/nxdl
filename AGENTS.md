# AGENTS.md

Use these tools to download mods from Nexus Mods autonomously. All commands are
non-interactive. No browser extension is required.

## Preconditions

- `nxdl-chrome` is running (or will auto-start via `nxdl-browser`).
- Chrome is logged into nexusmods.com (the debug profile keeps this).
- API key exists at `~/.config/nexus-dl/key` (or `NEXUS_API_KEY` is set).

## Download a mod (primary task)

```bash
nxdl-browser <game_domain> <mod_id> [file_id] [outdir]
```

- `game_domain`: URL slug, e.g. `cyberpunk2077`, `skyrimspecialedition`.
- Omit `file_id` to download the mod's primary file.
- Default `outdir` is `~/Downloads`.
- Never install into game directories unless the user asks.

Success prints `SAVED <path>` and exits `0`. Use `NXDL_JSON=1` for
`{"ok":true,"file":"..."}`. Exit `1` = error, `2` = timeout.

To pick a specific file first:

```bash
nxdl files <game_domain> <mod_id>      # columns: FILE_ID VERSION SIZE NAME
```

## Other commands

```bash
nxdl whoami                 # verify key / premium status
nxdl mod <game> <mod_id>    # metadata
nxdl register               # install the nxm:// protocol handler
nxdl nxm "<nxm://...>"      # redeem a site-generated nxm link
```

## Rules

- The only free-account download path is `nxdl-browser`. `nxdl dl` (keyless API)
  is Premium-only and returns `403`.
- Do not print or commit the API key or GitHub tokens.
- Keep download volume human-scale; this automates the user's own account.
