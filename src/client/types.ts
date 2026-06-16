/**
 * Shared client types.
 *
 * These describe the infobox/headline-media shapes exchanged between App.tsx
 * (which fetches the page payload) and Sidebar.tsx (which renders it). They
 * were previously declared identically in both files; this is the single
 * source of truth. `InfoboxData` is the superset (App carries an optional
 * `image_ordinal` that Sidebar ignores).
 */

export interface InfoboxRow {
  label: string;
  value: string;
}

export interface InfoboxGroup {
  label: string;
  rows: InfoboxRow[];
}

export interface InfoboxData {
  title: string;
  subtitle?: string;
  image_ordinal?: number;
  groups: InfoboxGroup[];
}

export interface HeadlineMedia {
  mediaId: string;
  caption: string;
  description: string;
}
