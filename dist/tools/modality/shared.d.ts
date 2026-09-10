/**
 * I2–I5 — shared helpers for the modality packs.
 *
 * Every pack follows a registry + availability-gating model: an
 * `isAvailable()` per backend, graceful degradation when unconfigured, and
 * artifacts written to a sandbox dir (env-overridable, never the project tree).
 */
/**
 * Resolve the artifact dir for a modality ("images" | "screenshots" | "audio").
 * NUVIRA_ARTIFACTS_DIR overrides the base; default `<cwd>/.nuvira/artifacts`.
 */
export declare function artifactsDir(kind: string, cwd?: string): string;
/** Write a Buffer to the artifact dir, returning the absolute path. */
export declare function writeArtifact(kind: string, filename: string, data: Buffer, cwd?: string): string;
/** Safe filename: keep extension, strip path separators + control chars. */
export declare function safeArtifactName(prefix: string, ext: string): string;
/** Whether a binary is on PATH (cached). Tests reset via resetProbeCache(). */
export declare function binaryOnPath(name: string): boolean;
/** Clear the probe cache (test isolation). */
export declare function resetProbeCache(): void;
/** Whether a file exists (availability of an audio/image input). */
export declare function fileExists(path: string): boolean;
/** Best-effort delete of a temp file (never throws). */
export declare function cleanupTemp(path: string): void;
//# sourceMappingURL=shared.d.ts.map