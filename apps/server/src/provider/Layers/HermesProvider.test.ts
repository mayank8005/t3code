// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { HermesSettings } from "@t3tools/contracts";

import {
  buildHermesModelsFromSessionModelState,
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  parseHermesAuthFromAuthMethods,
} from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

const HERMES_SESSION_MODELS_JSON = JSON.stringify([
  { modelId: "openrouter:qwen/qwen3-coder", name: "Qwen3 Coder" },
  { modelId: "openrouter:moonshotai/kimi-k2", name: "Kimi K2" },
  { modelId: "nous:Hermes-4-405B", name: "Hermes 4 405B" },
]);
const HERMES_AUTH_METHODS_JSON = JSON.stringify([
  { id: "openrouter", name: "openrouter runtime credentials" },
  { type: "terminal", id: "hermes-setup", name: "Configure Hermes provider", args: ["--setup"] },
]);
const HERMES_SETUP_ONLY_AUTH_METHODS_JSON = JSON.stringify([
  { type: "terminal", id: "hermes-setup", name: "Configure Hermes provider", args: ["--setup"] },
]);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Writes a `hermes` stand-in that answers `--version` itself and hands
 * `hermes acp` to the shared mock ACP agent, so the provider probe walks its
 * real version-then-ACP-discovery path.
 */
const writeHermesWrapper = (input: {
  readonly prefix: string;
  readonly authMethodsJson?: string;
  readonly acpFails?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: input.prefix });
    const hermesPath = path.join(dir, "hermes");
    yield* fs.writeFileString(
      hermesPath,
      [
        "#!/bin/sh",
        `export T3_ACP_SESSION_MODELS=${shellSingleQuote(HERMES_SESSION_MODELS_JSON)}`,
        `export T3_ACP_AUTH_METHODS=${shellSingleQuote(
          input.authMethodsJson ?? HERMES_AUTH_METHODS_JSON,
        )}`,
        'if [ "$1" = "--version" ]; then',
        '  printf "hermes 0.3.7\\n"',
        "  exit 0",
        "fi",
        'if [ "$1" != "acp" ]; then',
        '  printf "%s\\n" "unexpected args: $*" >&2',
        "  exit 11",
        "fi",
        ...(input.acpFails
          ? ['printf "%s\\n" "No module named hermes_agent.acp" >&2', "exit 1"]
          : [`exec ${shellSingleQuote(mockAgentCommand)} ${shellSingleQuote(mockAgentPath)}`]),
        "",
      ].join("\n"),
    );
    yield* fs.chmod(hermesPath, 0o755);
    return hermesPath;
  });

