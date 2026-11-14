//! Test-only DOM grouping probe, injected into the native performance fixture.
//! It must not be used by the application: it changes the preview's DOM shape.
export function installGroupPrototype(groupSize) {
  const nativeReplace = Element.prototype.replaceChildren;
  const result = (window.__previewGroupPrototype = { groups: 0, blocks: 0 });
  Element.prototype.replaceChildren = function (...nodes) {
    const fragment = nodes.length === 1 ? nodes[0] : null;
    if (this.id !== "preview" || !(fragment instanceof DocumentFragment)) {
      return nativeReplace.apply(this, nodes);
    }
    const blocks = fragment.children.length;
    if (blocks < 10000) return nativeReplace.apply(this, nodes);
    const grouped = document.createDocumentFragment();
    let group = null;
    let count = 0;
    while (fragment.firstChild) {
      const child = fragment.firstChild;
      if (!group || (child.nodeType === Node.ELEMENT_NODE && count >= groupSize)) {
        group = document.createElement("div");
        group.style.contentVisibility = "auto";
        group.style.containIntrinsicSize = `auto ${groupSize * 48}px`;
        grouped.append(group);
        result.groups++;
        count = 0;
      }
      if (child.nodeType === Node.ELEMENT_NODE) count++;
      group.append(child);
    }
    result.blocks = blocks;
    // describePreview reads this length immediately after the swap. This shim
    // retains its existing line-map decision without changing product code.
    Object.defineProperty(this, "children", {
      configurable: true,
      get: () => ({ length: blocks }),
    });
    return nativeReplace.call(this, grouped);
  };
  return CSS.supports("content-visibility", "auto");
}

/** Group the simple-paragraph fixture in the worker reply, before DOM parsing. */
export function installGroupedChunksPrototype(groupSize) {
  const nativePost = Worker.prototype.postMessage;
  const seen = new WeakSet();
  const result = (window.__previewGroupPrototype = { groups: 0, blocks: 0 });
  Worker.prototype.postMessage = function (message, ...rest) {
    if (typeof message?.source === "string" && !seen.has(this)) {
      seen.add(this);
      const handler = this.onmessage;
      this.onmessage = function (event) {
        const data = event.data?.data;
        if (data?.hasRawHtml === false && Array.isArray(data.lines) && data.lines.length >= 10000) {
          const nonempty = data.chunks.filter((chunk) => chunk.length > 0);
          if (
            nonempty.length === data.lines.length &&
            nonempty.every((chunk) => chunk.startsWith("<p>"))
          ) {
            const groups = [];
            for (let start = 0; start < nonempty.length; start += groupSize) {
              const body = nonempty
                .slice(start, start + groupSize)
                .map((chunk, index) =>
                  chunk.replace("<p>", `<p data-line="${data.lines[start + index]}">`),
                )
                .join("");
              groups.push(
                `<div style="content-visibility:auto;contain-intrinsic-size:auto ${groupSize * 48}px">${body}</div>`,
              );
            }
            data.chunks = groups;
            result.groups = groups.length;
            result.blocks = nonempty.length;
          }
        }
        return handler?.call(this, event);
      };
    }
    return nativePost.call(this, message, ...rest);
  };
  const nativeReplace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...nodes) {
    if (this.id === "preview" && result.blocks > 0) {
      Object.defineProperty(this, "children", {
        configurable: true,
        get: () => ({ length: result.blocks }),
      });
    }
    return nativeReplace.apply(this, nodes);
  };
  return CSS.supports("content-visibility", "auto");
}
