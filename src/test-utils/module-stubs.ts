import { mock } from "node:test";

/**
 * Node caches a mocked module after its first import, so a test file can only
 * install one `mock.module` per specifier. Register the stub once with
 * placeholder functions that delegate to a mutable record, and each test
 * reassigns the fields it cares about.
 */
type StubRecord = Record<string, (...args: never[]) => unknown>;

export type StubRegistry = {
  /** Mock `specifier` with delegating exports; returns the mutable record. */
  module: <T extends StubRecord>(specifier: string, defaults: T) => T;
  /** Restore every registered record to the defaults it was created with. */
  reset: () => void;
};

export function createStubRegistry(): StubRegistry {
  const restores: Array<() => void> = [];

  return {
    module<T extends StubRecord>(specifier: string, defaults: T): T {
      const impl = { ...defaults };
      const namedExports: Record<string, unknown> = {};
      for (const key of Object.keys(defaults)) {
        namedExports[key] = (...args: unknown[]) =>
          (impl[key] as unknown as (...a: unknown[]) => unknown)(...args);
      }
      mock.module(specifier, { namedExports });
      restores.push(() => Object.assign(impl, defaults));
      return impl;
    },
    reset() {
      for (const restore of restores) {
        restore();
      }
    },
  };
}