describe("parseHermesAuthFromAuthMethods", () => {
  it("treats an agent-managed provider method as configured credentials", () => {
    expect(
      parseHermesAuthFromAuthMethods([
        { id: "openrouter", name: "openrouter runtime credentials" },
        {
          type: "terminal",
          id: "hermes-setup",
          name: "Configure Hermes provider",
          args: ["--setup"],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.AuthMethod>),
    ).toEqual({
      status: "authenticated",
      type: "openrouter",
      label: "openrouter runtime credentials",
    });
  });

  it("omits the label when the method name is blank and skips blank ids", () => {
    expect(
      parseHermesAuthFromAuthMethods([
        { id: "   ", name: "Blank id" },
        { id: "nous", name: "   " },
      ] satisfies ReadonlyArray<EffectAcpSchema.AuthMethod>),
    ).toEqual({ status: "authenticated", type: "nous" });
  });

  it("reports unauthenticated when only the setup method (or nothing) is advertised", () => {
    expect(
      parseHermesAuthFromAuthMethods([
        {
          type: "terminal",
          id: "hermes-setup",
          name: "Configure Hermes provider",
          args: ["--setup"],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.AuthMethod>),
    ).toEqual({ status: "unauthenticated" });
    expect(parseHermesAuthFromAuthMethods([])).toEqual({ status: "unauthenticated" });
    expect(parseHermesAuthFromAuthMethods(null)).toEqual({ status: "unauthenticated" });
    expect(parseHermesAuthFromAuthMethods(undefined)).toEqual({ status: "unauthenticated" });
  });
});

describe("buildHermesModelsFromSessionModelState", () => {
  it("surfaces the provider prefix as subProvider and falls back to the slug for names", () => {
    const models = buildHermesModelsFromSessionModelState({
      currentModelId: "openrouter:qwen/qwen3-coder",
      availableModels: [
        { modelId: "  openrouter:qwen/qwen3-coder  ", name: "  Qwen3 Coder  " },
        { modelId: "nous:Hermes-4-405B", name: "   " },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map((model) => [model.slug, model.name, model.subProvider])).toEqual([
      ["openrouter:qwen/qwen3-coder", "Qwen3 Coder", "openrouter"],
      ["nous:Hermes-4-405B", "nous:Hermes-4-405B", "nous"],
    ]);
    expect(models.every((model) => model.isCustom === false)).toBe(true);
  });

  it("omits subProvider when the id has no usable provider prefix", () => {
    const models = buildHermesModelsFromSessionModelState({
      currentModelId: "plain",
      availableModels: [
        { modelId: "plain", name: "Plain" },
        { modelId: ":x", name: "Leading separator" },
        { modelId: "x:", name: "Trailing separator" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map((model) => model.slug)).toEqual(["plain", ":x", "x:"]);
    expect(models.every((model) => model.subProvider === undefined)).toBe(true);
  });

  it("drops blank ids, dedupes repeated ids, and returns [] without model state", () => {
    const models = buildHermesModelsFromSessionModelState({
      currentModelId: "nous:Hermes-4-405B",
      availableModels: [
        { modelId: "   ", name: "Blank" },
        { modelId: "nous:Hermes-4-405B", name: "Hermes 4 405B" },
        { modelId: "nous:Hermes-4-405B", name: "Hermes 4 405B (duplicate)" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map((model) => model.slug)).toEqual(["nous:Hermes-4-405B"]);
    expect(buildHermesModelsFromSessionModelState(null)).toEqual([]);
    expect(buildHermesModelsFromSessionModelState(undefined)).toEqual([]);
    expect(
      buildHermesModelsFromSessionModelState({
        currentModelId: "nous:Hermes-4-405B",
        availableModels: [],
      } satisfies EffectAcpSchema.SessionModelState),
    ).toEqual([]);
  });
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
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("Checking Hermes");
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
      expect(snapshot.enabled).toBe(true);
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

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Hermes CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports version, auth, and ACP-discovered models when Hermes is configured", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const hermesPath = yield* writeHermesWrapper({ prefix: "t3code-hermes-ready-" });
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.3.7");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "openrouter",
        label: "openrouter runtime credentials",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "openrouter:qwen/qwen3-coder",
        "openrouter:moonshotai/kimi-k2",
        "nous:Hermes-4-405B",
      ]);
      expect(snapshot.models.map((model) => model.subProvider)).toEqual([
        "openrouter",
        "openrouter",
        "nous",
      ]);
    }),
  );

  it.effect("asks the user to run `hermes setup` when no model provider is configured", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const hermesPath = yield* writeHermesWrapper({
            prefix: "t3code-hermes-unauthenticated-",
            authMethodsJson: HERMES_SETUP_ONLY_AUTH_METHODS_JSON,
          });
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth).toEqual({ status: "unauthenticated" });
      expect(snapshot.message).toContain("hermes setup");
    }),
  );

  it.effect("reports the missing ACP extra when `hermes acp` fails to start", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const hermesPath = yield* writeHermesWrapper({
            prefix: "t3code-hermes-acp-failure-",
            acpFails: true,
          });
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.3.7");
      expect(snapshot.message).toContain("ACP extra");
    }),
  );

  it.effect("skips both probes when Hermes is disabled in settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-disabled-" });
        const hermesPath = path.join(dir, "hermes");
        const invocationLogPath = path.join(dir, "invocations.log");
        yield* fs.writeFileString(
          hermesPath,
          [
            "#!/bin/sh",
            `printf "%s\\n" "$*" >> ${shellSingleQuote(invocationLogPath)}`,
            "exit 0",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(hermesPath, 0o755);

        const snapshot = yield* checkHermesProviderStatus(
          decodeHermesSettings({ enabled: false, binaryPath: hermesPath }),
        );

        expect(snapshot.enabled).toBe(false);
        expect(snapshot.status).toBe("disabled");
        expect(snapshot.installed).toBe(false);
        expect(snapshot.message).toContain("disabled");
        expect(yield* fs.exists(invocationLogPath)).toBe(false);
      }),
    ),
  );
});
