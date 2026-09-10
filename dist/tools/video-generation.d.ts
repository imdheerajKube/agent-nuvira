/**
 * Video Generation Tool — Text-to-video and image-to-video generation.
 *
 * Hermes equivalents:
 * - flux3_video_tool.py (1,249 lines) — BFL FLUX 3 video generation
 * - video_generation_tool.py (575 lines) — Generic video generation
 *
 * Provides:
 * - Text-to-video generation
 * - Image-to-video generation
 * - Video polling and status tracking
 * - Multiple provider support (FAL, BFL, generic)
 */
export interface VideoGenConfig {
    /** Provider API key */
    apiKey?: string;
    /** Provider base URL */
    baseUrl?: string;
    /** Default provider */
    provider?: string;
}
export interface VideoGenRequest {
    prompt: string;
    imageUrl?: string;
    referenceImageUrls?: string[];
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    negativePrompt?: string;
    seed?: number;
    model?: string;
}
export interface VideoGenResult {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    videoUrl?: string;
    thumbnailUrl?: string;
    duration?: number;
    error?: string;
    metadata?: Record<string, unknown>;
}
export declare class FALVideoGenerator {
    private config;
    constructor(config?: VideoGenConfig);
    /**
     * Generate video from text prompt.
     */
    generate(request: VideoGenRequest): Promise<VideoGenResult>;
    /**
     * Check status of a video generation job.
     */
    status(jobId: string): Promise<VideoGenResult>;
}
export interface VideoGenProvider {
    name: string;
    generate(request: VideoGenRequest): Promise<VideoGenResult>;
    status(jobId: string): Promise<VideoGenResult>;
}
export declare class VideoGenerationManager {
    private providers;
    private activeProvider;
    constructor();
    /**
     * Register a video generation provider.
     */
    registerProvider(provider: VideoGenProvider): void;
    /**
     * Set active provider.
     */
    setActiveProvider(name: string): boolean;
    /**
     * Generate video using active provider.
     */
    generate(request: VideoGenRequest): Promise<VideoGenResult>;
    /**
     * Check status.
     */
    status(jobId: string): Promise<VideoGenResult>;
    /**
     * List available providers.
     */
    listProviders(): string[];
}
export declare function getVideoGenManager(): VideoGenerationManager;
export declare function resetVideoGenManager(): void;
//# sourceMappingURL=video-generation.d.ts.map