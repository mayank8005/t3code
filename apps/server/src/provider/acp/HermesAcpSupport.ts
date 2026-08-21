import { type HermesSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Terminal-only setup is not a client authentication method. */
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

export type HermesAcpRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"] & {
  readonly steer: (
    text: string,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
};

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

const decodeSteerPromptResponse = Schema.decodeUnknownEffect(EffectAcpSchema.PromptResponse);

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<HermesAcpRuntime, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
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
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    // Steer prompts run outside the serialized prompt path (the active
    // prompt holds its permit for the whole turn), so cancel has to
    // interrupt them explicitly; track the live steer request fibers.
    const steerFibers = new Set<Fiber.Fiber<unknown, EffectAcpErrors.AcpError>>();
    return {
      ...runtime,
      cancel: Effect.suspend(() =>
        Effect.forEach(steerFibers, (fiber) => Fiber.interrupt(fiber).pipe(Effect.ignore), {
          discard: true,
        }),
      ).pipe(Effect.andThen(runtime.cancel)),
      steer: (text) =>
        Effect.gen(function* () {
          const started = yield* runtime.start();
          const fiber = yield* runtime
            .request("session/prompt", {
              sessionId: started.sessionId,
              prompt: [{ type: "text", text: `/steer ${text}` }],
            } satisfies EffectAcpSchema.PromptRequest)
            .pipe(Effect.forkIn(scope));
          steerFibers.add(fiber);
          const response = yield* Fiber.join(fiber).pipe(
            Effect.catchCause(
              (cause): Effect.Effect<unknown, EffectAcpErrors.AcpError> =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.succeed({
                      stopReason: "cancelled",
                    } satisfies EffectAcpSchema.PromptResponse)
                  : Effect.failCause(cause),
            ),
            Effect.ensuring(Effect.sync(() => steerFibers.delete(fiber))),
          );
          return yield* decodeSteerPromptResponse(response).pipe(
            Effect.mapError((cause) =>
              EffectAcpErrors.AcpRequestError.internalError(
                "Hermes returned an undecodable steer prompt response.",
                undefined,
                { cause },
              ),
            ),
          );
        }),
    };
  });

/** The default and auto sentinels keep Hermes' session-selected model. */
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
