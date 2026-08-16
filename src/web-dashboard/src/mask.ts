/**
 * mask.ts — privacy masking for the dashboard UI.
 *
 * Real phone numbers / sender ids must never be shown in full on screen.
 * `maskSenderId` turns any run of 3+ digits into its first 2 digits + "***"
 * (e.g. "+919876543210" → "+91***", "919876543210@s.whatsapp.net" →
 * "91***@s.whatsapp.net"), keeping the rest of the id (domain, device
 * suffixes, non-numeric ids like aliases or emails) intact so the reference
 * stays recognizable without exposing the number.
 */
export function maskSenderId(id: string): string {
  return String(id ?? '').replace(/\d{3,}/g, (run) => run.slice(0, 2) + '***');
}
