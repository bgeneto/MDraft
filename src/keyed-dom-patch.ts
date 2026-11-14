/**
 * Keyed DOM reconciliation shared by Markdown and AsciiDoc previews.
 * Sanitizes and builds DOM nodes only for dirty/inserted blocks while keeping
 * untouched siblings (`<pre>`, `<img>`, mounted `.mermaid` SVGs) mounted.
 */

import { diffBlocks, type BlockPatchOp } from "./block-diff";
import type { AsciidocBlockChunk, AsciidocChunks, AsciidocMark } from "./asciidoc-render";
import type { MarkdownBlockChunk, PreviewChunks } from "./preview-render";
import {
  clearWordMapPatch,
  registerWordMapPatch,
  type BlockRange,
  type WordMapDirtySlot,
  type WordMapRetainRange,
} from "./source-map";

const PARAGRAPH_GROUP_SIZE = 64;

export interface MarkdownPatchRenderResult {
  applied: true;
  dirtyBlocks: number;
  headingsChanged: boolean;
  hasToc: boolean;
  mermaidDirty: boolean;
}

export interface AsciidocPatchRenderResult {
  applied: true;
  dirtyBlocks: number;
  linesMapped: boolean;
  blocks: BlockRange[];
  mermaidDirty: boolean;
}

function fragmentStarts(blocks: readonly MarkdownBlockChunk[]): number[] {
  const starts = new Array<number>(blocks.length);
  let total = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    starts[i] = total;
    total += blocks[i].fragments?.length ?? 0;
  }
  return starts;
}

function coalesceRetain(
  ranges: WordMapRetainRange[],
  prevStart: number,
  prevEnd: number,
  nextStart: number,
  charDelta: number,
  lineDelta: number,
): void {
  if (prevEnd <= prevStart) return;
  const last = ranges[ranges.length - 1];
  if (
    last &&
    last.prevEnd === prevStart &&
    last.nextStart + (last.prevEnd - last.prevStart) === nextStart &&
    last.charDelta === charDelta &&
    last.lineDelta === lineDelta
  ) {
    last.prevEnd = prevEnd;
    return;
  }
  ranges.push({ prevStart, prevEnd, nextStart, charDelta, lineDelta });
}

function hasMermaidMarker(elements: readonly HTMLElement[]): boolean {
  for (const el of elements) {
    if (el.matches(".mermaid[data-mermaid]") || el.querySelector(".mermaid[data-mermaid]")) {
      return true;
    }
  }
  return false;
}

