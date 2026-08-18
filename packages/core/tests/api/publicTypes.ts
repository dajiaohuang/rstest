import { loadConfig, type RstestConfig } from '@rstest/core';
import {
  createRstest,
  type CreateRstestOptions,
  type LoadedRstestConfig,
} from '@rstest/core/api';

declare const config: RstestConfig;

const configOptions: CreateRstestOptions = { config };
const createFromLoadedConfig = async (): Promise<void> => {
  const loaded = await loadConfig({ cwd: '' });
  const loadedConfig: LoadedRstestConfig = loaded;
  await createRstest({ config: loadedConfig });
};

void configOptions;
void createFromLoadedConfig;
