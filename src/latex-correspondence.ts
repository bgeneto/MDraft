//! Scroll correspondence for a LaTeX preview.
//!
//! The click navigation in `latexSourceAt` answers "which source line is under
//! this point". Scroll correspondence asks a different question in both
//! directions, and the plan's requirement is that it **fail closed on ambiguity**
//! exactly as the click path does: a wrong jump is worse than no jump, because it
//! moves the reader's view away from what they were reading.
//!
//! Everything here is pure. The caller supplies the SyncTeX mapping and the
//! geometry it already has — the source line at the top of the editor, or the
//! page and vertical position at the top of the preview — and gets back either a
//! target or `null`. That keeps the whole rule set unit-testable without an
//! editor, a PDF or a compile.
//!
//! **Why a line is not a point.** SyncTeX maps a source line to one or more
//! regions, and a region to a source line. A paragraph of prose is a single
//! `\par` spanning many typeset lines, so the *same* source line owns several
//! regions on the page. Picking the first would jump to the top of the paragraph
//! every time. The rule below therefore keeps every region for a line and
//! interpolates within the span they cover, which is what makes scrolling feel
//! continuous rather than sticky.

import type { SynctexData, SynctexParser } from "wasmtex/synctex";
import type { LatexResult } from "./latex.ts";

/** A rectangle on a PDF page, in points. */
export interface CorrespondenceRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the preview should scroll to, and what to reveal there. */
export interface PreviewTarget {
  page: number;
  /** The vertical position within the page, in points. */
  y: number;
  /** The regions to paint, so the reader sees what the source line became. */
  regions: CorrespondenceRegion[];
}

/** Where the editor should scroll to. */
export interface SourceTarget {
  file: string;
  line: number;
}

/** The most regions one source line may own before it is treated as structural. */
const MAX_REGIONS = 24;

/**
 * A project file name as SyncTeX records it.
 *
 * SyncTeX writes paths as the engine saw them; the project set is relative with
 * forward slashes. The same normalisation the click path uses, kept here so both
 * directions agree about what "the same file" means.
 */
export function projectName(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The regions a source line produced, or `null` when the line is not usable.
 *
 * Fails closed in three cases, each of which would otherwise produce a confident
 * wrong jump:
 *
 * - the line is not in the project's own file set;
 * - SyncTeX has no exact match, only a nearby one;
 * - the line owns more regions than a single source line plausibly can, which is
 *   how TeX attributes a whole shipped page to `\end{document}`.
 */
export function regionsForLine(
  result: LatexResult,
  file: string,
  line: number,
): CorrespondenceRegion[] | null {
  if (!result.files.has(projectName(file)) || line < 1) return null;
  const forward = result.parser.forwardLookupDetailed(result.mapping, projectName(file), line);
  if (!forward || forward.match !== "exact") return null;
  if (forward.regions.length === 0 || forward.regions.length > MAX_REGIONS) return null;
  return forward.regions.map((region) => ({
    page: region.page,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  }));
}

/**
 * The preview position for a source line.
 *
 * When the line owns several regions, the one nearest the reader's current
 * preview position is chosen — not the first. That is what makes scrolling down
 * through a long paragraph continue downward instead of snapping back to the
 * paragraph's first typeset line on every event.
 *
 * `hint` is optional: the caller passes the preview's current page and vertical
 * position when it has one, and omits it for a fresh jump.
 */
export function previewTargetForLine(
  result: LatexResult,
  file: string,
  line: number,
  hint?: { page: number; y: number },
): PreviewTarget | null {
  const regions = regionsForLine(result, file, line);
  if (!regions) return null;

  // Regions on different pages: prefer the hinted page, else the earliest.
  const pages = [...new Set(regions.map((region) => region.page))].sort((a, b) => a - b);
  const page = hint && pages.includes(hint.page) ? hint.page : pages[0];

  const onPage = regions.filter((region) => region.page === page);
  if (onPage.length === 0) return null;

  const chosen = hint
    ? onPage.reduce((best, region) =>
        Math.abs(region.y - hint.y) < Math.abs(best.y - hint.y) ? region : best,
      )
    : onPage[0];

  return { page, y: chosen.y, regions };
}

/**
 * The source line for a preview position.
 *
 * The inverse of {@link previewTargetForLine}, and it fails closed the same way:
 * the clicked region must be inside the matched container, and the candidate set
 * must collapse to exactly one line. Two lines sharing a region is genuine
 * ambiguity — a macro expansion, or a table where every cell reports the same
 * row — and guessing between them would move the reader's caret somewhere they
 * did not ask for.
 */
export function sourceTargetForPoint(
  result: LatexResult,
  page: number,
  x: number,
  y: number,
): SourceTarget | null {
  const contains = (region: CorrespondenceRegion) =>
    region.page === page &&
    x >= region.x &&
    x <= region.x + region.width &&
    y >= region.y &&
    y <= region.y + region.height;

  const inverse = result.parser.inverseLookupDetailed(result.mapping, page, x, y, {
    acceptSource: (source) => result.files.has(projectName(source.file)),
  });
  if (!inverse || !inverse.container) return null;
  const container = inverse.container;
  if (!contains({ ...container, page })) return null;

  const candidates = new Map<string, SourceTarget>();
  const seen = new Set<string>();
  for (const node of result.mapping.pages.get(page) ?? []) {
    const file = projectName(result.mapping.inputs.get(node.input) ?? "");
    if (!result.files.has(file) || node.line < 1) continue;
    const key = `${file}:${node.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 3000) return null;
    const forward = result.parser.forwardLookupDetailed(result.mapping, file, node.line);
    if (
      forward?.match === "exact" &&
      forward.regions.length <= 6 &&
      forward.regions.some((region) => contains({ ...region, page }))
    ) {
      candidates.set(key, { file, line: node.line });
    }
  }

  const file = projectName(inverse.source.file);
  const key = `${file}:${inverse.source.line}`;
  return candidates.size === 1 ? (candidates.get(key) ?? null) : null;
}

/**
 * The vertical fraction through a page, for the caller that must convert a
 * point to a scroll offset.
 *
 * Kept here rather than in the viewer because it is part of the correspondence
 * rule: the preview scrolls to a *page plus fraction*, and the fraction is what
 * makes a line near the bottom of a page land near the bottom of the viewport.
 */
export function pageFraction(y: number, pageHeight: number): number {
  if (!(pageHeight > 0)) return 0;
  return Math.min(1, Math.max(0, y / pageHeight));
}

/** The mapping's page count, for a caller that must clamp a target. */
export function pageCount(mapping: SynctexData): number {
  let highest = 0;
  for (const page of mapping.pages.keys()) highest = Math.max(highest, page);
  return highest;
}

export type { SynctexData, SynctexParser };
