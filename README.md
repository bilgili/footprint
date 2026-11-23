# Footprint

Footprint is a mod for Claude Code. It adds a pane with two sections. The Files section shows the tree of files the current session created, modified or deleted. It shows only those files, not the whole tree. The Runs section lists the commands that the session executed, grouped by program.

![The Footprint pane with demo data: a collapsible tree of the files one session added, modified and deleted, with a blue flash running up from the file that just changed](docs/footprint-pane.png)

*Demo data: the pane's real render output for a sample project, `/workspace/acme-shop`.*

## Install

Type this at the prompt of a Claude Code session:

```
/plugin install footprint --marketplace bilgili/footprint
```

Answer `y` to add the marketplace, then pick a scope. The pane opens with the next session on the desktop app. In the terminal, or after a close, type `/footprint`.

## What it shows

One tree from the filesystem root, one folder row per path segment, every folder collapsed until you press it. Drawn guide lines and a boxed `+`/`-` before each folder on the desktop app, VS Code and mobile; `│ ├─ └─` guide characters and a `+`/`-` in the terminal.

File names are colored by status: green for added, blue for modified, red and struck through for deleted. Long names are cut in the middle. A file the session created and then removed is hidden. When a file changes, the row that shows it flashes in its color and fades within 3 seconds: the file itself when it is visible, else its first collapsed parent folder. A press on an added or modified file opens it in the desktop app's file pane. For a file outside the working directory, the app first asks you to grant the file's folder to the session. After you approve, the folder stays granted for the session.

### Runs

Each section has a header row with a `+` or `-` (boxed on the desktop). A press on the header opens or closes the section. Files starts open. Runs starts closed and does not draw until the session runs a command. The Runs header shows the count of runs and, when a run failed, the count of failed runs.

An open Runs section shows one row for each program: `git`, `npm`, `rm` and so on. The mod takes the program from the first word of the command, after any `cd x &&`, `NAME=value` words and wrappers such as `sudo` and `env`. A group row shows the count and a mark for its worst status. A press on a group row opens it.

An open group shows one entry for each execution, newest first. An entry shows a status mark, the whole stored command line and the duration. A long command wraps, and its line breaks stay. The marks are `●` ok, `✕` failed, `◌` background and `■` interrupted. A press on the mark of an entry that has output shows or hides the last 1000 characters of that output. For a failed command, the output holds the exit code line. A background command and a `Monitor` have no output to show.

## How it works

The mod keeps a ledger in session state. Two sources feed it:

- **Tool source.** `Write`, `Edit` and `NotebookEdit` calls. The mod looks at the file before and after the call.
- **Bash source.** The mod walks the session root before and after each foreground Bash call and records the difference. It skips `.git`, `node_modules`, `build`, `dist`, `.venv` and similar folders. A tree over 20000 files turns Bash tracking off for that folder; a walk over 5 seconds skips that one call. The pane header says so.

The ledger stores two looks per path: the earliest (the baseline) and the latest. The status comes from those two looks. The merge is order-free, so concurrent calls give one answer.

A separate log feeds the Runs section. A hook wraps each `Bash` call and each `Monitor` call that has a command. It records the command, the start time, the duration, the status and the output tail. The log keeps the newest 100 runs. The state of the sections and groups lives in its own atom, apart from the state of the folders.

## Limits

- A change seen during a Bash call is counted whoever made it: an editor that saves in that window counts too.
- Background Bash calls are not tracked.
- A same-size rewrite inside the file system's mtime resolution is missed.
- `/clear` and `--resume` start an empty ledger.
- The pane works on the desktop app and in the terminal; the press-to-open needs the desktop app.
- The duration of a run is the wall time of the call. It includes the time that you spend on a permission prompt.
- The tool result has no exit code. A run shows `failed` when the call reports an error, and its output shows the exit code line.
- A background command and a `Monitor` stay `background`. The log gets no later update and no output for them.
- A command that you reject at the permission prompt, or that a permission rule or a setting denies, shows as `failed`: Claude Code reports it as an error. Only a deny from another mod's hook leaves no run.
- The log removes escape sequences and control characters from the command and the output. A progress bar that rewrites one line shows as one line of joined text.
- A command that a subagent runs has a run too.
- A command keeps its first 2000 characters. The program name comes from a word scan, not a shell parser: `bash -c "git push"` groups as `bash`, and `xargs git` groups as `xargs`.
- The `docs/footprint-pane.png` picture shows the pane from before the Files and Runs headers.
- A mod reload during a command loses that run.

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT
