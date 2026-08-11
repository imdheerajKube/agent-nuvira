/**
 * Minimal ambient types for `@microsoft/recognizers-text-date-time`
 * (the CJS build ships no bundled types). Mirrors the surface used by
 * `src/nlu/intent.ts` — nothing more.
 */
declare module '@microsoft/recognizers-text-date-time' {
  /** Culture enum (Culture.English is the string we pass). */
  export const Culture: {
    English: string;
    [key: string]: string;
  };

  /** A single resolution entry inside a match's resolution.values. */
  export interface DateTimeResolutionValue {
    timex?: string;
    type?: string;
    value?: string;
    start?: string;
    end?: string;
    [key: string]: unknown;
  }

  /** A recognized temporal reference ("last week", "yesterday", …). */
  export interface DateTimeModelResult {
    text: string;
    typeName: string;
    start: number;
    length?: number;
    resolution?: {
      values?: DateTimeResolutionValue[];
    };
  }

  /**
   * Extract temporal references from text.
   * @param referenceTime Optional anchor; results are relative to it.
   */
  export function recognizeDateTime(
    input: string,
    culture?: string,
    options?: unknown,
    referenceTime?: Date,
  ): DateTimeModelResult[];
}
