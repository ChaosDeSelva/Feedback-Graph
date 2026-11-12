#!/usr/bin/env node
/**
 * The 0.9.0 intake evaluation. It runs knowledge intake and contradiction detection over the fixture (fixtures/intake:
 * eight fictional sources, seeded knowledge and expected.json) and scores what comes out: claim precision and recall (span-matched), question precision and recall,
 * planted-conflict recall, false conflicts per source, supersession accuracy, the judge's uncited rate, and the model
 * calls and seconds each phase took, against the release bar (with gemma4: planted-conflict recall at least 0.8, at most
 * one false conflict per source, no fabricated quote kept). Not a test: it prints a report, one per model.
 *
 *   node scripts/intake-eval.ts --llm ollama:gemma4 [--llm claude-cli] [--fixtures fixtures/intake] [--json out.json]
 *   node scripts/intake-eval.ts --score run.json [--fixtures fixtures/intake] [--json out.json]
 *
 * --llm runs the pipeline with that model, on this machine, with no store. Only `ollama:<model>` and `claude-cli` are
 * taken (intake's default INTAKE_PROVIDER_ALLOW): the eval never sends the fixture to a company API key.
 * --score scores runs saved earlier (a run, a list of runs, or this script's --json output) without calling a model.
 * --json writes the runs and their scores.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { makeProvider } from '../packages/core/src/index.ts';
import {
  formatIntakeReport, intakeEvalPipeline, loadIntakeFixture, parsePredictedRuns, runIntakeEval, scoreIntakeRun, type PredictedRun,
} from '../packages/worker/src/intake/eval/index.ts';

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const OPTIONS = new Set(['llm', 'score', 'fixtures', 'json']);
const args = new Map<string, string[]>();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  if (!OPTIONS.has(k)) die(`unknown option ${process.argv[i]}`);
  const v = process.argv[++i];
  if (v === undefined) die(`--${k} needs a value`);
  args.set(k, [...(args.get(k) ?? []), v]);
}
const one = (k: string) => args.get(k)?.at(-1);

const specs = args.get('llm') ?? [];
const saved = one('score');
if (!specs.length && !saved) die('name a model to run (--llm ollama:gemma4, --llm claude-cli) or saved runs to score (--score run.json)');
if (specs.length && saved) die('--llm and --score are alternatives: run a model, or score saved runs');
for (const s of specs) if (!/^ollama:[\w.:-]+$/.test(s) && !/^claude-cli(:[\w.-]+)?$/.test(s)) die(`--llm ${s}: only ollama:<model> and claude-cli are taken (no company API keys)`);

const fixture = await loadIntakeFixture(one('fixtures') ?? new URL('../fixtures/intake', import.meta.url).pathname).catch((err: Error) => die(err.message));
const runs: PredictedRun[] = [];
if (saved) {
  try {
    runs.push(...parsePredictedRuns(JSON.parse(readFileSync(saved, 'utf8'))));
  } catch (err) {
    die(`--score ${saved}: ${(err as Error).message}`);
  }
}
for (const spec of specs) {
  const llm = (() => {
    try {
      return makeProvider(spec, process.env);
    } catch (err) {
      return die(`--llm ${spec}: ${(err as Error).message}`);
    }
  })();
  console.error(`running the intake pipeline with ${spec}`);
  runs.push(await runIntakeEval(fixture, intakeEvalPipeline, llm, { log: (m) => console.error(m) }));
}

const scores = runs.map((r) => scoreIntakeRun(fixture, r));
console.log(scores.map(formatIntakeReport).join('\n'));
const out = one('json');
if (out) writeFileSync(out, `${JSON.stringify({ runs, scores }, null, 2)}\n`);
