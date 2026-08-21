import {
  type HermesSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const HERMES_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Hermes default",
  isDefault: true,
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const HERMES_ACP_CHECK_TIMEOUT_MS = 8_000;

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = hermesModelsFromSettings(hermesSettings.customModels);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes Agent availability...",
      },
    });
  });
}

function hermesModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([HERMES_DEFAULT_MODEL], customModels ?? [], EMPTY_CAPABILITIES);
}

const runHermesVersionCommand = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const runHermesAcpCheckCommand = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const probeEnvironment = {
      ...environment,
      HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
    };
    const args = ["acp", "--check"];
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: probeEnvironment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: probeEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  });

function hermesAcpCheckFailureMessage(stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.toLowerCase();
  if (output.includes("no module named") && output.includes("acp")) {
    return (
      "Hermes is installed without ACP support. Install the ACP extra " +
      "(`cd ~/.hermes/hermes-agent && uv pip install -e '.[acp]'`)."
    );
  }
  return "Hermes ACP health check failed. Run `hermes acp --check` for details.";
}

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModelsFromSettings(hermesSettings.customModels);
  const snapshot = (probe: ProviderProbeResult) =>
    buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe,
    });

  if (!hermesSettings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Hermes is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runHermesVersionCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Hermes CLI health check failed.", {
      errorTag: error._tag,
    });
    return snapshot({
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? "Hermes Agent CLI (`hermes`) is not installed or not on PATH."
        : "Failed to execute Hermes CLI health check.",
    });
  }

  if (Option.isNone(versionResult.success)) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes CLI is installed but timed out while running `hermes --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Hermes CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes CLI is installed but failed to run.",
    });
  }

  const acpCheckResult = yield* runHermesAcpCheckCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(HERMES_ACP_CHECK_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(acpCheckResult)) {
    yield* Effect.logWarning("Hermes ACP health check failed", {
      errorTag: acpCheckResult.failure._tag,
    });
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to execute `hermes acp --check`.",
    });
  }
  if (Option.isNone(acpCheckResult.success)) {
    yield* Effect.logWarning(
      `Hermes ACP health check timed out after ${HERMES_ACP_CHECK_TIMEOUT_MS}ms.`,
    );
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `Hermes ACP health check timed out after ${HERMES_ACP_CHECK_TIMEOUT_MS}ms.`,
    });
  }

  const acpCheckOutput = acpCheckResult.success.value;
  if (acpCheckOutput.code !== 0) {
    yield* Effect.logWarning("Hermes ACP health check exited with a non-zero status.", {
      exitCode: acpCheckOutput.code,
      stdoutLength: acpCheckOutput.stdout.length,
      stderrLength: acpCheckOutput.stderr.length,
    });
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: hermesAcpCheckFailureMessage(acpCheckOutput.stdout, acpCheckOutput.stderr),
    });
  }

  return snapshot({
    installed: true,
    version,
    status: "ready",
    auth: { status: "unknown" },
  });
});

export const enrichHermesSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
