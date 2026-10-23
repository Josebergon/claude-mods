# claude-mods

Mods for Claude Code.

## work-timer

Shows how long Claude has actually been working, in the band above the prompt:

```
● Trabajando 1m 23s  ▂▃▁▄▆▂▁▅█▃▂▃  Sesión 23m 38s  Hoy 23m 38s
```

- A status dot in the theme's colors: Claude orange while working (it breathes with the clock), violet while waiting on you, green once a turn ends.
- A sparkline of the last 12 turns, the running one in orange: drawn as SVG in the desktop app, as block bars in the terminal.
- Counts only while Claude runs a turn: time waiting for you to write is left out.
- Stops the clock while Claude waits on your answer to one of its questions (`⏸ Esperándote`).
- Subagents running in parallel count as wall-clock time, not summed.
- "Hoy" adds up every session on this machine today, each turn once even if the mod is loaded twice.
- A session reopened later (a new day, a restart) carries on with its own time and bars; sessions untouched for 30 days are forgotten.

Permission prompts are not subtracted (mods cannot see that wait).

### Install

At the prompt of a terminal session:

```
/plugin install work-timer --marketplace Josebergon/claude-mods
```

From a shell:

```bash
claude plugin install work-timer --marketplace Josebergon/claude-mods
```

In the Claude desktop app (Code tab): click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Josebergon/claude-mods`, then **Add plugin**.

Requires a Claude Code build with mods (function hooks); written against 2.1.308.
