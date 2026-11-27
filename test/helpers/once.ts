// A value worked out the first time a test asks for it, then kept for the rest of the file. The
// simulation a describe block's tests share is built only when one of them runs: a run of one test
// does not pay for every other block's simulation, and the time and any failure land on the test
// that needed it, not on loading the file.

export function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}
