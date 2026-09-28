// Browser timer boundary for provider regression suites running under Node.
globalThis.window ??= { setTimeout, clearTimeout }
