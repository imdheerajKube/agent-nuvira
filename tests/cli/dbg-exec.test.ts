import { describe, it, vi } from 'vitest';
import { runLoopExecutor } from '../../src/cli/loop-executor.js';
import { ConfigManager } from '../../src/config/manager.js';

describe('debug', () => {
  it('traces the fallback path', async () => {
    let n = 0;
    const texts = [
      'I will check.\n{"tool":"list_dir","arguments":{"path":"."}}',
      'Found src/ and tests/.',
    ];
    const provider: any = {
      name: 'Scripted',
      async generate() { throw new Error('no'); },
      async generateStream(_p: string, _o: any, onToken?: (t: string) => void) {
        n += 1;
        const t = texts[n - 1] ?? 'no more scripted output';
        onToken?.(t);
        return t;
      },
    };
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor: run } = await import('../../src/cli/loop-executor.js');
    const r = await run('what is here?', new ConfigManager(), { provider: 'scripted', skipProjectContext: true, quiet: true });
    console.log('STEPS:', n);
    console.log('RESULT:', JSON.stringify({ content: r.content, toolCalls: r.toolCalls, bounded: r.bounded, genFailed: r.generationFailed }, null, 2));
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });
});
