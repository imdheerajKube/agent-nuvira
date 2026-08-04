import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, setSilent, setLogLevel, isSilent } from '../../src/utils/logger.js';

describe('logger', () => {
  afterEach(() => {
    // Restore module state so tests never leak into each other.
    setSilent(false);
    setLogLevel('info');
    vi.restoreAllMocks();
  });

  it('logs to stdout at the default info level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('hello');
    logger.highlight('banner');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('silences every level including highlight and error', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setSilent(true);
    expect(isSilent()).toBe(true);

    logger.debug('d');
    logger.info('i');
    logger.success('s');
    logger.warn('w');
    logger.error('e');
    logger.highlight('h');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('resumes logging after setSilent(false)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    setSilent(true);
    logger.info('muted');
    setSilent(false);
    logger.info('audible');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('audible');
  });

  it('still honors the log level when not silent', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setLogLevel('warn');

    logger.info('hidden-info');
    logger.warn('shown-warn');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('shown-warn');
  });
});
