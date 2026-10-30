import { describe, expect, it } from 'vitest';
import {
  insertProgramArgs,
  isVerificationInvocation,
  splitChain,
  unwrapCommand,
  leadingAssignments,
} from '../../src/utils/command-shape.js';

/**
 * These pin the ONE rule the harness got wrong in a measured bench turn: a shell
 * line is a chain of pieces, and each piece has a shape that has nothing to do
 * with how it is spelled. Reading the raw text refused a test run, misread an
 * env bypass, and appended flags onto `tail` — three separate step sinks in a
 * turn that had 28 model steps against Cline's 17.
 */
describe('unwrapCommand — the shape, not the spelling', () => {
  it('peels assignments and runners off a segment', () => {
    expect(unwrapCommand('NUVIRA_ENV_GUARD=off python3 -m unittest x').text).toBe('python3 -m unittest x');
    expect(unwrapCommand('sudo -E env -i python3 x.py').text).toBe('python3 x.py');
    expect(unwrapCommand('time -p pytest -q').text).toBe('pytest -q');
    // One segment: `export` is peeled, the assignment it carries is reported.
    const exported = unwrapCommand('export CI=1 python3 -m pytest');
    expect(exported.env).toEqual({ CI: '1' });
    expect(exported.text).toBe('python3 -m pytest');
  });

  it('reports the assignments a child process would see', () => {
    expect(unwrapCommand('FOO=1 BAR="two words" cmd').env).toEqual({ FOO: '1', BAR: 'two words' });
    expect(leadingAssignments('cd x && FOO=1 pytest -q')).toEqual({ FOO: '1' });
  });

  it('does not treat a value that merely contains `=` as an assignment', () => {
    expect(unwrapCommand('pytest -q --junitxml=out.xml').text).toBe('pytest -q --junitxml=out.xml');
  });
});

describe('isVerificationInvocation — effect, not language', () => {
  it('recognizes a check runner through any decoration', () => {
    for (const cmd of [
      'python3 -m unittest discover -s tests',
      'NUVIRA_ENV_GUARD=off python3 -m pytest -q',
      'uv run pytest -q',
      'npx vitest run',
      'cargo test --all',
      'make check',
    ]) {
      expect(isVerificationInvocation(cmd), cmd).toBe(true);
    }
  });

  it('keeps arbitrary code and unknown scripts out of the class', () => {
    for (const cmd of ['python3 -c "print(1)"', 'python3 main.py', 'sh run.sh', 'tox -- python3 evil.py']) {
      expect(isVerificationInvocation(cmd), cmd).toBe(false);
    }
  });
});

describe('splitChain — quote-aware pieces of one line', () => {
  it('splits on the shell operators and keeps offsets honest', () => {
    const line = 'cd repo && pytest -q | tail -5; echo done';
    const segments = splitChain(line);
    expect(segments.map((s) => s.text.trim())).toEqual(['cd repo', 'pytest -q', 'tail -5', 'echo done']);
    for (const segment of segments) expect(line.slice(segment.start, segment.end)).toBe(segment.text);
  });

  it('does not split an operator inside quotes', () => {
    expect(splitChain('echo "a && b" && ls').map((s) => s.text.trim())).toEqual(['echo "a && b"', 'ls']);
    // A grep pattern full of pipes is ONE command. Cutting it into fragments was
    // how a test run piped through `grep -E '^(FAIL|ERROR):|^Ran '` scored
    // `confirm` and got refused in a headless turn.
    expect(
      splitChain(`pytest -q | grep -E '^(FAIL|ERROR):|^Ran |^OK'`).map((s) => s.text.trim()),
    ).toEqual(['pytest -q', `grep -E '^(FAIL|ERROR):|^Ran |^OK'`]);
  });

  it('reads `2>&1` as a redirection, not as a background job', () => {
    // Splitting on that `&` left a bare `1` segment, which is an unknown command.
    expect(splitChain('pytest -q 2>&1 | tail -20').map((s) => s.text.trim())).toEqual([
      'pytest -q 2>&1',
      'tail -20',
    ]);
  });
});

describe('insertProgramArgs — flags belong to the program, never to the line', () => {
  const isPytest = (shape: { text: string }): boolean => /\bpytest\b/.test(shape.text);

  it('puts the flags before a redirect, not between the fd number and the bracket', () => {
    // The measured bug: `pytest -q 2>&1 | tail -20` became
    // `pytest -q 2 --ignore=x >&1 | tail -20`, which is a syntax error.
    expect(insertProgramArgs('pytest -q 2>&1 | tail -20', ['--ignore=tests/t.py'], isPytest)).toBe(
      'pytest -q --ignore=tests/t.py 2>&1 | tail -20',
    );
    expect(insertProgramArgs('pytest -q > out.log', ['-x'], isPytest)).toBe('pytest -q -x > out.log');
  });

  it('finds the runner inside a chain, past decorations', () => {
    expect(insertProgramArgs('cd repo && FOO=1 pytest tests', ['-x'], isPytest)).toBe(
      'cd repo && FOO=1 pytest tests -x',
    );
  });

  it('returns null when no segment is the program — the caller keeps the line as written', () => {
    expect(insertProgramArgs('python3 -m unittest discover', ['--ignore=tests/t.py'], isPytest)).toBeNull();
    expect(insertProgramArgs('', ['-x'], isPytest)).toBeNull();
    expect(insertProgramArgs('pytest -q', [], isPytest)).toBeNull();
  });
});
