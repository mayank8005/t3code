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

T3 Code talks to Hermes over ACP, which is an optional extra. Install it once, or T3 Code will not
be able to start Hermes:

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

Hermes has no fixed model list. T3 Code asks Hermes for its models when it connects, so the picker
shows exactly what your own Hermes configuration exposes.

Model ids are `provider:model` pairs, for example:

```text
openrouter:qwen/qwen3-coder
```

The picker groups models by the part before the colon, so everything behind one backing provider
stays together.

Selecting `default` does not pick a model. It keeps whatever model Hermes is already configured
with, which is what you want if you manage models through `hermes model`.

Switching models mid-thread works. T3 Code changes the model on the running Hermes session, so you
do not have to start a new thread.

If Hermes exposes a model T3 Code did not discover, add the slug by hand in the provider's Models
section in Settings.

## Signing In

Hermes owns its own authentication. There is no Hermes login button in T3 Code.

T3 Code reports Hermes as authenticated or unauthenticated based on what `hermes acp` advertises
when it starts. If Settings shows Hermes as unauthenticated, run `hermes setup` in a terminal, then
refresh provider status.

## Permission Modes

Hermes has no plan mode, so the composer's Chat/Plan toggle is hidden for Hermes threads. The
[permission mode](./permission-modes.md) control is still there and still matters.

In every mode except **Full access**, each permission prompt Hermes raises — file edits, sensitive
paths, and anything else it asks about — surfaces in T3 Code and waits for you to approve or reject
it.

In **Full access**, T3 Code answers those prompts for you. It prefers Hermes' "always allow" option
when Hermes offers one, and Hermes may remember that choice for later.

## Troubleshooting

**"Hermes Agent CLI (`hermes`) is not installed or not on PATH."**

T3 Code could not run `hermes` at all. Install the CLI, or set `Binary path` to the absolute path of
the `hermes` executable. If you installed Hermes in a shell whose PATH the T3 Code server does not
inherit, the absolute path is the quicker fix.

**"Hermes is installed but `hermes acp` failed to start. Install the ACP extra
(`cd ~/.hermes/hermes-agent && uv pip install -e '.[acp]'`) and check server logs."**

Hermes runs, but its ACP server does not. This is almost always the missing ACP extra:

```bash
cd ~/.hermes/hermes-agent && uv pip install -e '.[acp]'
```

Refresh provider status afterwards. If it still fails, run `hermes acp` in a terminal and read the
error it prints.

**"Hermes has no model provider configured. Run `hermes setup` (or `hermes model`) and try again."**

Hermes started, but it has no credentials for any model provider, so there is nothing to run a turn
with. Run `hermes setup` (or `hermes setup --portal`), pick models with `hermes model`, then refresh
provider status.
