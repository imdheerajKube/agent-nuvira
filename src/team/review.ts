/**
 * Team Review — Review workflow (agent PR → review → merge).
 *
 * The review workflow enables team members to review agent-generated changes
 * before applying them. It mimics a simplified PR workflow:
 *
 * 1. PR Creation: Agent proposes changes → saved as a "review bundle"
 * 2. Review: Team member reviews the proposed changes
 * 3. Merge: Approved changes are applied to the working directory
 *
 * Review bundles are stored in ~/.buff/team/reviews/ and can be shared
 * via git (if team memory is set up) or locally.
 *
 * Each bundle contains:
 *   - Metadata (author, timestamp, goal, provider)
 *   - Proposed file changes (path, original, new content)
 *   - Review comments (status, feedback)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';

import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Status of a review */
export type ReviewStatus = 'pending' | 'approved' | 'changes-requested' | 'merged' | 'rejected';

/** A single file change in a review bundle */
export interface ReviewFileChange {
  path: string;
  originalContent?: string;
  newContent?: string;
  status: 'created' | 'modified' | 'deleted';
}

/** A review comment */
export interface ReviewComment {
  reviewer: string;
  status: 'approve' | 'request-changes' | 'comment';
  comment: string;
  timestamp: number;
}

/** A complete review bundle */
export interface ReviewBundle {
  /** Unique review ID */
  id: string;
  /** Title/summary of the proposed changes */
  title: string;
  /** The original user goal that produced these changes */
  goal: string;
  /** Author (git user or hostname) */
  author: string;
  /** Current review status */
  status: ReviewStatus;
  /** When the bundle was created */
  createdAt: number;
  /** Provider used */
  provider: string;
  /** Model used */
  model: string;
  /** The proposed file changes */
  changes: ReviewFileChange[];
  /** Review comments */
  comments: ReviewComment[];
  /** Execution summary from the orchestrator */
  summary?: string;
  /** Tags for categorization */
  tags: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REVIEWS_DIR = join(homedir(), '.buff', 'team', 'reviews');
const REVIEWS_INDEX_PATH = join(REVIEWS_DIR, 'index.json');

interface ReviewsIndex {
  reviews: Array<{ id: string; title: string; status: ReviewStatus; createdAt: number; author: string }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(REVIEWS_DIR)) {
    mkdirSync(REVIEWS_DIR, { recursive: true });
  }
}

