# claude-mods

Mods for Claude Code.

## work-timer

Shows how long Claude has actually been working, in the band above the prompt:

```
⏱ Trabajando 1m 05s  Sesión 14m 20s  Hoy 1h 02m
```

- Counts only while Claude runs a turn: time waiting for you to write is left out.
- Stops the clock while Claude waits on your answer to one of its questions (`⏸ Esperándote`).
- Subagents running in parallel count as wall-clock time, not summed.
- "Hoy" adds up every session on this machine today.

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
