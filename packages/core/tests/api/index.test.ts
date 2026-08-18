import { writeFileSync } from 'node:fs';
import { createRstest as createBuiltRstest } from '@rstest/core/api';
import { basename, join } from 'pathe';
import { createRstest } from '../../src/api';
import type { RstestConfig } from '../../src/types';
import { withTempDir } from '../helpers/tempDir';

describe('createRstest', () => {
  it('uses config file provenance for build cache dependencies', async () => {
    await withTempDir('rstest-api-config-', async (root) => {
      for (const filePath of [
        join(root, 'configs/rstest.config.mts'),
        'configs/rstest.config.mts',
      ]) {
        const rstest = await createRstest({
          cwd: root,
          config: {
            content: {
              root: './project',
              performance: {
                buildCache: {
                  buildDependencies: ['./cache-flags.ts'],
                },
              },
            },
            filePath,
          },
        });

        expect(rstest.context.config.performance?.buildCache).toMatchObject({
          buildDependencies: [join(root, 'configs/cache-flags.ts')],
        });
      }
    });
  });

  it('does not instantiate reporters for the metadata snapshot', async () => {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const exitListenerCount = process.listenerCount('exit');
    const config = {
      reporters: [
        [
          'default',
          {
            logger: {
              outputStream: process.stdout,
              errorStream: process.stderr,
              getColumns: () => 80,
            },
          },
        ],
      ],
    } satisfies RstestConfig;

    for (let index = 0; index < 2; index++) {
      const rstest = await createRstest({ config });

      expect(rstest.context.config.reporters).toBe(config.reporters);
      expect(process.stdout.write).toBe(stdoutWrite);
      expect(process.stderr.write).toBe(stderrWrite);
      expect(process.listenerCount('exit')).toBe(exitListenerCount);
    }
  });

  it('disposes per-operation TTY reporters', async () => {
    await withTempDir('rstest-api-reporter-', async (root) => {
      writeFileSync(join(root, 'index.test.js'), "test('works', () => {});\n");
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      const stdoutIsTTY = process.stdout.isTTY;
      const ci = process.env.CI;
      const exitListenerCount = process.listenerCount('exit');
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      });
      delete process.env.CI;

      try {
        const rstest = await createBuiltRstest({
          cwd: root,
          config: {
            globals: true,
            include: ['*.test.js'],
            reporters: [['default', { summary: false }]],
          },
        });

        for (let index = 0; index < 2; index++) {
          await expect(rstest.run()).resolves.toMatchObject({ ok: true });
          expect(process.stdout.write).toBe(stdoutWrite);
          expect(process.stderr.write).toBe(stderrWrite);
          expect(process.listenerCount('exit')).toBe(exitListenerCount);
        }
      } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
        Object.defineProperty(process.stdout, 'isTTY', {
          configurable: true,
          value: stdoutIsTTY,
        });
        if (ci === undefined) {
          delete process.env.CI;
        } else {
          process.env.CI = ci;
        }
      }
    });
  });

  it('serializes concurrent reusable runner cycles', async () => {
    await withTempDir('rstest-api-runner-', async (root) => {
      writeFileSync(
        join(root, 'first.test.js'),
        "test('first', () => { throw new Error('failed'); });\n",
      );
      writeFileSync(
        join(root, 'second.test.js'),
        "test('second', () => {});\n",
      );
      const reportedCycles: string[][] = [];
      const reporterResultsAreDense: boolean[] = [];

      const rstest = await createBuiltRstest({
        cwd: root,
        config: {
          globals: true,
          include: ['*.test.js'],
          reporters: [
            {
              onTestRunEnd({ results }) {
                reportedCycles.push(
                  results.map((result) => basename(result.testPath)),
                );
                reporterResultsAreDense.push(
                  results.length === Object.keys(results).length,
                );
              },
            },
          ],
        },
      });
      const runner = await rstest.createRunner();
      const run = (filter: string) =>
        runner.run({ filters: [filter], filterMode: 'exact' });
      const summarize = (results: Awaited<ReturnType<typeof run>>[]) =>
        results.map((result) => ({
          files: result.files.map((file) => basename(file.testPath)),
          stats: result.stats,
        }));

      try {
        await runner.build();
        const concurrent = await Promise.all([
          run('first.test.js'),
          run('second.test.js'),
        ]);
        const sequential = [
          await run('first.test.js'),
          await run('second.test.js'),
        ];

        expect(concurrent[0]).not.toBe(concurrent[1]);
        expect(summarize(concurrent)).toEqual(summarize(sequential));
        expect(summarize(concurrent).map((result) => result.files)).toEqual([
          ['first.test.js'],
          ['second.test.js'],
        ]);
        expect(concurrent.map((result) => result.ok)).toEqual([false, true]);
        expect(reportedCycles).toEqual([
          ['first.test.js'],
          ['second.test.js'],
          ['first.test.js'],
          ['second.test.js'],
        ]);
        expect(reporterResultsAreDense).toEqual([true, true, true, true]);
      } finally {
        await runner.close();
      }
    });
  });

  it('rejects concurrent reusable runner builds', async () => {
    await withTempDir('rstest-api-runner-build-', async (root) => {
      writeFileSync(join(root, 'index.test.js'), "test('works', () => {});\n");
      const rstest = await createBuiltRstest({
        cwd: root,
        config: {
          globals: true,
          include: ['*.test.js'],
          reporters: [],
        },
      });
      const runner = await rstest.createRunner();

      try {
        const firstBuild = runner.build();
        await expect(runner.build()).rejects.toThrow(
          'Rstest runner has already been built.',
        );
        await expect(firstBuild).resolves.toEqual({
          testFiles: [join(root, 'index.test.js')],
        });
      } finally {
        await runner.close();
      }
    });
  });

  it('waits for an accepted build before closing the runner', async () => {
    await withTempDir('rstest-api-runner-close-', async (root) => {
      writeFileSync(join(root, 'index.test.js'), "test('works', () => {});\n");
      const rstest = await createBuiltRstest({
        cwd: root,
        config: {
          globals: true,
          include: ['*.test.js'],
          reporters: [],
        },
      });
      const runner = await rstest.createRunner();
      let buildSettled = false;
      const building = runner.build().finally(() => {
        buildSettled = true;
      });

      await expect(runner.close()).resolves.toBeUndefined();
      expect(buildSettled).toBe(true);
      await expect(building).resolves.toEqual({
        testFiles: [join(root, 'index.test.js')],
      });
      await expect(runner.run()).rejects.toThrow('Rstest runner is closed.');
    });
  });
});