function patchGroupedParagraphs(
  host: HTMLElement,
  prevBlocks: readonly MarkdownBlockChunk[],
  nextBlocks: readonly MarkdownBlockChunk[],
  ops: readonly BlockPatchOp<MarkdownBlockChunk>[],
  prevFragStarts: readonly number[],
  nextFragStarts: readonly number[],
  buildBlockElements: (block: MarkdownBlockChunk) => HTMLElement[],
  prevSource: string,
  nextSource: string,
): MarkdownPatchRenderResult | null {
  const prevEls: HTMLElement[] = [];
  for (const group of Array.from(host.children)) {
    if (!group.classList.contains("md-preview-group")) return null;
    for (const child of Array.from(group.children)) {
      prevEls.push(child as HTMLElement);
    }
  }
  if (prevEls.length !== prevBlocks.length) return null;

  const retainedRanges: WordMapRetainRange[] = [];
  const dirtySlots: WordMapDirtySlot[] = [];
  const removedPrevFrags: number[] = [];
  let dirtyBlocks = 0;

  // Track simple flat element list in memory using existing retained elements.
  // Because `insert` / `remove` on 10,000 paragraphs is rare, updating buckets from
  // the first changed bucket onward leaves all preceding buckets untouched.
  const nextEls: HTMLElement[] = new Array(nextBlocks.length);
  let hasStructureDelta = false;
  let firstDirtyBucket = Number.MAX_SAFE_INTEGER;

  for (const op of ops) {
    if (op.kind === "retain") {
      const el = prevEls[op.prevIndex];
      if (!el) return null;
      if (op.lineDelta !== 0) {
        el.setAttribute("data-line", String(op.block.lineStart));
      }
      nextEls[op.nextIndex] = el;
      const pCount = prevBlocks[op.prevIndex].fragments?.length ?? 0;
      coalesceRetain(
        retainedRanges,
        prevFragStarts[op.prevIndex],
        prevFragStarts[op.prevIndex] + pCount,
        nextFragStarts[op.nextIndex],
        op.block.origStart - prevBlocks[op.prevIndex].origStart,
        op.lineDelta,
      );
      if (op.prevIndex !== op.nextIndex) {
        hasStructureDelta = true;
        firstDirtyBucket = Math.min(
          firstDirtyBucket,
          Math.floor(op.nextIndex / PARAGRAPH_GROUP_SIZE),
        );
      }
    } else if (op.kind === "remove") {
      dirtyBlocks += 1;
      hasStructureDelta = true;
      const prevFragCount = prevBlocks[op.prevIndex].fragments?.length ?? 0;
      const pBase = prevFragStarts[op.prevIndex];
      for (let k = 0; k < prevFragCount; k += 1) removedPrevFrags.push(pBase + k);
      firstDirtyBucket = Math.min(
        firstDirtyBucket,
        Math.floor(op.prevIndex / PARAGRAPH_GROUP_SIZE),
      );
    } else if (op.kind === "replace") {
      dirtyBlocks += 1;
      const prevFragCount = prevBlocks[op.prevIndex].fragments?.length ?? 0;
      const pBase = prevFragStarts[op.prevIndex];
      for (let k = 0; k < prevFragCount; k += 1) removedPrevFrags.push(pBase + k);
      const els = buildBlockElements(op.block);
      if (els.length !== 1) return null;
      const newEl = els[0];
      newEl.setAttribute("data-line", String(op.block.lineStart));
      if (op.nextIndex === 0) newEl.style.marginTop = "0";
      nextEls[op.nextIndex] = newEl;
      const oldEl = prevEls[op.prevIndex];
      if (!hasStructureDelta && oldEl && oldEl.parentElement) {
        oldEl.replaceWith(newEl);
      } else {
        firstDirtyBucket = Math.min(
          firstDirtyBucket,
          Math.floor(op.nextIndex / PARAGRAPH_GROUP_SIZE),
        );
      }
      dirtySlots.push({
        nextStart: nextFragStarts[op.nextIndex],
        nextEnd: nextFragStarts[op.nextIndex] + (op.block.fragments?.length ?? 0),
        elements: [newEl],
      });
    } else {
      dirtyBlocks += 1;
      hasStructureDelta = true;
      const els = buildBlockElements(op.block);
      if (els.length !== 1) return null;
      const newEl = els[0];
      newEl.setAttribute("data-line", String(op.block.lineStart));
      if (op.nextIndex === 0) newEl.style.marginTop = "0";
      nextEls[op.nextIndex] = newEl;
      firstDirtyBucket = Math.min(
        firstDirtyBucket,
        Math.floor(op.nextIndex / PARAGRAPH_GROUP_SIZE),
      );
      dirtySlots.push({
        nextStart: nextFragStarts[op.nextIndex],
        nextEnd: nextFragStarts[op.nextIndex] + (op.block.fragments?.length ?? 0),
        elements: [newEl],
      });
    }
  }

  if (hasStructureDelta) {
    const startBucket = Number.isFinite(firstDirtyBucket) ? firstDirtyBucket : 0;
    const neededBuckets = Math.ceil(nextEls.length / PARAGRAPH_GROUP_SIZE);
    while (host.children.length > neededBuckets) {
      host.lastElementChild?.remove();
    }
    for (let b = startBucket; b < neededBuckets; b += 1) {
      let bucket = host.children[b] as HTMLElement | undefined;
      if (!bucket) {
        bucket = document.createElement("div");
        bucket.className = "md-preview-group";
        bucket.style.contentVisibility = "auto";
        bucket.style.containIntrinsicSize = "auto 3072px";
        host.appendChild(bucket);
      }
      const from = b * PARAGRAPH_GROUP_SIZE;
      const to = Math.min(nextEls.length, from + PARAGRAPH_GROUP_SIZE);
      const slice = nextEls.slice(from, to);
      if (b === 0 && slice[0]) slice[0].style.marginTop = "0";
      bucket.replaceChildren(...slice);
    }
  } else if (nextEls[0] && nextEls[0].style.marginTop !== "0") {
    nextEls[0].style.marginTop = "0";
  }

  host.dataset.mdraftLocalFragments = "1";
  registerWordMapPatch(host, {
    kind: "markdown",
    prevSource,
    nextSource,
    retained: retainedRanges,
    dirty: dirtySlots,
    removedPrevIndices: removedPrevFrags,
  });

  return {
    applied: true,
    dirtyBlocks,
    headingsChanged: false,
    hasToc: false,
    mermaidDirty: false,
  };
}

