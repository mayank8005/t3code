// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HermesSettings } from "@t3tools/contracts";

import { buildInitialHermesProviderSnapshot, checkHermesProviderStatus } from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const writeHermesWrapper = (input: {
  readonly prefix: string;
  readonly acpExitCode?: number;
  readonly acpStderr?: string;
  readonly invocationLogPath?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: input.prefix });
    const hermesPath = path.join(dir, "hermes");
    const logInvocation = input.invocationLogPath
      ? `printf "%s|%s\\n" "$*" "$HERMES_ACP_SKIP_CONFIGURED_MCP" >> ${shellSingleQuote(input.invocationLogPath)}`
      : ":";
    yield* fs.writeFileString(
      hermesPath,
      [
        "#!/bin/sh",
        logInvocation,
        'if [ "$1" = "--version" ]; then',
        '  printf "hermes 0.3.7\\n"',
        "  exit 0",
        "fi",
        'if [ "$1" != "acp" ] || [ "$2" != "--check" ]; then',
        '  printf "%s\\n" "unexpected args: $*" >&2',
        "  exit 11",
        "fi",
        ...(input.acpStderr
          ? [`printf "%s\\n" ${shellSingleQuote(input.acpStderr)} >&2`]
          : ['printf "ACP server module is installed and ready.\\n"']),
        `exit ${input.acpExitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(hermesPath, 0o755);
    return hermesPath;
  });

describe("buildInitialHermesProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );

  it.effect("uses Hermes' configured model as the default selection", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models).toEqual([
        expect.objectContaining({ slug: "default", isDefault: true, isCustom: false }),
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/hermes-binary",
        }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken hermes install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-version-" });
          const hermesPath = path.join(dir, "hermes");
          yield* fs.writeFileString(
            hermesPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(hermesPath, 0o755);
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Hermes CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("uses the side-effect-free ACP check and keeps custom model choices", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-ready-" });
        const invocationLogPath = NodePath.join(dir, "invocations.log");
        const hermesPath = yield* writeHermesWrapper({
          prefix: "t3code-hermes-wrapper-",
          invocationLogPath,
        });
        const snapshot = yield* checkHermesProviderStatus(
          decodeHermesSettings({
            enabled: true,
            binaryPath: hermesPath,
            customModels: ["openrouter:moonshotai/kimi-k2"],
          }),
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("0.3.7");
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.models.map((model) => [model.slug, model.isDefault])).toEqual([
          ["default", true],
          ["openrouter:moonshotai/kimi-k2", undefined],
        ]);
        expect((yield* fs.readFileString(invocationLogPath)).trim().split("\n")).toEqual([
          "--version|",
          "acp --check|1",
        ]);
      }),
    ),
  );

  it.effect("reports the missing ACP extra only for a matching import failure", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const hermesPath = yield* writeHermesWrapper({
            prefix: "t3code-hermes-acp-extra-",
            acpExitCode: 1,
            acpStderr: "No module named hermes_agent.acp",
          });
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("ACP extra");
    }),
  );

  it.effect("does not diagnose unrelated ACP failures as a missing extra", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const hermesPath = yield* writeHermesWrapper({
            prefix: "t3code-hermes-acp-failure-",
            acpExitCode: 1,
            acpStderr: "configured MCP server failed to authenticate",
          });
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("hermes acp --check");
      expect(snapshot.message).not.toContain("ACP extra");
    }),
  );

  it.effect("skips both probes when Hermes is disabled in settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-disabled-" });
        const invocationLogPath = path.join(dir, "invocations.log");
        const hermesPath = yield* writeHermesWrapper({
          prefix: "t3code-hermes-disabled-wrapper-",
          invocationLogPath,
        });
        const snapshot = yield* checkHermesProviderStatus(
          decodeHermesSettings({ enabled: false, binaryPath: hermesPath }),
        );

        expect(snapshot.status).toBe("disabled");
        expect(yield* fs.exists(invocationLogPath)).toBe(false);
      }),
    ),
  );
});
