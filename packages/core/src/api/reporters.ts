import { DefaultReporter } from '../reporter';
import type { RstestContext } from '../types';

export function disposeBuiltInReporters(context: RstestContext): void {
  // TODO: RFC PR2 should make reporter lifecycle context-owned and define a
  // disposal contract for custom reporters. PR1 only releases built-in TTY
  // renderer resources that would otherwise pollute an embedding host.
  for (const reporter of context.reporters) {
    if (reporter instanceof DefaultReporter) {
      reporter.dispose();
    }
  }
}
