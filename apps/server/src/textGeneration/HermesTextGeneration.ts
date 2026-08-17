import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type HermesSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const HERMES_TIMEOUT_MS = 180_000;
const HERMES_TEXT_GENERATION_TOOLSET = "todo";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function resolveHermesModelArgs(model: string): ReadonlyArray<string> {
  const trimmed = model.trim();
  const normalized = trimmed.toLowerCase();
  if (!trimmed || normalized === "default" || normalized === "auto") {
    return [];
  }
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return ["--model", trimmed];
  }
  return [
    "--provider",
    trimmed.slice(0, separatorIndex),
    "--model",
    trimmed.slice(separatorIndex + 1),
  ];
}

export const makeHermesTextGeneration = Effect.fn("makeHermesTextGeneration")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readStreamAsString = <E>(
    operation: TextGenerationOperation,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (output, chunk) => output + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("hermes", operation, cause, "Failed to collect process output"),
      ),
    );

  const runHermesJson = <S extends Schema.Top>(input: {
    readonly operation: TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const command = hermesSettings.binaryPath || "hermes";
      const args = [
        "--toolsets",
        HERMES_TEXT_GENERATION_TOOLSET,
        "--ignore-rules",
        ...resolveHermesModelArgs(input.modelSelection.model),
        "--oneshot",
        input.prompt,
      ];
      const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: input.cwd,
            env: environment,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              "hermes",
              input.operation,
              cause,
              "Failed to spawn Hermes CLI process",
            ),
          ),
        );

      const result = yield* Effect.all(
        [
          readStreamAsString(input.operation, child.stdout),
          readStreamAsString(input.operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError(
                "hermes",
                input.operation,
                cause,
                "Failed to read Hermes CLI exit code",
              ),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeoutOption(HERMES_TIMEOUT_MS));

      if (Option.isNone(result)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Hermes CLI request timed out.",
        });
      }

      const [stdout, stderr, exitCode] = result.value;
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: detail
            ? `Hermes CLI command failed: ${detail}`
            : `Hermes CLI command failed with code ${exitCode}.`,
        });
      }

      const output = stdout.trim();
      if (!output) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Hermes Agent returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(output)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Hermes Agent returned invalid structured output.",
              cause,
            }),
        ),
      );
    }).pipe(Effect.scoped);

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("HermesTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runHermesJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("HermesTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runHermesJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("HermesTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runHermesJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("HermesTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runHermesJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