function generateReviewId(): string {
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function readIndex(): ReviewsIndex {
  try {
    ensureDir();
    if (!existsSync(REVIEWS_INDEX_PATH)) {
      return { reviews: [] };
    }
    return JSON.parse(readFileSync(REVIEWS_INDEX_PATH, 'utf-8'));
  } catch {
    return { reviews: [] };
  }
}

function writeIndex(index: ReviewsIndex): void {
  ensureDir();
  writeFileSync(REVIEWS_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

function bundlePath(id: string): string {
  return join(REVIEWS_DIR, `${id}.json`);
}

// ─── Review Operations ──────────────────────────────────────────────────────

/**
 * Create a new review bundle from proposed file changes.
 * Typically called after an agent execution to capture the proposed changes
 * for review before applying them.
 *
 * @param title — Short title for the review
 * @param goal — The original goal
 * @param changes — Proposed file changes
 * @param options — Optional metadata
 * @returns The created ReviewBundle
 */
export function createReview(
  title: string,
  goal: string,
  changes: ReviewFileChange[],
  options?: {
    provider?: string;
    model?: string;
    summary?: string;
    author?: string;
    tags?: string[];
  },
): ReviewBundle {
  const id = generateReviewId();
  const bundle: ReviewBundle = {
    id,
    title,
    goal,
    author: options?.author || process.env.USER || 'unknown',
    status: 'pending',
    createdAt: Date.now(),
    provider: options?.provider || 'unknown',
    model: options?.model || 'unknown',
    changes,
    comments: [],
    summary: options?.summary,
    tags: options?.tags || [],
  };

  // Save to disk
  ensureDir();
  writeFileSync(bundlePath(id), JSON.stringify(bundle, null, 2), 'utf-8');

  // Update index
  const index = readIndex();
  index.reviews.unshift({
    id,
    title,
    status: 'pending',
    createdAt: bundle.createdAt,
    author: bundle.author,
  });
  // Keep only last 100 entries in the index
  if (index.reviews.length > 100) {
    index.reviews = index.reviews.slice(0, 100);
  }
  writeIndex(index);

  logger.success(`Created review bundle: ${id} — "${title}"`);
  return bundle;
}

/**
 * Load a review bundle by ID.
 */
export function getReview(id: string): ReviewBundle | null {
  const path = bundlePath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * List all review bundles, sorted by recency.
 */
export function listReviews(limit: number = 20): ReviewBundle[] {
  const index = readIndex();
  const reviews: ReviewBundle[] = [];

  for (const entry of index.reviews.slice(0, limit)) {
    const bundle = getReview(entry.id);
    if (bundle) reviews.push(bundle);
  }

  return reviews;
}

/**
 * Add a review comment to a bundle.
 */
export function addReviewComment(
  id: string,
  reviewer: string,
  status: 'approve' | 'request-changes' | 'comment',
  comment: string,
): ReviewBundle | null {
  const bundle = getReview(id);
  if (!bundle) {
    logger.error(`Review not found: ${id}`);
    return null;
  }

  bundle.comments.push({
    reviewer,
    status,
    comment,
    timestamp: Date.now(),
  });

  // Update status based on comment
  if (status === 'approve') {
    bundle.status = 'approved';
  } else if (status === 'request-changes') {
    bundle.status = 'changes-requested';
  }

  // Save
  writeFileSync(bundlePath(id), JSON.stringify(bundle, null, 2), 'utf-8');

  // Update index
  const index = readIndex();
  const entry = index.reviews.find((r) => r.id === id);
  if (entry) entry.status = bundle.status;
  writeIndex(index);

  return bundle;
}

/**
 * Merge a review bundle — apply approved changes to the working directory.
 *
 * @param id — Review bundle ID
 * @param workingDir — Working directory to apply changes to (default: process.cwd())
 * @returns The number of files changed
 */
export function mergeReview(id: string, workingDir?: string): number {
  const bundle = getReview(id);
  if (!bundle) {
    logger.error(`Review not found: ${id}`);
    return 0;
  }

  if (bundle.status === 'rejected') {
    logger.error('Cannot merge a rejected review.');
    return 0;
  }

  if (bundle.status === 'pending') {
    logger.warn('Review is still pending. Approve first with `buff team review approve <id>`.');
    return 0;
  }

  const dir = resolve(workingDir || process.cwd());
  let count = 0;

  for (const change of bundle.changes) {
    const fullPath = resolve(dir, change.path);

    switch (change.status) {
      case 'created':
      case 'modified':
        if (change.newContent !== undefined) {
          const targetDir = join(fullPath, '..');
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
          }
          writeFileSync(fullPath, change.newContent, 'utf-8');
          count++;
        }
        break;
      case 'deleted':
        if (existsSync(fullPath)) {
          try {
            unlinkSync(fullPath);
            count++;
          } catch {
            logger.warn(`Could not delete ${change.path}`);
          }
        }
        break;
    }
  }

  // Update status
  bundle.status = 'merged';
  writeFileSync(bundlePath(id), JSON.stringify(bundle, null, 2), 'utf-8');

  const index = readIndex();
  const entry = index.reviews.find((r) => r.id === id);
  if (entry) entry.status = 'merged';
  writeIndex(index);

  logger.success(`Merged review ${id}: ${count} file(s) changed.`);
  return count;
}

/**
 * Reject a review bundle.
 */
export function rejectReview(id: string, reason?: string): boolean {
  const bundle = getReview(id);
  if (!bundle) {
    logger.error(`Review not found: ${id}`);
    return false;
  }

  bundle.status = 'rejected';
  if (reason) {
    bundle.comments.push({
      reviewer: bundle.author,
      status: 'request-changes',
      comment: reason,
      timestamp: Date.now(),
    });
  }
  writeFileSync(bundlePath(id), JSON.stringify(bundle, null, 2), 'utf-8');

  const index = readIndex();
  const entry = index.reviews.find((r) => r.id === id);
  if (entry) entry.status = 'rejected';
  writeIndex(index);

  logger.info(`Review ${id} rejected.${reason ? ` Reason: ${reason}` : ''}`);
  return true;
}

/**
 * Create a review bundle from the current orchestrator result.
 * This captures all file changes proposed by the agents into a review.
 *
 * @param goal — The original goal
 * @param fileChanges — The proposed file changes from the orchestrator
 * @param summary — Execution summary
 * @returns The created ReviewBundle
 */
export function createReviewFromResult(
  goal: string,
  fileChanges: Array<{ path: string; originalContent?: string; newContent?: string; status: string }>,
  summary?: string,
  options?: { provider?: string; model?: string; author?: string },
): ReviewBundle {
  // Read original content for modified files
  const changes: ReviewFileChange[] = fileChanges.map((fc) => {
    const change: ReviewFileChange = {
      path: fc.path,
      status: fc.status as 'created' | 'modified' | 'deleted',
    };

    if (fc.originalContent) change.originalContent = fc.originalContent;
    if (fc.newContent) change.newContent = fc.newContent;

    // Try to read original content if not provided
    if (!change.originalContent && change.status === 'modified') {
      try {
        const fullPath = resolve(process.cwd(), fc.path);
        if (existsSync(fullPath)) {
          change.originalContent = readFileSync(fullPath, 'utf-8');
        }
      } catch { /* ignore */ }
    }

    return change;
  });

  const title = summary
    ? summary.split('\n')[0].slice(0, 80)
    : `Changes for: ${goal.slice(0, 60)}`;

  return createReview(title, goal, changes, {
    provider: options?.provider,
    model: options?.model,
    author: options?.author,
    summary,
    tags: ['agent-generated'],
  });
}