/**
 * Reconcile a mounted Markdown `#preview` container in place when `<= 35%` of
 * blocks changed and structural fail-safe triggers are clear. Returns null to
 * request a full batched rebuild.
 */
export function patchMarkdownDom(
  host: HTMLElement,
  prevSource: string,
  prevChunks: PreviewChunks,
  nextSource: string,
  nextChunks: PreviewChunks,
  prevGrouped: boolean,
  nextGrouped: boolean,
  buildBlockElements: (block: MarkdownBlockChunk) => HTMLElement[],
): MarkdownPatchRenderResult | null {
  if (
    !prevChunks.blocks ||
    !nextChunks.blocks ||
    prevChunks.hasRawHtml ||
    nextChunks.hasRawHtml ||
    prevChunks.lines === null ||
    nextChunks.lines === null ||
    prevGrouped !== nextGrouped ||
    (nextChunks.legacyImages && Object.keys(nextChunks.legacyImages).length > 0)
  ) {
    clearWordMapPatch(host);
    return null;
  }

  const prevBlocks = prevChunks.blocks;
  const nextBlocks = nextChunks.blocks;
  const diff = diffBlocks(prevBlocks, nextBlocks);
  if (!diff.incremental) {
    clearWordMapPatch(host);
    return null;
  }

  const prevFragStarts = fragmentStarts(prevBlocks);
  const nextFragStarts = fragmentStarts(nextBlocks);

  if (prevGrouped && nextGrouped) {
    return patchGroupedParagraphs(
      host,
      prevBlocks,
      nextBlocks,
      diff.ops,
      prevFragStarts,
      nextFragStarts,
      buildBlockElements,
      prevSource,
      nextSource,
    );
  }

  const prevDom: Array<HTMLElement | null> = new Array(prevBlocks.length);
  let visibleDomIdx = 0;
  for (let i = 0; i < prevBlocks.length; i += 1) {
    if (prevBlocks[i].silent) {
      prevDom[i] = null;
    } else {
      const child = host.children[visibleDomIdx++] as HTMLElement | undefined;
      if (!child) {
        clearWordMapPatch(host);
        return null;
      }
      prevDom[i] = child;
    }
  }
  if (visibleDomIdx !== host.children.length) {
    clearWordMapPatch(host);
    return null;
  }

  const retainedRanges: WordMapRetainRange[] = [];
  const dirtySlots: WordMapDirtySlot[] = [];
  const removedPrevFrags: number[] = [];
  let cursor: Element | null = host.firstElementChild;
  let dirtyBlocks = 0;
  let headingsChanged = false;
  let hasToc = false;
  let mermaidDirty = false;

  for (const b of nextBlocks) {
    if (
      b.tokenType === "paragraph" &&
      /^\s*\[TOC\]\s*$/i.test(nextSource.slice(b.origStart, b.origEnd))
    ) {
      hasToc = true;
      break;
    }
  }

  for (const op of diff.ops) {
    if (op.kind === "retain") {
      const prevB = prevBlocks[op.prevIndex];
      if (!op.block.silent) {
        const el = prevDom[op.prevIndex];
        if (!el) {
          clearWordMapPatch(host);
          return null;
        }
        if (el === cursor) {
          cursor = cursor.nextElementSibling;
        } else {
          host.insertBefore(el, cursor);
        }
        if (op.lineDelta !== 0) {
          el.setAttribute("data-line", String(op.block.lineStart));
        }
      }
      const pCount = prevB.fragments?.length ?? 0;
      coalesceRetain(
        retainedRanges,
        prevFragStarts[op.prevIndex],
        prevFragStarts[op.prevIndex] + pCount,
        nextFragStarts[op.nextIndex],
        op.block.origStart - prevB.origStart,
        op.lineDelta,
      );
    } else if (op.kind === "remove") {
      dirtyBlocks += 1;
      const prevB = prevBlocks[op.prevIndex];
      if (prevB.tokenType === "heading") headingsChanged = true;
      const pCount = prevB.fragments?.length ?? 0;
      const pBase = prevFragStarts[op.prevIndex];
      for (let k = 0; k < pCount; k += 1) removedPrevFrags.push(pBase + k);
      if (!prevB.silent) {
        const oldEl = prevDom[op.prevIndex];
        if (oldEl && oldEl === cursor) cursor = cursor.nextElementSibling;
        oldEl?.remove();
      }
    } else if (op.kind === "replace") {
      dirtyBlocks += 1;
      const prevB = prevBlocks[op.prevIndex];
      if (prevB.tokenType === "heading" || op.block.tokenType === "heading") {
        headingsChanged = true;
      }
      const pCount = prevB.fragments?.length ?? 0;
      const pBase = prevFragStarts[op.prevIndex];
      for (let k = 0; k < pCount; k += 1) removedPrevFrags.push(pBase + k);

      const oldEl = prevB.silent ? null : prevDom[op.prevIndex];
      if (op.block.silent) {
        if (oldEl) {
          if (oldEl === cursor) cursor = cursor.nextElementSibling;
          oldEl.remove();
        }
      } else {
        const els = buildBlockElements(op.block);
        if (els.length === 0) {
          clearWordMapPatch(host);
          return null;
        }
        for (const el of els) el.setAttribute("data-line", String(op.block.lineStart));
        if (hasMermaidMarker(els)) mermaidDirty = true;
        if (oldEl && els.length === 1) {
          if (oldEl === cursor) cursor = cursor.nextElementSibling;
          oldEl.replaceWith(els[0]);
        } else {
          if (oldEl) {
            if (oldEl === cursor) cursor = cursor.nextElementSibling;
            oldEl.remove();
          }
          for (const el of els) host.insertBefore(el, cursor);
        }
        dirtySlots.push({
          nextStart: nextFragStarts[op.nextIndex],
          nextEnd: nextFragStarts[op.nextIndex] + (op.block.fragments?.length ?? 0),
          elements: els,
        });
      }
    } else {
      dirtyBlocks += 1;
      if (op.block.tokenType === "heading") headingsChanged = true;
      if (!op.block.silent) {
        const els = buildBlockElements(op.block);
        if (els.length === 0) {
          clearWordMapPatch(host);
          return null;
        }
        for (const el of els) el.setAttribute("data-line", String(op.block.lineStart));
        if (hasMermaidMarker(els)) mermaidDirty = true;
        for (const el of els) host.insertBefore(el, cursor);
        dirtySlots.push({
          nextStart: nextFragStarts[op.nextIndex],
          nextEnd: nextFragStarts[op.nextIndex] + (op.block.fragments?.length ?? 0),
          elements: els,
        });
      }
    }
  }

  host.dataset.mdraftLocalFragments = "1";
  registerWordMapPatch(host, {
    kind: "markdown",
    prevSource,
    nextSource,
    retained: retainedRanges,
    dirty: dirtySlots,
    removedPrevIndices: removedPrevFrags,
  });

  return {
    applied: true,
    dirtyBlocks,
    headingsChanged,
    hasToc,
    mermaidDirty,
  };
}

