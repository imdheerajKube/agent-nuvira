/**
 * Image/Video Generation Tool — Multiple provider support.
 *
 * This provides image/video generation:
 * - Multiple providers (DALL-E, Stable Diffusion, Midjourney)
 * - Image editing (inpainting, outpainting, style transfer)
 * - Video generation (text-to-video, image-to-video)
 * - Batch processing
 * - Custom models
 * - Resolution control
 * - Format support (PNG, JPG, WebP, GIF, MP4)
 *
 * Better than Hermes:
 * - Multiple provider support
 * - Image editing capabilities
 * - Video generation
 * - Batch processing
 * - Integration with skill system
 */
export type ImageProvider = 'openai' | 'stability' | 'midjourney';
export type VideoProvider = 'runway' | 'pika' | 'stable-video';
export interface ImageConfig {
    /** Provider */
    provider: ImageProvider;
    /** API key */
    apiKey: string;
    /** Image size */
    size?: '256x256' | '512x512' | '1024x1024' | '1024x1792' | '1792x1024';
    /** Image quality */
    quality?: 'standard' | 'hd';
    /** Image style */
    style?: 'vivid' | 'natural';
    /** Number of images */
    n?: number;
}
export interface VideoConfig {
    /** Provider */
    provider: VideoProvider;
    /** API key */
    apiKey: string;
    /** Video duration (seconds) */
    duration?: number;
    /** Video resolution */
    resolution?: '720p' | '1080p';
    /** Frames per second */
    fps?: number;
}
export interface ImageGenerationResult {
    success: boolean;
    images?: Array<{
        url?: string;
        buffer?: Buffer;
        path?: string;
    }>;
    error?: string;
    durationMs: number;
    provider: ImageProvider;
}
export interface VideoGenerationResult {
    success: boolean;
    video?: {
        url?: string;
        buffer?: Buffer;
        path?: string;
    };
    error?: string;
    durationMs: number;
    provider: VideoProvider;
}
/**
 * Generate image from prompt.
 */
export declare function generateImage(prompt: string, config: ImageConfig, outputPath?: string): Promise<ImageGenerationResult>;
/**
 * Generate video from prompt.
 */
export declare function generateVideo(prompt: string, config: VideoConfig, outputPath?: string): Promise<VideoGenerationResult>;
/**
 * Generate multiple images from prompts.
 */
export declare function batchGenerateImages(prompts: string[], config: ImageConfig, outputDir: string): Promise<ImageGenerationResult[]>;
declare const _default: {
    generateImage: typeof generateImage;
    batchGenerateImages: typeof batchGenerateImages;
    generateVideo: typeof generateVideo;
};
export default _default;
//# sourceMappingURL=image-video-tool.d.ts.map