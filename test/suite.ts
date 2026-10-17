// node:test's `describe` and `it` return promises, but the runner collects the tests itself and
// nobody is meant to await them (awaiting inside a suite changes nothing). These wrappers call
// them and discard the promise, so that @typescript-eslint/no-floating-promises does not flag
// every test declaration. Behavior is exactly node:test's.
import {
  describe as nodeDescribe,
  it as nodeIt,
  type SuiteContext,
  type TestContext,
  type TestOptions,
} from 'node:test';

type SuiteFn = (suite: SuiteContext) => void | Promise<void>;
type TestFn = (test: TestContext) => void | Promise<void>;

export function describe(name: string, fn: SuiteFn): void;
export function describe(name: string, options: TestOptions, fn: SuiteFn): void;
export function describe(name: string, optionsOrFn: TestOptions | SuiteFn, fn?: SuiteFn): void {
  if (typeof optionsOrFn === 'function') void nodeDescribe(name, optionsOrFn);
  else void nodeDescribe(name, optionsOrFn, fn);
}

export function it(name: string, fn: TestFn): void;
export function it(name: string, options: TestOptions, fn: TestFn): void;
export function it(name: string, optionsOrFn: TestOptions | TestFn, fn?: TestFn): void {
  if (typeof optionsOrFn === 'function') void nodeIt(name, optionsOrFn);
  else void nodeIt(name, optionsOrFn, fn);
}
