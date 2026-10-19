# golfs-claude-panels

Mods for [Claude Code](https://claude.com/claude-code).

## session-hub

A panel on the right of Claude Code's fullscreen layout, opened by itself when a session starts (or with `/panel`).

Tabs:

1. **Tasks**: what Claude is doing now, what's next and what's done, from its task list or an approved plan.
2. **Sessions**: your other Claude Code sessions on this PC, over Remote Control and in the cloud.
   - Message any of them in a thread.
   - See which one is waiting on you (a question, a permission prompt or a plan to approve).
   - Rename the ones on this PC with ✎.
3. **Links**: file paths and web links from Claude's answers and the files it writes, ctrl+click to open.
4. **Services** (when set): up/down checks for addresses you list. A ComfyUI address also shows its GPU, free VRAM and queue.

Under the tabs, a status box shows the model and effort, host, folder and git branch, your 5-hour and 7-day limits with reset times, and context use.

It also pings you (a phone push when you're away, a chime when you're at the desk) when a long turn or another session finishes.

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-hub --marketplace kasidid/golfs-claude-panels
```

Answer `y` to add the marketplace, then pick a scope (user scope is the first choice).

From a shell:

```
claude plugin install session-hub --marketplace kasidid/golfs-claude-panels
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `kasidid/golfs-claude-panels`, then Add plugin.

### Settings

`/plugin configure session-hub@golfs-claude-panels`:

| Setting | Default | What it does |
|---|---|---|
| Panel on the right in fullscreen | on | Open the panel by itself in the fullscreen layout |
| Panel width | 30 | Its share of the terminal, in % (15 to 60) |
| Services tab | empty | `name=URL` pairs to watch, e.g. `gpu=http://my-pc:8188, ollama=http://localhost:11434` |
| Refresh every | 15 s | How often the session list refreshes |
| Ping after turns longer than | 60 s | 0 turns it off |
| Ping when a peer session finishes | on | |
| Chime when you're at the desk | on | Windows only |
| Show the sessions band | on | A one-line summary above the prompt outside fullscreen |

Notes:

- **Other sessions:** "needs you" and rename work between sessions on the same PC that all have session-hub loaded.
- **Icons:** the status box uses plain Unicode symbols, so no Nerd Font is needed.
