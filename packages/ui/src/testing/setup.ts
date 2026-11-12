import { configure } from '@testing-library/react';

// findBy* and waitFor wait for what a test expects to appear; their deadline only catches one that never does. The 1 s
// default is reached by a slow render on a busy host, so it stays below vitest's own hang guard (vite.config.ts).
configure({ asyncUtilTimeout: 15_000 });
