# Hermes

Hermes Agent is Nous Research's open-source, self-improving agent. T3 Code drives it over ACP: it
launches `hermes acp` as a child process and talks to it over that connection, so Hermes keeps
owning its own models, credentials, and tools while T3 Code provides the chat, approvals, and
history.

Hermes support is marked **Early Access**. It works, but expect rougher edges than Codex or Claude.
For first-time setup, see [Install T3 Code](./install.md).

## Install Hermes

Install the [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) CLI:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

That installer includes Hermes' ACP support, so there is nothing else to install for T3 Code. If you
installed Hermes some other way, without its `[all]` extra, add ACP support yourself:

```bash
cd ~/.hermes/hermes-agent && uv pip install -e '.[acp]'
```

Then let Hermes configure a model provider and its credentials:

```bash
hermes setup
```

If you want Nous' hosted models and nothing else, `hermes setup --portal` does a one-shot Nous
Portal sign-in instead. Use `hermes model` at any point to change which models Hermes offers.

Check the CLI is installed and on your PATH:

```bash
hermes --version
```

Hermes updates itself with `hermes update`. T3 Code's provider update action runs that command for
you, so you can update from Settings instead of a terminal.

## Hermes Settings In T3 Code

Hermes has one setting, and the default is usually right:

```text
Display name: Hermes
Binary path: hermes
```

An empty `Binary path` means T3 Code uses whatever `hermes` resolves to on your PATH. Set an
absolute path when Hermes is installed somewhere your PATH does not cover.

You can add more than one Hermes provider, the same way as any other provider. Give each one a
display name and accent color so they are easy to tell apart in the model picker.

## Models

Hermes has no fixed model list. The picker includes **Hermes default**, which keeps the model
configured in Hermes. Manage that model with `hermes model`.

Add an explicit model id in the provider's Models section in Settings when you want another picker
choice. Model ids use `provider:model`, for example:

```text
openrouter:qwen/qwen3-coder
```

Switching models mid-thread works. T3 Code changes the model on the running Hermes session, so you
do not have to start a new thread.

## Signing In

Hermes owns its own authentication. There is no Hermes login button in T3 Code.

Provider status checks whether the CLI and its ACP support are installed. Hermes validates model
credentials when a session starts. If a session reports an authentication error, configure Hermes
with `hermes setup` in a terminal and try again.

## Permission Modes

Hermes has no plan mode, so the composer's Chat/Plan toggle is hidden for Hermes threads. The
[permission mode](./permission-modes.md) control is still there and still matters.

In **Supervised**, Hermes stays on its default ask-before-edits behavior: every permission prompt it
raises — file edits, sensitive paths, and anything else it asks about — surfaces in T3 Code and
waits for you to approve or reject it.

In **Auto-accept edits** and **Auto**, T3 Code puts Hermes in its accept-edits mode. Hermes then
applies edits inside your workspace and `/tmp` without asking, and still prompts for sensitive
paths outside them.

In **Full access**, T3 Code puts Hermes in its no-prompt mode, so it does not ask about edits for
the rest of the session. T3 Code also answers any prompt Hermes still raises by selecting its
session-scoped `allow_session` option. The approval lasts only for the active Hermes session; T3
Code never adds permissions to Hermes' permanent allowlist. Some prompts offer no session-scoped
choice — Hermes asks about file edits with allow-once or deny only — and those are allowed once
each.

Older Hermes builds may not offer these edit-approval modes. When that happens, T3 Code leaves
Hermes on its default and every prompt surfaces for approval as usual.

## Troubleshooting

**"Hermes Agent CLI (`hermes`) is not installed or not on PATH."**

T3 Code could not run `hermes` at all. Install the CLI, or set `Binary path` to the absolute path of
the `hermes` executable. If you installed Hermes in a shell whose PATH the T3 Code server does not
inherit, the absolute path is the quicker fix.

**"Hermes is installed without ACP support. Install the ACP extra..."**

Hermes runs, but its ACP server does not. This is almost always a Hermes installed without its
`[all]` extra, which is the one that brings ACP along. Add the extra directly:

```bash
cd ~/.hermes/hermes-agent && uv pip install -e '.[acp]'
```

Refresh provider status afterwards. If it still fails, run `hermes acp --check` in a terminal and
read the error it prints.

**"Hermes ACP health check failed. Run `hermes acp --check` for details."**

The CLI is installed, but its ACP self-check reported another problem. Run the command directly for
the specific error. Provider or model authentication errors appear when a Hermes session starts;
resolve those with `hermes setup` or `hermes model`.