interface AsciidocSectionGroup {
  kind: "top" | "sect";
  key: string;
  sectionId: string | null;
  digest: string;
  lineStart: number;
  openBlock?: AsciidocBlockChunk;
  closeBlock?: AsciidocBlockChunk;
  blocks: AsciidocBlockChunk[];
}

function groupAsciidocSections(blocks: readonly AsciidocBlockChunk[]): AsciidocSectionGroup[] {
  const groups: AsciidocSectionGroup[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.kind === "sect-open") {
      const children: AsciidocBlockChunk[] = [];
      let closeBlock: AsciidocBlockChunk | undefined;
      i += 1;
      while (i < blocks.length) {
        const cur = blocks[i];
        if (cur.kind === "sect-close" && cur.sectionId === b.sectionId) {
          closeBlock = cur;
          i += 1;
          break;
        }
        children.push(cur);
        i += 1;
      }
      groups.push({
        kind: "sect",
        key: `sect:${b.sectionId ?? i}`,
        sectionId: b.sectionId,
        digest: b.digest,
        lineStart: b.lineStart,
        openBlock: b,
        closeBlock,
        blocks: children,
      });
    } else {
      groups.push({
        kind: "top",
        key: b.key,
        sectionId: null,
        digest: b.digest,
        lineStart: b.lineStart,
        blocks: [b],
      });
      i += 1;
    }
  }
  return groups;
}

