// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const ALT_MODEL_ID = "openrouter:moonshotai/kimi-k2";

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const HermesTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeHermesWrapper(
  dir: string,
  input: { readonly output: string; readonly exitCode?: number; readonly argsPath?: string },
): string {
  const binDir = NodePath.join(dir, "bin");
  const hermesPath = NodePath.join(binDir, "hermes");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    hermesPath,
    [
      "#!/bin/sh",
      "valid_toolset=",
      "previous=",
      'for arg in "$@"; do',
      '  if [ "$previous" = "--toolsets" ] && [ "$arg" = "todo" ]; then',
      "    valid_toolset=1",
      "  fi",
      '  previous="$arg"',
      "done",
      'if [ "$valid_toolset" != "1" ]; then',
      '  printf "%s" "hermes -z: --toolsets did not contain any valid toolsets." >&2',
      "  exit 2",
      "fi",
      ...(input.argsPath ? [`printf "%s\\0" "$@" > ${shellSingleQuote(input.argsPath)}`] : []),
      `printf "%s" ${shellSingleQuote(input.output)}`,
      `exit ${input.exitCode ?? 0}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(hermesPath, 0o755);
  return hermesPath;
}

function withFakeHermes<A, E, R>(
  input: { readonly output: string; readonly exitCode?: number; readonly argsPath?: string },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const textGeneration = yield* makeHermesTextGeneration(
      decodeHermesSettings({ binaryPath: makeHermesWrapper(tempDir, input) }),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readArgs(filePath: string): ReadonlyArray<string> {
  return NodeFS.readFileSync(filePath, "utf8").split("\0").filter(Boolean);
}

it.layer(HermesTextGenerationTestLayer)("HermesTextGeneration", (it) => {
  it.effect("uses one-shot mode with a restricted Hermes toolset and forwards the model", () => {
    const argsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-hermes-args-"));
    const argsPath = NodePath.join(argsDir, "args");
    return withFakeHermes(
      {
        argsPath,
        output: JSON.stringify({
          subject: "Add Hermes provider",
          body: "Use safe one-shot text generation.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/hermes",
            stagedSummary: "M apps/server/src/textGeneration/HermesTextGeneration.ts",
            stagedPatch: "diff --git a/.../HermesTextGeneration.ts b/.../HermesTextGeneration.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
          });

          expect(generated).toEqual({
            subject: "Add Hermes provider",
            body: "Use safe one-shot text generation.",
          });
          const args = readArgs(argsPath);
          expect(args).toContain("--oneshot");
          expect(args).toContain("--ignore-rules");
          expect(args.slice(args.indexOf("--toolsets"), args.indexOf("--toolsets") + 2)).toEqual([
            "--toolsets",
            "todo",
          ]);
          expect(args).not.toContain("acp");
          expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4)).toEqual([
            "--provider",
            "openrouter",
            "--model",
            "moonshotai/kimi-k2",
          ]);
        }),
    );
  });

  it.effect("keeps the configured Hermes model for the default sentinel", () => {
    const argsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-hermes-default-"));
    const argsPath = NodePath.join(argsDir, "args");
    return withFakeHermes(
      { argsPath, output: JSON.stringify({ title: "Keep the configured model" }) },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), "default"),
          });
          expect(generated.title).toBe("Keep the configured model");
          expect(readArgs(argsPath)).not.toContain("--model");
          expect(readArgs(argsPath)).not.toContain("--provider");
        }),
    );
  });

  it.effect("extracts JSON from conversational output", () =>
    withFakeHermes(
      {
        output:
          "Sure! Here's a title:\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("surfaces CLI failures as text generation errors", () =>
    withFakeHermes({ output: "provider authentication failed", exitCode: 2 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "wire up hermes",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toContain("provider authentication failed");
      }),
    ),
  );

  it.effect("fails when output is empty", () =>
    withFakeHermes({ output: "" }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
          }),
        );
        expect(error.detail).toMatch(/empty/i);
      }),
    ),
  );

  it.effect("fails when output is not valid structured JSON", () =>
    withFakeHermes({ output: "totally not json" }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
          }),
        );
        expect(error.detail).toMatch(/invalid structured output/i);
      }),
    ),
  );
});
