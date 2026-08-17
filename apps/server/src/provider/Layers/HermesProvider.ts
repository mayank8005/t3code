import {
  type HermesSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { HERMES_SETUP_AUTH_METHOD_ID, makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** `hermes --version` boots a Python CLI, so it gets more room than Grok's. */
const VERSION_PROBE_TIMEOUT_MS = 8_000;
/** `hermes acp` loads the full Hermes runtime before answering `initialize`. */
const HERMES_ACP_DISCOVERY_TIMEOUT_MS = 20_000;

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
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Derive auth status from the `authMethods` a Hermes `initialize` response
 * advertises. Hermes lists the configured model provider as an
 * agent-managed method when runtime credentials exist; a response carrying
 * only the `hermes-setup` terminal method means nothing is configured yet.
 */
export function parseHermesAuthFromAuthMethods(
  authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod> | null | undefined,
): ServerProviderAuth {
  for (const method of authMethods ?? []) {
    const id = method.id.trim();
    if (!id || id === HERMES_SETUP_AUTH_METHOD_ID) {
      continue;
    }
    const label = method.name.trim();
    return {
      status: "authenticated",
      type: id,
      ...(label ? { label } : {}),
    };
  }
  return { status: "unauthenticated" };
}

/**
 * Map a Hermes ACP `SessionModelState` to picker models. Hermes model ids
 * use the `provider:model` encoding produced by its `_encode_model_choice`;
 * the provider prefix is surfaced as `subProvider` so the picker can group
 * entries by the backing provider.
 */
export function buildHermesModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = model.modelId.trim();
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      const separatorIndex = slug.indexOf(":");
      const subProvider =
        separatorIndex > 0 && separatorIndex < slug.length - 1
          ? slug.slice(0, separatorIndex)
          : undefined;
      return {
        slug,
        name: model.name.trim() || slug,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

interface HermesAcpDiscoveryResult {
  readonly auth: ServerProviderAuth;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

const discoverHermesViaAcp = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return {
      auth: parseHermesAuthFromAuthMethods(started.initializeResult.authMethods),
      models: buildHermesModelsFromSessionModelState(started.sessionSetupResult.models),
    } satisfies HermesAcpDiscoveryResult;
  }).pipe(Effect.scoped);

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

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModelsFromSettings(hermesSettings.customModels);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
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
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes Agent CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute Hermes CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but timed out while running `hermes --version`.",
      },
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
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverHermesViaAcp(hermesSettings, environment).pipe(
    Effect.timeoutOption(HERMES_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Hermes ACP discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Hermes is installed but `hermes acp` failed to start. Install the ACP extra " +
          "(`cd ~/.hermes/hermes-agent && uv pip install -e '.[acp]'`) and check server logs.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Hermes ACP discovery timed out after ${HERMES_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Hermes ACP startup timed out after ${HERMES_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models =
    discovery.models.length > 0
      ? hermesModelsFromSettings(hermesSettings.customModels, discovery.models)
      : fallbackModels;

  if (discovery.auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: discovery.auth,
        message:
          "Hermes has no model provider configured. Run `hermes setup` (or `hermes model`) and try again.",
      },
    });
  }

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: discovery.auth,
    },
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
