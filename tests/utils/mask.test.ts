import { describe, it, expect } from 'vitest';
import { maskSenderId } from '../../src/utils/mask.js';

describe('maskSenderId (shared privacy masking)', () => {
  it('masks phone numbers but keeps country-code prefix', () => {
    expect(maskSenderId('+919876543210')).toBe('+91***');
    expect(maskSenderId('919876543210')).toBe('91***');
  });

  it('masks the number inside a WhatsApp jid, keeping the domain', () => {
    expect(maskSenderId('919876543210@s.whatsapp.net')).toBe('91***@s.whatsapp.net');
    expect(maskSenderId('12025550123@s.whatsapp.net')).toBe('12***@s.whatsapp.net');
  });

  it('keeps device suffixes readable', () => {
    expect(maskSenderId('220722781786162:1@lid')).toBe('22***:1@lid');
  });

  it('leaves non-numeric ids (aliases, emails, group tags) untouched', () => {
    expect(maskSenderId('ops')).toBe('ops');
    expect(maskSenderId('team@example.com')).toBe('team@example.com');
    expect(maskSenderId('C0123ABC')).toBe('C01***ABC');
  });

  it('handles empty / missing input', () => {
    expect(maskSenderId('')).toBe('');
    expect(maskSenderId(undefined as unknown as string)).toBe('');
  });
});
