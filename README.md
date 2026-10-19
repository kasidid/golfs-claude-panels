# session-hub

A Claude Code mod: a right-hand panel with a Sessions tab and a status box under it.

- **Sessions tab** — lists your local, Remote Control and cloud sessions, and holds threaded messages with each one.
- **Status box** — shows the model and effort, host, cwd and git branch, your 5h and 7d limits with their reset times, and a context bar.

## Commands

- `/panel`
- `/sessions`

## Settings

Change settings with `/plugin configure`. The main one is `panelPercent` (the panel's share of the terminal width when it opens), default `30`.

## Install

```
/plugin install session-hub --marketplace kasidid/golfs-claude-panels
```
