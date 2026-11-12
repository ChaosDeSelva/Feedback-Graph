import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { sandbox } from './testing/restoreSandbox.ts';

// A restore journal restore.sh did not write is refused by every script that reads it, never acted on.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

test.each(['pid=-1\nsrc=b\n', 'pid=0\nsrc=b\n', 'pid=1\nsrc=b\n', 'pid=12x\n', 'evil=1\n', 'step=unpacking\nrunning=* $(touch PWN)\n', 'store=mysql\n', 'step=dropping\n'])('a journal restore.sh did not write (%j) is refused everywhere, never acted on', async (bad) => {
  {
    const s = sandbox();
    await s.make();
    s.writeJournal(bad);
    const r = await s.restore();
    expect(r.code, bad).toBe(1);
    expect(r.err, bad).toContain('is not one restore.sh wrote');
    expect(s.which(), bad).toBe('live');
    const abandon = await s.script('restore.sh', ['--abandon']);
    expect(abandon.code, bad).toBe(1);
    expect(abandon.err, bad).toContain('is not one restore.sh wrote');
    const backup = await s.script('backup.sh');
    expect(backup.code, bad).toBe(1);
    expect(backup.err, bad).toContain('is not one restore.sh wrote');
    expect((await s.script('doctor.sh')).out, bad).toContain('FAIL  restore: the restore journal');
    expect(s.ran(), bad).not.toContain('compose -p t up');
    expect(existsSync(join(s.repo, 'PWN')), bad).toBe(false);
  }
});