export function applyAsciidocBlockMarks(root: HTMLElement, marks: readonly AsciidocMark[]): void {
  const byMarker = new Map<string, AsciidocMark>();
  for (const m of marks) byMarker.set(m.marker, m);

  const visit = (el: HTMLElement): void => {
    const marker = Array.from(el.classList).find((c) => c.startsWith("mdraft-line-"));
    if (!marker) return;
    const mark = byMarker.get(marker);
    el.classList.remove(marker);
    if (el.classList.length === 0) el.removeAttribute("class");
    if (mark) {
      const target = el.matches(".sect1, .sect2, .sect3, .sect4, .sect5")
        ? (el.querySelector<HTMLElement>(
            ":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
          ) ?? el)
        : el;
      target.setAttribute("data-line", String(mark.line));
      target.setAttribute("data-line-end", String(mark.endLine ?? mark.line));
    }
  };

  if (root.hasAttribute("class")) visit(root);
  for (const nested of Array.from(root.querySelectorAll<HTMLElement>("[class]"))) {
    visit(nested);
  }
}

function updateRetainedAsciidocMarks(
  root: HTMLElement,
  prevMarks: readonly AsciidocMark[],
  nextMarks: readonly AsciidocMark[],
  skipSectionBody = false,
): void {
  if (prevMarks.length === 0 || nextMarks.length === 0) return;
  const targets: HTMLElement[] = [];
  if (!skipSectionBody) {
    if (root.hasAttribute("data-line")) targets.push(root);
    for (const nested of Array.from(root.querySelectorAll<HTMLElement>("[data-line]"))) {
      targets.push(nested);
    }
  } else {
    const heading = root.querySelector<HTMLElement>(":scope > h2, :scope > h3");
    if (heading && heading.hasAttribute("data-line")) targets.push(heading);
  }

  for (let i = 0; i < targets.length && i < nextMarks.length; i += 1) {
    const prev = prevMarks[i];
    const next = nextMarks[i];
    if (
      !prev ||
      prev.line !== next.line ||
      (prev.endLine ?? prev.line) !== (next.endLine ?? next.line)
    ) {
      targets[i].setAttribute("data-line", String(next.line));
      targets[i].setAttribute("data-line-end", String(next.endLine ?? next.line));
    }
  }
}

/**
 * Reconcile a mounted AsciiDoc `#preview` container with sub-`sect1` child
 * granularity. Returns null when structural triggers or mismatch require a full build.
 */
