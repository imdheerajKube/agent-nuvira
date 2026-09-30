/**
 * The data behind the dashboard's Process Environment page.
 *
 * Two values are reported per variable, and keeping them apart is the whole
 * point of this module:
 *
 *   - **the file value** — the line in the credential `.env`. This is what the
 *     page writes, what persists, and what the NEXT `nuvira` run reads.
 *   - **the process value** — what `process.env` holds right now, which is what
 *     the RUNNING dashboard would actually obey.
 *
 * They disagree for one reason worth surfacing: `loadEnv()` never overrides a
 * variable that is already in the environment (`Do NOT override existing
 * process.env values — system env vars take priority`). So a value exported in
 * the operator's shell, or a systemd unit's `Environment=`, silently outranks
 * anything written here — for the dashboard AND for every CLI run in that shell.
 * A page that showed only the file would let a user write `NUVIRA_OTEL=0`, watch
 * the row turn off, and still export spans. `shadowed` is that fact, stated.
 *
 * The file is the page's own target, so `state` is computed from it; the process
 * value is reported beside it, never folded in.
 */

import { loadEnvFile } from '../skills/secret-capture.js';
import {
  PROCESS_ENV_VARS,
  processEnvFlagIsOn,
  type ProcessEnvVarSpec,
} from '../config/process-env.js';

/** One row of the page: a curated variable and both of its values. */
export interface ProcessEnvRow {
  name: string;
  label: string;
  group: ProcessEnvVarSpec['group'];
  kind: ProcessEnvVarSpec['kind'];
  rule?: ProcessEnvVarSpec['rule'];
  acceptsValue?: boolean;
  valueLabel?: string;
  placeholder?: string;
  description: string;
  unsetMeans: string;
  cliEquivalent?: string;
  /**
   * The persisted line, or `null` when there is no line at all. `''` is a real
   * and different state — a line that exists and is blank — so it is not
   * collapsed into `null`.
   */
  fileValue: string | null;
  /** What the running dashboard process sees, or `null` when it is not set. */
  processValue: string | null;
  /** Derived from the FILE value, by the rule its own reader uses. */
  state: 'on' | 'off' | 'set' | 'unset';
  /**
   * True when the process is running with a different value than the file holds,
   * which means a shell/systemd value is outranking this page.
   */
  shadowed: boolean;
  /** Something true about the current combination that a user needs to know. */
  warning?: string;
}

/** Build the row set. Never throws — an unreadable `.env` yields every row unset. */
export function readProcessEnvInventory(): ProcessEnvRow[] {
  let file: Record<string, string> = {};
  try {
    file = loadEnvFile();
  } catch {
    // Best-effort: a broken inventory must not blank the page, and every row
    // still renders as "unset" rather than as absent.
  }

  const rows = PROCESS_ENV_VARS.map((spec) => toRow(spec, file));
  addOtelWarning(rows, file);
  return rows;
}

function toRow(spec: ProcessEnvVarSpec, file: Record<string, string>): ProcessEnvRow {
  const fileValue = Object.prototype.hasOwnProperty.call(file, spec.name) ? file[spec.name] : null;
  const rawEnv = process.env[spec.name];
  const processValue = rawEnv === undefined ? null : rawEnv;

  const state: ProcessEnvRow['state'] =
    fileValue === null
      ? 'unset'
      : spec.kind === 'text'
        ? 'set'
        : processEnvFlagIsOn(spec.rule, fileValue)
          ? 'on'
          : 'off';

  return {
    name: spec.name,
    label: spec.label,
    group: spec.group,
    kind: spec.kind,
    rule: spec.rule,
    acceptsValue: spec.acceptsValue,
    valueLabel: spec.valueLabel,
    placeholder: spec.placeholder,
    description: spec.description,
    unsetMeans: spec.unsetMeans,
    cliEquivalent: spec.cliEquivalent,
    fileValue,
    processValue,
    state,
    // A blank stored line and an unset variable are different rows but the same
    // effective silence, so only a real disagreement counts as shadowed.
    shadowed: processValue !== null && processValue !== fileValue,
  };
}

/**
 * Say out loud that enabling export without an endpoint exports nothing.
 *
 * MEASURED against the OTLP resolution in `otel.ts`: with no
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and no `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
 * `otelEndpoint()` returns null — the spans are built and then dropped. That is
 * a run paying for a tracer and shipping nothing, and the page can see it.
 *
 * Both endpoint names are read straight from the file map: they are standard
 * OpenTelemetry names rather than ours, so they are deliberately NOT on the
 * allowlist and this module never writes them.
 */
function addOtelWarning(rows: ProcessEnvRow[], file: Record<string, string>): void {
  const otel = rows.find((r) => r.name === 'NUVIRA_OTEL');
  if (!otel) return;

  const effective = otel.processValue ?? otel.fileValue;
  if (!processEnvFlagIsOn('truthy', effective)) return;

  const endpoint = (name: string): string =>
    (process.env[name] ?? (Object.prototype.hasOwnProperty.call(file, name) ? file[name] : '')).trim();

  if (!endpoint('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') && !endpoint('OTEL_EXPORTER_OTLP_ENDPOINT')) {
    otel.warning =
      'Export is on but no OTLP endpoint is set, so spans are built and then dropped. ' +
      'Set OTEL_EXPORTER_OTLP_ENDPOINT to actually ship them.';
  }
}
