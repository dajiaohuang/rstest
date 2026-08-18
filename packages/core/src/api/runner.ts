import {
  cleanCoverageReports,
  createCoverageProviderWithLog,
} from '../coverage';
import { ensureRunDependencies } from '../core/dependencies';
import { createNodeExecutor } from '../core/executors/nodeExecutor';
import {
  finalizeRunCycle,
  notifyReportersOnTestRunStart,
} from '../core/finalizeRun';
import { GLOBAL_TEARDOWN_ERROR, runGlobalTeardown } from '../core/globalSetup';
import { createTestPlanner } from '../core/planner';
import type { Rstest } from '../core/rstest';
import { isNodeProject } from '../core/isBrowserProject';
import { resetRunCycleState } from '../core/watchState';
import { BlobReporter } from '../reporter/blob';
import { createTraceController, filterFiles, formatError } from '../utils';
import { disposeBuiltInReporters } from './reporters';
import { createErrorResult, createResultReporter } from './result';
import type {
  RstestRunner,
  RunnerBuildResult,
  RunnerRunOptions,
  TestRunResult,
} from './types';

const CLOSED_ERROR = 'Rstest runner is closed.';
const NOT_BUILT_ERROR = 'Rstest runner must be built before run().';
const ALREADY_BUILT_ERROR = 'Rstest runner has already been built.';

const withCycleOptions = async <T>(
  context: Rstest,
  options: RunnerRunOptions,
  run: () => Promise<T>,
): Promise<T> => {
  const configs = [
    context.normalizedConfig,
    ...context.projects.map((project) => project.normalizedConfig),
  ];
  const previous = configs.map((config) => ({
    testNamePattern: config.testNamePattern,
    bail: config.bail,
    passWithNoTests: config.passWithNoTests,
  }));
  const previousUpdate = context.snapshotManager.options.updateSnapshot;

  for (const config of configs) {
    if (options.testNamePattern !== undefined) {
      config.testNamePattern = options.testNamePattern;
    }
    if (options.bail !== undefined) {
      config.bail = Number(options.bail);
    }
    if (options.passWithNoTests !== undefined) {
      config.passWithNoTests = options.passWithNoTests;
    }
  }
  if (options.update !== undefined) {
    context.snapshotManager.options.updateSnapshot = options.update
      ? 'all'
      : 'none';
  }

  try {
    return await run();
  } finally {
    configs.forEach((config, index) => {
      const values = previous[index]!;
      config.testNamePattern = values.testNamePattern;
      config.bail = values.bail;
      config.passWithNoTests = values.passWithNoTests;
    });
    context.snapshotManager.options.updateSnapshot = previousUpdate;
  }
};

