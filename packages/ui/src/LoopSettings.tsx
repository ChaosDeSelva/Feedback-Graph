import { useEffect, useState } from 'react';
import { LOOP_MODES, loopApi, type DecisionType, type LoopMode, type LoopSettingsPatch, type LoopState } from './api.ts';
import { cappedLine, PauseButton, TypeTable } from './LearningLoop.tsx';
import { knownMode, modeHint, modeLabel, modeUnderGlobal, p2, typeLabel } from './loop.ts';
import { READ_ONLY_TITLE, useOwnerWrites } from './ownerAccess.tsx';
import { useUnsavedChanges } from './unsaved.ts';
import { Button, Input, Select } from './ui/controls.tsx';
import { Alert, Card, SkeletonList } from './ui/display.tsx';

/** Every request fails with an Error (api.ts): the API's own words, or that it did not answer. */
const message = (e: unknown) => (e as Error).message;
type TypeDraft = { mode: LoopMode | ''; tau: string };
type Draft = { mode: LoopMode; types: Record<string, TypeDraft> };
const draftOf = (s: LoopState): Draft => ({ mode: s.mode, types: Object.fromEntries(s.types.map((t) => [t.type, { mode: t.mode ?? '', tau: p2(t.tau) }])) });

/**
 * Settings › Learning loop: the global mode, each type's mode and bar (τ can only be raised above its default), the
 * model budget and the kill switch. Saved together; the API checks the same rules.
 */
export function LoopSettings() {
  const writes = useOwnerWrites();
  const [state, setState] = useState<LoopState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loaded = (s: LoopState) => { setState(s); setDraft(draftOf(s)); };
  useEffect(() => { loopApi.state().then(loaded, (e) => setError(message(e))); }, []);

  const patch: LoopSettingsPatch = {};
  const tauErrors: Record<string, string> = {};
  if (state && draft) {
    if (draft.mode !== state.mode) patch.mode = draft.mode;
    for (const t of state.types) {
      const d = draft.types[t.type];
      const tau = Number(d.tau);
      const change: { mode?: LoopMode | null; tau?: number | null } = {};
      if ((d.mode || null) !== t.mode) change.mode = d.mode || null;
      if (d.tau.trim() === '' || !Number.isFinite(tau) || tau > 1) tauErrors[t.type] = 'a number up to 1';
      else if (tau < t.tauDefault) tauErrors[t.type] = `at least ${p2(t.tauDefault)}: the bar can only be raised`;
      else if (p2(tau) !== p2(t.tau)) change.tau = tau;
      if (Object.keys(change).length) (patch.types ??= {})[t.type as DecisionType] = change;
    }
  }
  const invalid = Object.keys(tauErrors).length > 0;
  // A bar typed out of range is an edit too: it can be undone, and leaving asks first.
  const dirty = Object.keys(patch).length > 0 || invalid;
  useUnsavedChanges(dirty, 'Your learning loop settings are not saved.');

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      loaded(await loopApi.saveSettings(patch));
      setNotice('Saved. The worker uses them from its next round.');
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }

  if (!state || !draft) return error ? <Alert>{error}</Alert> : <SkeletonList rows={4} />;
  const setType = (type: string, d: Partial<TypeDraft>) => setDraft({ ...draft, types: { ...draft.types, [type]: { ...draft.types[type], ...d } } });
  const lock = !writes || state.disabled;
  const lockTitle = !writes ? READ_ONLY_TITLE : state.disabled ? 'LOOP_DISABLED is set in .env' : undefined;
  return (
    <section aria-labelledby="loop-settings-head" className="grid gap-4">
      <div>
        <h2 id="loop-settings-head" className="text-[15px] font-semibold tracking-[-0.01em] [font-stretch:92%]">Learning loop</h2>
        <p className="text-xs text-muted">What the loop may do on its own. Housekeeping applies by default; agent-facing changes only once your reviews have earned it.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <div role="status" className="rounded-md border border-ok/40 bg-ok-soft px-3 py-2 text-ok-text">{notice}</div>}
      <Card title="Mode" bodyClass="grid gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="global mode" value={draft.mode} disabled={lock} title={lockTitle} onChange={(e) => setDraft({ ...draft, mode: e.target.value as LoopMode })}>
            {!knownMode(draft.mode) && <option value={draft.mode} disabled>{modeLabel(draft.mode)}</option>}
            {LOOP_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
          <span className="text-xs text-muted">{modeHint(draft.mode)}</span>
        </div>
        {cappedLine(state) && <p role="status" className="text-xs text-accent-text">{cappedLine(state)} Running as {state.effectiveMode}.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <PauseButton state={state} onChange={setState} onError={setError} />
          <span className="text-xs text-muted">The kill switch: nothing is applied while paused. <code className="font-mono">LOOP_DISABLED=1</code> in <code className="font-mono">.env</code> stops it in a way this page cannot undo.</span>
        </div>
      </Card>
      <Card title="Per decision type">
        <TypeTable
          types={state.types}
          controls={{
            mode: (t) => (
              <div className="grid w-40 gap-1">
                <Select aria-label={`${typeLabel(t.type)} mode`} size="sm" value={draft.types[t.type].mode} disabled={lock} title={lockTitle} onChange={(e) => setType(t.type, { mode: e.target.value as LoopMode | '' })}>
                  <option value="">global ({modeUnderGlobal(draft.mode, state, t)})</option>
                  {draft.types[t.type].mode && !knownMode(draft.types[t.type].mode) && <option value={draft.types[t.type].mode} disabled>{modeLabel(draft.types[t.type].mode)}</option>}
                  {LOOP_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
                {t.breaker.tripped && <span className="text-[11px] whitespace-normal text-bad-text">The breaker set it to propose; choose auto to turn it back on.</span>}
              </div>
            ),
            tau: (t) => (
              <div className="grid gap-1">
                <Input
                  aria-label={`${typeLabel(t.type)} bar`}
                  aria-invalid={!!tauErrors[t.type] || undefined}
                  aria-describedby={tauErrors[t.type] ? `tau-${t.type}` : undefined}
                  size="sm" type="number" step="0.01" min={t.tauDefault} max={1} className="w-20 shrink-0"
                  value={draft.types[t.type].tau} disabled={lock} title={lockTitle}
                  onChange={(e) => setType(t.type, { tau: e.target.value })}
                />
                {tauErrors[t.type] && <span id={`tau-${t.type}`} className="max-w-40 text-[11px] whitespace-normal text-bad-text">{tauErrors[t.type]}</span>}
              </div>
            ),
          }}
        />
      </Card>
      <Card title="Budget" bodyClass="grid gap-1 p-3 text-[13px]">
        <p>Model calls today: <b className="tabular-nums">{state.budget.llmCallsToday}</b> of {state.budget.llmCallsPerDay} (<code className="font-mono text-xs">LOOP_LLM_CALLS_PER_DAY</code>).</p>
        <p>Agent-facing changes applied on its own today: <b className="tabular-nums">{state.budget.autoToday}</b> of {state.budget.autoPerDay}, at most {state.budget.autoPerProject} per project (<code className="font-mono text-xs">LOOP_AUTO_PER_DAY</code>).</p>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" owner disabled={!dirty || invalid || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save loop settings'}</Button>
        {dirty && <Button variant="ghost" onClick={() => setDraft(draftOf(state))}>Undo changes</Button>}
      </div>
    </section>
  );
}
