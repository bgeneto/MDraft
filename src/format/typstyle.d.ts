/**
 * Types for the wasm-bindgen glue module.
 *
 * `@typstyle/typstyle-wasm-bundler` ships `typstyle_wasm.d.ts`, which describes
 * the package entry point, but not the `typstyle_wasm_bg.js` module the entry
 * point delegates to. That module is the one this application loads, because the
 * entry point imports its `.wasm` as an ES module and Vite treats that import as
 * a URL. Declaring the two functions used here is enough; the rest of the glue
 * stays internal to the package.
 */
declare module "@typstyle/typstyle-wasm-bundler/typstyle_wasm_bg.js" {
  export interface TypstyleConfig {
    /** Number of spaces to use for each indentation level. */
    tab_spaces: number;
    /** Maximum width of each line. */
    max_width: number;
    /** Maximum number of consecutive blank lines allowed. */
    blank_lines_upper_bound: number;
    /** Collapse consecutive whitespace in markup into a single space. */
    collapse_markup_spaces: boolean;
    /** Sort import items alphabetically. */
    reorder_import_items: boolean;
    /** Text wrapping mode for markup. */
    wrap_mode: "none" | "fill" | "sentence";
  }

  export function format(text: string, config: Partial<TypstyleConfig>): string;
  export function __wbg_set_wasm(wasm: WebAssembly.Exports): void;
}
