//! The Emmet engine, loaded on demand.
//!
//! Like the HTML and Typst grammars, this is only fetched when a document that
//! can use it is opened. A Markdown session never pays for the ~70 KB of
//! abbreviation parsing and snippet tables, and nothing here touches the
//! network: the module is part of the application bundle.

import type { EmmetEngine } from "./emmet";

let pending: Promise<EmmetEngine> | null = null;

export function emmetEngine(): Promise<EmmetEngine> {
  if (!pending) {
    pending = import("emmet").then((module) => ({
      expand: module.default,
      extract: module.extract,
    }));
    // A failed load must not be cached: the next HTML tab should try again.
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}
