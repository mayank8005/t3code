import { type HermesSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Hermes always advertises this terminal-type auth method so ACP registries
 * see at least one usable method on a fresh install. It launches Hermes'
 * interactive setup out-of-band and is never selectable from T3 Code, so
 * the auth resolver skips it when picking the `authenticate` method.
 */
export const HERMES_SETUP_AUTH_METHOD_ID = "hermes-setup";

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Pick the agent-managed auth method from a Hermes `initialize` response.
 *
 * Hermes advertises the currently-configured model provider (e.g.
 * `openrouter`, `nous`) as an agent-managed method when runtime credentials
 * exist, plus the always-present `hermes-setup` terminal method. Returns
 * the provider method id, or `undefined` when only the setup method is
 * advertised — in which case `authenticate` is skipped and the session
 * proceeds unauthenticated (Hermes does not gate `session/new` on auth).
 */
export function resolveHermesAcpAuthMethodId(
  initializeResult: EffectAcpSchema.InitializeResponse,
): string | undefined {
  for (const method of initializeResult.authMethods ?? []) {
    const id = method.id.trim();
    if (id && id !== HERMES_SETUP_AUTH_METHOD_ID) {
      return id;
    }
  }
  return undefined;
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: resolveHermesAcpAuthMethodId,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Normalize a T3 Code model selection into a Hermes ACP model id.
 *
 * Hermes model ids are `provider:model` pairs discovered from the user's
 * own configuration; there is no universal default slug. The `default` /
 * `auto` sentinels (and empty selections) mean "keep the model the session
 * is already configured with", signalled by returning `undefined`.
 */
export function resolveHermesAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "default" || normalized === "auto") {
    return undefined;
  }
  return trimmed;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
