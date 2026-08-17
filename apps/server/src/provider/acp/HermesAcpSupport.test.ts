import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  resolveHermesAcpAuthMethodId,
  resolveHermesAcpModelId,
} from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("runs `hermes acp` from PATH when no binary path is configured", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
    expect(buildHermesAcpSpawnInput(null, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
    expect(buildHermesAcpSpawnInput({ binaryPath: "" }, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary path and forwards the provided environment", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes" },
      "/tmp/project",
      {
        HERMES_HOME: "/home/dev/.hermes",
        OPENROUTER_API_KEY: "secret",
      },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        HERMES_HOME: "/home/dev/.hermes",
        OPENROUTER_API_KEY: "secret",
      },
    });
  });
});

describe("resolveHermesAcpAuthMethodId", () => {
  it("picks the provider method advertised alongside the setup method", () => {
    expect(
      resolveHermesAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [
          { id: "openrouter", name: "openrouter runtime credentials" },
          {
            type: "terminal",
            id: "hermes-setup",
            name: "Configure Hermes provider",
            args: ["--setup"],
          },
        ],
      } satisfies EffectAcpSchema.InitializeResponse),
    ).toBe("openrouter");
  });

  it("skips blank ids and trims the selected method id", () => {
    expect(
      resolveHermesAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [
          { id: "   ", name: "Blank" },
          { id: "  nous  ", name: "Nous runtime credentials" },
        ],
      } satisfies EffectAcpSchema.InitializeResponse),
    ).toBe("nous");
  });

  it("returns undefined when only the setup method (or nothing) is advertised", () => {
    expect(
      resolveHermesAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [
          {
            type: "terminal",
            id: "hermes-setup",
            name: "Configure Hermes provider",
            args: ["--setup"],
          },
        ],
      } satisfies EffectAcpSchema.InitializeResponse),
    ).toBeUndefined();
    expect(
      resolveHermesAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [],
      } satisfies EffectAcpSchema.InitializeResponse),
    ).toBeUndefined();
    expect(
      resolveHermesAcpAuthMethodId({
        protocolVersion: 1,
      } satisfies EffectAcpSchema.InitializeResponse),
    ).toBeUndefined();
  });
});

describe("resolveHermesAcpModelId", () => {
  it("treats the default/auto sentinels and empty selections as 'keep current'", () => {
    expect(resolveHermesAcpModelId(undefined)).toBeUndefined();
    expect(resolveHermesAcpModelId(null)).toBeUndefined();
    expect(resolveHermesAcpModelId("   ")).toBeUndefined();
    expect(resolveHermesAcpModelId("default")).toBeUndefined();
    expect(resolveHermesAcpModelId(" Auto ")).toBeUndefined();
  });

  it("passes concrete Hermes model ids through untouched apart from trimming", () => {
    expect(resolveHermesAcpModelId("  openrouter:moonshotai/kimi-k2  ")).toBe(
      "openrouter:moonshotai/kimi-k2",
    );
    expect(resolveHermesAcpModelId("nous:Hermes-4-405B")).toBe("nous:Hermes-4-405B");
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:qwen/qwen3-coder",
        requestedModelId: "openrouter:moonshotai/kimi-k2",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["openrouter:moonshotai/kimi-k2"]);
      expect(result).toBe("openrouter:moonshotai/kimi-k2");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:qwen/qwen3-coder",
        requestedModelId: "openrouter:qwen/qwen3-coder",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openrouter:qwen/qwen3-coder");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:qwen/qwen3-coder",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openrouter:qwen/qwen3-coder");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown hermes model id");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openrouter:qwen/qwen3-coder",
          requestedModelId: "nous:Hermes-4-405B",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
