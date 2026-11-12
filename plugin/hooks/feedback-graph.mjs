#!/usr/bin/env node
// The Claude Code hook entry point: `feedback-graph.mjs <prompt|edit|stop|session>` with the hook's JSON on stdin.
// What each event does is in run.mjs. It always exits 0, so it never blocks the session.
import { runHook } from './run.mjs';

async function stdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

// A write to a pipe (as Claude Code runs hooks) completes after it returns: exit only once each has drained, or a
// large answer is cut off.
const write = (stream, text) => new Promise((done) => (text ? stream.write(text, done) : done()));
const { stdout, stderr } = await runHook(process.argv[2], stdin);
await write(process.stderr, stderr);
await write(process.stdout, stdout);
process.exit(0);
