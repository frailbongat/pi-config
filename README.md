# pi-config

My pi agent config. This repo *is* `~/.pi`.

It used to live in [frailbongat/dotfiles](https://github.com/frailbongat/dotfiles) under `pi/agent/`,
symlinked into place. That copy was removed on 2026-09-15 and this repo replaced it the next day.
If a machine still has the old symlinks, it is running config frozen at 2026-09-14. Follow the
setup below to replace it.

## New machine

```sh
git clone https://github.com/frailbongat/pi-config.git ~/.pi
~/.pi/setup.sh
```

`setup.sh` is safe to re-run. It rebuilds the three things `.gitignore` keeps out of the repo:

1. Dependency links for every extension, so `agent/extensions/*/node_modules/@earendil-works/`
   points at your global pi install.
2. The skills, by cloning [frailbongat/skills](https://github.com/frailbongat/skills) into `~/skills`
   and running its `install.sh`.
3. A list of the secret files you still have to supply by hand.

If `~/.pi` already exists from the old dotfiles setup, move it aside first:

```sh
mv ~/.pi ~/.pi.old
git clone https://github.com/frailbongat/pi-config.git ~/.pi
cp ~/.pi.old/agent/auth.json ~/.pi.old/agent/trust.json ~/.pi/agent/
~/.pi/setup.sh
```

## What is tracked

```text
agent/AGENTS.md          global agent instructions
agent/settings.json      theme, default model, packages
agent/extensions/        TypeScript extensions, including /ship
agent/skills/impeccable/ the one skill that lives here rather than in a skills repo
.codex/hooks.json        Codex hook config
```

## What is not, and why

Secrets, so they never reach GitHub:

```text
agent/auth.json           provider API keys
agent/cliproxyapi.json    proxy API key
agent/models-store.json   rebuilt on launch
```

Machine-local state, because it holds absolute paths for one machine only:

```text
agent/trust.json          trusted project paths
agent/bin/  agent/npm/    downloaded binaries and packages
agent/tmp/  *-cache*      caches, all rebuilt on launch
```

Private history:

```text
agent/sessions/           every chat
agent/missions/           subagent delegation records
learning/                 teaching workspaces
```

Skills, because nearly all of them are symlinks:

```text
agent/skills/*            minus impeccable, which is a real directory
```

Vendor skills point into `~/.agents/skills`. The ones I wrote point into `~/skills`, the
[frailbongat/skills](https://github.com/frailbongat/skills) repo. Committing either set would put
dangling symlinks on every other machine, so `setup.sh` recreates them instead.

## Extensions

`agent/extensions/ship/` is the `/ship` command. It commits, picks a destination, and pushes.

```text
/ship            commit and push, picking the destination itself
/ship main       force the trunk
/ship branch     force a branch
/ship refs       reference the issue as (refs #42) and leave it open
/ship verbose    show every step
/ship recheck    re-run the quality checks
```

Without the argument, `/ship` closes a referenced issue with `(closes #42)`. `refs` is the escape
hatch for work that moves a ticket forward without finishing it.

A clean tree is not always an empty ship. When an agent has already committed its own work, `/ship`
pushes those commits to the destination instead of saying there is nothing to do: no commit message
is written, the committed files are checked read-only, and nothing is rewritten. Since there is no
new commit subject, `refs` and `closes` have nowhere to go on that run, so close the ticket yourself.

`agent/extensions/ship/node_modules/` is two symlinks into the global pi package, not a real install.
`setup.sh` creates them. Without them the extension fails to load and `/ship` disappears.