export function createProgrammaticRunner(context: Rstest): RstestRunner {
  if (context.reporters.some((reporter) => reporter instanceof BlobReporter)) {
    throw new Error(
      'createRunner() does not support the blob reporter. Use run() to generate a one-shot blob report.',
    );
  }

  const traceController = createTraceController({
    enabled: context.trace,
    rootPath: context.rootPath,
  });
  let traceRun = traceController.beginRun();
  let buildResult: RunnerBuildResult | undefined;
  let buildPromise: Promise<RunnerBuildResult> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let runQueue = Promise.resolve();
  let buildId = 0;
  let executor: ReturnType<typeof createNodeExecutor> | undefined;
  let globalSetupFailure: Array<Error | string> | undefined;
  let coverageProvider: Awaited<
    ReturnType<typeof createCoverageProviderWithLog>
  >;

  return {
    build(): Promise<RunnerBuildResult> {
      if (closed) {
        return Promise.reject(new Error(CLOSED_ERROR));
      }
      if (buildPromise) {
        return Promise.reject(new Error(ALREADY_BUILT_ERROR));
      }

      buildPromise = (async () => {
        const nodeProjects = context.projects.filter(isNodeProject);
        const planner = await createTestPlanner(context, {
          browserProjects: [],
          nodeProjects,
          isWatchMode: false,
        });
        const coveragePluginLoadError = planner.coveragePluginLoadError();
        if (coveragePluginLoadError && planner.hasNodeTestsToRun()) {
          throw coveragePluginLoadError;
        }

        if (planner.hasNodeTestsToRun()) {
          await ensureRunDependencies({
            projects: [],
            rootPath: context.rootPath,
            coverage: context.normalizedConfig.coverage,
          });
        }
        coverageProvider = coveragePluginLoadError
          ? null
          : await createCoverageProviderWithLog(
              context.normalizedConfig.coverage,
              context.rootPath,
            );

        if (planner.nodeBuild) {
          executor = createNodeExecutor(context, {
            ...planner.nodeBuild,
            getPlan: planner.getPlan,
            coverageProvider,
            isWatchMode: false,
            getTraceRun: () => traceRun,
            onGlobalSetupFailure: (errors) => {
              globalSetupFailure ??= [];
              globalSetupFailure.push(...errors.map(formatError));
            },
          });
          await executor.init();
          await executor.ensureRunResources();
        }

        buildResult = { testFiles: await planner.globTestEntries() };
        return { testFiles: [...buildResult.testFiles] };
      })();
      return buildPromise;
    },

    async run(options: RunnerRunOptions = {}): Promise<TestRunResult> {
      if (closed) {
        throw new Error(CLOSED_ERROR);
      }
      if (!buildResult) {
        throw new Error(NOT_BUILT_ERROR);
      }

      const testFiles = buildResult.testFiles;
      const queuedRun = runQueue.then(async () => {
        if (globalSetupFailure) {
          const originalMessage = globalSetupFailure
            .map((error) => (typeof error === 'string' ? error : error.message))
            .join('; ');
          const error = new Error(
            `Global setup has already failed for this runner. Create a new runner to retry global setup.${originalMessage ? ` Original error: ${originalMessage}` : ''}`,
          );
          error.cause = globalSetupFailure[0];
          return createErrorResult(error);
        }

        const selectedFiles =
          options.filters === undefined
            ? testFiles
            : filterFiles(
                testFiles,
                options.filters,
                context.rootPath,
                options.filterMode,
              );
        const capture = createResultReporter(context);
        context.reporters.push(capture.reporter);
        const result = capture.nextResult();

        try {
          return await withCycleOptions(context, options, async () => {
            resetRunCycleState(context, {
              resetSnapshot: true,
            });
            cleanCoverageReports(context.normalizedConfig.coverage);
            traceRun = traceController.beginRun();

            await notifyReportersOnTestRunStart(context);
            const outcomes =
              executor && selectedFiles.length
                ? [
                    await executor.runCycle({
                      buildId: ++buildId,
                      mode: 'all',
                      fileFilters: selectedFiles,
                      updateSnapshot:
                        context.snapshotManager.options.updateSnapshot,
                    }),
                  ]
                : [];
            // Reusable runners publish a cycle-local result snapshot. Reset at
            // the finalization boundary so the shared result-state reducer
            // always starts this cycle from fresh, dense arrays.
            context.resetReporterResultState();
            await finalizeRunCycle(context, {
              outcomes,
              mode: 'all',
              isWatchMode: false,
              coverageProvider,
              reportOnFailure:
                context.normalizedConfig.coverage.reportOnFailure,
              traceRun,
            });
            context.exitCode.finishCycle();
            return result;
          });
        } catch (error) {
          return capture.errorResult(error);
        } finally {
          const index = context.reporters.indexOf(capture.reporter);
          if (index >= 0) {
            context.reporters.splice(index, 1);
          }
          capture.dispose();
        }
      });
      runQueue = queuedRun.then(
        () => undefined,
        () => undefined,
      );
      return queuedRun;
    },

    close(): Promise<void> {
      if (!closePromise) {
        closed = true;
        const buildSettled = buildPromise?.then(
          () => undefined,
          () => undefined,
        );
        closePromise = (buildSettled ?? Promise.resolve())
          .then(() => runQueue)
          .then(async () => {
            try {
              let teardownSucceeded: boolean;
              try {
                await executor?.close();
              } finally {
                try {
                  teardownSucceeded = await runGlobalTeardown(context);
                } finally {
                  await traceController.shutdown(traceRun);
                }
              }
              if (!teardownSucceeded) {
                throw new Error(GLOBAL_TEARDOWN_ERROR);
              }
            } finally {
              disposeBuiltInReporters(context);
            }
          });
      }
      return closePromise;
    },
  };
}
