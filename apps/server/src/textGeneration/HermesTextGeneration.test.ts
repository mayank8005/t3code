// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const HERMES_SESSION_MODELS_JSON = JSON.stringify([
  { modelId: "openrouter:qwen/qwen3-coder", name: "Qwen3 Coder" },
  { modelId: "openrouter:moonshotai/kimi-k2", name: "Kimi K2" },
  { modelId: "nous:Hermes-4-405B", name: "Hermes 4 405B" },
]);
const HERMES_AUTH_METHODS_JSON = JSON.stringify([
  { id: "openrouter", name: "openrouter runtime credentials" },
  { type: "terminal", id: "hermes-setup", name: "Configure Hermes provider", args: ["--setup"] },
]);
const ALT_MODEL_ID = "openrouter:moonshotai/kimi-k2";

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const HermesTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpHermesWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const hermesPath = NodePath.join(binDir, "hermes");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    hermesPath,
    [
      "#!/bin/sh",
      `export T3_ACP_SESSION_MODELS=${shellSingleQuote(HERMES_SESSION_MODELS_JSON)}`,
      `export T3_ACP_AUTH_METHODS=${shellSingleQuote(HERMES_AUTH_METHODS_JSON)}`,
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(hermesPath, 0o755);
  return hermesPath;
}

function withFakeAcpHermes<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpHermesWrapper(tempDir, env);
    const config = decodeHermesSettings({ binaryPath });
    const textGeneration = yield* makeHermesTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(HermesTextGenerationTestLayer)("HermesTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpHermes(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Hermes provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/hermes",
            stagedSummary: "M apps/server/src/provider/Layers/HermesAdapter.ts",
            stagedPatch: "diff --git a/.../HermesAdapter.ts b/.../HermesAdapter.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
          });

          expect(generated.subject).toBe("Add Hermes provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_model" && request.params?.modelId === ALT_MODEL_ID,
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("keeps the configured Hermes model when the selection is the default sentinel", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-default-model-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpHermes(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Keep the configured model" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), "default"),
          });

          expect(generated.title).toBe("Keep the configured model");
          const requests = readJsonRpcRequests(requestLogPath);
          expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
        }),
    );
  });

  it.effect("extracts the JSON object when Hermes wraps it in conversational text", () =>
    withFakeAcpHermes(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
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

  it.effect("surfaces ACP request failures as text generation errors", () =>
    withFakeAcpHermes(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up hermes",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("hermes"),
                "openrouter:missing-hermes-model",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("Failed to set Hermes ACP model");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpHermes(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeAcpHermes(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "feat(hermes): wire up session/set_model",
          body: "## Summary\n- Switch models through the typed ACP `session/set_model`.\n- Skip the switch for the `default` sentinel.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/hermes-provider",
            commitSummary: "feat: add hermes provider",
            diffSummary: "M apps/server/src/provider/Layers/HermesAdapter.ts",
            diffPatch: "diff --git a/.../HermesAdapter.ts b/.../HermesAdapter.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
          });

          expect(generated.title).toBe("feat(hermes): wire up session/set_model");
          expect(generated.body).toContain("Skip the switch for the `default` sentinel.");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAcpHermes(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), ALT_MODEL_ID),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );
});