export function patchAsciidocDom(
  host: HTMLElement,
  prevSource: string,
  prevChunks: AsciidocChunks,
  nextSource: string,
  nextChunks: AsciidocChunks,
  prevBlocksRanges: readonly BlockRange[],
  renderSingleBlock: (block: AsciidocBlockChunk) => HTMLElement | null,
  renderFullSection: (group: AsciidocSectionGroup) => HTMLElement | null,
): AsciidocPatchRenderResult | null {
  if (!prevChunks.blocks || !nextChunks.blocks) {
    clearWordMapPatch(host);
    return null;
  }

  const flatDiff = diffBlocks(prevChunks.blocks, nextChunks.blocks);
  if (!flatDiff.incremental) {
    clearWordMapPatch(host);
    return null;
  }

  const prevGroups = groupAsciidocSections(prevChunks.blocks);
  const nextGroups = groupAsciidocSections(nextChunks.blocks);
  if (host.children.length !== prevGroups.length) {
    clearWordMapPatch(host);
    return null;
  }

  // Match groups strictly by `key + digest` except `sect` groups may mutate inside their `.sectionbody`.
  const prevTopDom = Array.from(host.children) as HTMLElement[];
  const dirtySubtrees = new Set<HTMLElement>();
  const retainedGroupLineDelta = new WeakMap<HTMLElement, number>();
  let mermaidDirty = false;
  let dirtyBlocks = 0;

  // Compute structural group ops allowing `sect` with equal `openBlock.digest` to reconcile inside.
  const groupDiffItems = prevGroups.map((g) => ({
    key: g.key,
    digest: g.kind === "sect" ? g.digest : g.blocks[0].digest,
    lineStart: g.lineStart,
    group: g,
  }));
  const nextGroupItems = nextGroups.map((g) => ({
    key: g.key,
    digest: g.kind === "sect" ? g.digest : g.blocks[0].digest,
    lineStart: g.lineStart,
    group: g,
  }));

  const groupDiff = diffBlocks(groupDiffItems, nextGroupItems, 1.0);
  let cursor: Element | null = host.firstElementChild;

  for (const op of groupDiff.ops) {
    if (op.kind === "retain") {
      const prevG = prevGroups[op.prevIndex];
      const nextG = nextGroups[op.nextIndex];
      const secEl = prevTopDom[op.prevIndex];
      if (!secEl) {
        clearWordMapPatch(host);
        return null;
      }
      if (secEl === cursor) cursor = cursor.nextElementSibling;
      else host.insertBefore(secEl, cursor);

      if (prevG.kind === "top" && nextG.kind === "top") {
        updateRetainedAsciidocMarks(secEl, prevG.blocks[0].marks, nextG.blocks[0].marks, false);
        retainedGroupLineDelta.set(
          secEl,
          (nextG.blocks[0].marks[0]?.line ?? nextG.lineStart) -
            (prevG.blocks[0].marks[0]?.line ?? prevG.lineStart),
        );
        continue;
      }

      if (prevG.kind === "sect" && nextG.kind === "sect") {
        if (prevG.openBlock && nextG.openBlock) {
          updateRetainedAsciidocMarks(secEl, prevG.openBlock.marks, nextG.openBlock.marks, true);
          const heading = secEl.querySelector<HTMLElement>(":scope > h2, :scope > h3");
          if (heading) {
            retainedGroupLineDelta.set(
              heading,
              (nextG.openBlock.marks[0]?.line ?? nextG.lineStart) -
                (prevG.openBlock.marks[0]?.line ?? prevG.lineStart),
            );
          }
        }

        const sectionBody = secEl.querySelector<HTMLElement>(":scope > .sectionbody");
        if (!sectionBody || sectionBody.children.length !== prevG.blocks.length) {
          const rebuilt = renderFullSection(nextG);
          if (!rebuilt) {
            clearWordMapPatch(host);
            return null;
          }
          if (hasMermaidMarker([rebuilt])) mermaidDirty = true;
          secEl.replaceWith(rebuilt);
          dirtySubtrees.add(rebuilt);
          dirtyBlocks += nextG.blocks.length;
          continue;
        }

        const childDiff = diffBlocks(prevG.blocks, nextG.blocks, 1.0);
        const prevChildDom = Array.from(sectionBody.children) as HTMLElement[];
        let childCursor: Element | null = sectionBody.firstElementChild;
        for (const cop of childDiff.ops) {
          if (cop.kind === "retain") {
            const childEl = prevChildDom[cop.prevIndex];
            if (!childEl) {
              clearWordMapPatch(host);
              return null;
            }
            if (childEl === childCursor) childCursor = childCursor.nextElementSibling;
            else sectionBody.insertBefore(childEl, childCursor);
            updateRetainedAsciidocMarks(
              childEl,
              prevG.blocks[cop.prevIndex].marks,
              cop.block.marks,
              false,
            );
            retainedGroupLineDelta.set(childEl, cop.lineDelta);
          } else if (cop.kind === "remove") {
            dirtyBlocks += 1;
            const oldChild = prevChildDom[cop.prevIndex];
            if (oldChild === childCursor) childCursor = childCursor.nextElementSibling;
            oldChild?.remove();
          } else if (cop.kind === "replace") {
            dirtyBlocks += 1;
            const oldChild = prevChildDom[cop.prevIndex];
            const nextChild = renderSingleBlock(cop.block);
            if (!nextChild) {
              clearWordMapPatch(host);
              return null;
            }
            if (hasMermaidMarker([nextChild])) mermaidDirty = true;
            if (oldChild) {
              if (oldChild === childCursor) childCursor = childCursor.nextElementSibling;
              oldChild.replaceWith(nextChild);
            } else {
              sectionBody.insertBefore(nextChild, childCursor);
            }
            dirtySubtrees.add(nextChild);
          } else {
            dirtyBlocks += 1;
            const nextChild = renderSingleBlock(cop.block);
            if (!nextChild) {
              clearWordMapPatch(host);
              return null;
            }
            if (hasMermaidMarker([nextChild])) mermaidDirty = true;
            sectionBody.insertBefore(nextChild, childCursor);
            dirtySubtrees.add(nextChild);
          }
        }
      }
    } else if (op.kind === "remove") {
      dirtyBlocks += prevGroups[op.prevIndex].blocks.length;
      const oldEl = prevTopDom[op.prevIndex];
      if (oldEl === cursor) cursor = cursor.nextElementSibling;
      oldEl?.remove();
    } else if (op.kind === "replace") {
      const nextG = nextGroups[op.nextIndex];
      dirtyBlocks += nextG.blocks.length;
      const oldEl = prevTopDom[op.prevIndex];
      const built =
        nextG.kind === "top" ? renderSingleBlock(nextG.blocks[0]) : renderFullSection(nextG);
      if (!built) {
        clearWordMapPatch(host);
        return null;
      }
      if (hasMermaidMarker([built])) mermaidDirty = true;
      if (oldEl) {
        if (oldEl === cursor) cursor = cursor.nextElementSibling;
        oldEl.replaceWith(built);
      } else {
        host.insertBefore(built, cursor);
      }
      dirtySubtrees.add(built);
    } else {
      const nextG = nextGroups[op.nextIndex];
      dirtyBlocks += nextG.blocks.length;
      const built =
        nextG.kind === "top" ? renderSingleBlock(nextG.blocks[0]) : renderFullSection(nextG);
      if (!built) {
        clearWordMapPatch(host);
        return null;
      }
      if (hasMermaidMarker([built])) mermaidDirty = true;
      host.insertBefore(built, cursor);
      dirtySubtrees.add(built);
    }
  }

  if (nextChunks.hasHeader && !nextChunks.notitle) {
    const title = host.querySelector("h1");
    if (title) {
      title.setAttribute("data-line", "1");
      title.setAttribute("data-line-end", "1");
    }
  }

  const lineOffsets: number[] = [0];
  for (let i = 0; i < nextSource.length; i += 1) {
    if (nextSource.charCodeAt(i) === 10) lineOffsets.push(i + 1);
  }

  const nextBlocksRanges: BlockRange[] = [];
  const retainedRanges: WordMapRetainRange[] = [];
  const dirtySlots: WordMapDirtySlot[] = [];
  const retainedOldIndices = new Set<number>();

  const isDirtyNode = (el: HTMLElement): { dirty: boolean; lineDelta: number } => {
    let cur: HTMLElement | null = el;
    let delta = 0;
    let foundDelta = false;
    while (cur && cur !== host) {
      if (dirtySubtrees.has(cur)) return { dirty: true, lineDelta: 0 };
      if (!foundDelta && retainedGroupLineDelta.has(cur)) {
        delta = retainedGroupLineDelta.get(cur) ?? 0;
        foundDelta = true;
      }
      cur = cur.parentElement;
    }
    return { dirty: false, lineDelta: delta };
  };

  for (const el of Array.from(host.querySelectorAll<HTMLElement>("[data-line]"))) {
    const start = Number(el.dataset.line);
    const end = Number(el.dataset.lineEnd ?? el.dataset.line);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const src0 = lineOffsets[Math.max(0, start - 1)] ?? 0;
    const src1 = end < lineOffsets.length ? lineOffsets[end] : nextSource.length;
    const nextB = nextBlocksRanges.length;
    const status = isDirtyNode(el);
    const oldBAttr = el.getAttribute("data-b");
    const oldB = oldBAttr !== null ? Number(oldBAttr) : -1;

    el.dataset.b = String(nextB);
    nextBlocksRanges.push({ src0, src1 });

    if (!status.dirty && Number.isInteger(oldB) && oldB >= 0 && oldB < prevBlocksRanges.length) {
      retainedOldIndices.add(oldB);
      const charDelta = src0 - prevBlocksRanges[oldB].src0;
      coalesceRetain(retainedRanges, oldB, oldB + 1, nextB, charDelta, status.lineDelta);
    } else {
      dirtySlots.push({ nextStart: nextB, nextEnd: nextB + 1, elements: [el] });
    }
  }

  const removedPrevIndices: number[] = [];
  for (let pb = 0; pb < prevBlocksRanges.length; pb += 1) {
    if (!retainedOldIndices.has(pb)) removedPrevIndices.push(pb);
  }

  registerWordMapPatch(host, {
    kind: "asciidoc",
    prevSource,
    nextSource,
    retained: retainedRanges,
    dirty: dirtySlots,
    removedPrevIndices,
  });

  return {
    applied: true,
    dirtyBlocks,
    linesMapped: nextBlocksRanges.length >= 2,
    blocks: nextBlocksRanges,
    mermaidDirty,
  };
}
