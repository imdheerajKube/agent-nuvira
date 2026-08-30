/**
 * Type declarations for non-standard webkit-prefixed HTML attributes.
 * These are widely supported across all major browsers but not in
 * @types/react yet.
 */

import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    /** Opens a folder picker instead of a file picker (Chrome, Edge, Electron). */
    webkitdirectory?: string | boolean;
    /** Allows multiple folder selection. */
    webkitdirectory?: string | boolean;
  }
}
