//! Turn preview-decorated links and images back into destinations a browser
//! outside MDraft can use.
//!
//! `decorateLinks` intentionally rewrites local images to the application's
//! asset protocol and removes every anchor `href`, keeping the original values
//! in `data-src`/`data-href`. That is right for the preview and wrong for an
//! exported file. This module restores those originals and resolves them
//! through the pure policy in `export-paths.ts`; it never trusts a value the
//! preview did not write itself.

import { publicationUrl, type PublicationTarget } from "./export-paths";

const APP_ASSET = /^asset:/i;

export function rewriteExportReferences(host: HTMLElement, target: PublicationTarget): void {
  for (const image of Array.from(host.querySelectorAll("img"))) {
    const original = image.getAttribute("data-src") ?? image.getAttribute("src") ?? "";
    image.removeAttribute("data-src");
    if (!original || APP_ASSET.test(original)) {
      image.removeAttribute("src");
      continue;
    }
    image.setAttribute("src", publicationUrl(original, target));
    // The print document is opened only to be printed; an off-screen figure
    // must already be decoded when the dialog appears.
    if (target.absolute) {
      image.setAttribute("loading", "eager");
      image.setAttribute("decoding", "sync");
    }
  }

  for (const anchor of Array.from(host.querySelectorAll("a"))) {
    const original = anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
    anchor.removeAttribute("data-href");
    if (!original) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("href", publicationUrl(original, target));
  }
}
