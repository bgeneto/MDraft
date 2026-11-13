use std::path::PathBuf;
use std::time::Instant;

use typst::foundations::Bytes;
use typst_html::{HtmlDocument, HtmlOptions};
use typst_layout::PagedDocument;
use typst_library::diag::{Severity, SourceDiagnostic};
use typst_pdf::PdfOptions;

use crate::protocol::{
    CompileParams, CompileResult, CompileTarget, CompileTimings, DiagnosticInfo, PROTOCOL_VERSION,
    Request, RequestMethod, Response, ServiceStats, VfsOverlayEntry, decode_base64, encode_base64,
};
use crate::world::{
    ServiceWorld, compute_page_hashes, diff_page_hashes, extract_span_map, location_to_spans,
    point_to_location,
};

pub const TYPST_CRATE_VERSION: &str = "0.15.1";

pub struct ServiceConfig {
    pub root: PathBuf,
    pub load_system_fonts: bool,
    pub enable_local_packages: bool,
    pub max_cache_age: usize,
    pub max_rss_mb: u64,
}

pub struct ServiceEngine {
    world: ServiceWorld,
    last_paged: Option<PagedDocument>,
    last_page_hashes: Vec<String>,
    compile_count: u64,
    max_cache_age: usize,
    max_rss_bytes: Option<u64>,
}

impl ServiceEngine {
    pub fn new(config: ServiceConfig) -> Self {
        Self {
            world: ServiceWorld::new(
                config.root,
                config.load_system_fonts,
                config.enable_local_packages,
            ),
            last_paged: None,
            last_page_hashes: Vec::new(),
            compile_count: 0,
            max_cache_age: config.max_cache_age,
            max_rss_bytes: (config.max_rss_mb > 0).then(|| config.max_rss_mb * 1024 * 1024),
        }
    }

    pub fn handle_request(
        &mut self,
        req: Request,
        body: Option<Vec<u8>>,
        include_base64: bool,
    ) -> (Response, Vec<u8>, bool) {
        let id = req.id;
        match req.call {
            RequestMethod::Ping => {
                let mut resp = Response::success(id);
                resp.stats = Some(self.stats());
                (resp, Vec::new(), false)
            }
            RequestMethod::Shutdown => (Response::success(id), Vec::new(), true),
            RequestMethod::Stats => {
                let mut resp = Response::success(id);
                resp.stats = Some(self.stats());
                (resp, Vec::new(), false)
            }
            RequestMethod::EvictCache(params) => {
                comemo::evict(params.max_age);
                let mut resp = Response::success(id);
                resp.stats = Some(self.stats());
                (resp, Vec::new(), false)
            }
            RequestMethod::ClearVfsOverlay => {
                self.world.loader().clear_overlay();
                self.world.reset_files();
                (Response::success(id), Vec::new(), false)
            }
            RequestMethod::SetVfsOverlay(params) => {
                if let Some(root) = params.root {
                    self.world.set_root(PathBuf::from(root));
                }
                if params.replace_all {
                    self.world.loader().clear_overlay();
                }
                match self.apply_overlays(&params.entries) {
                    Ok(()) => {
                        self.world.reset_files();
                        (Response::success(id), Vec::new(), false)
                    }
                    Err(err) => (Response::err(id, err), Vec::new(), false),
                }
            }
            RequestMethod::LocationToSpans(params) => {
                let Some(doc) = self.last_paged.as_ref() else {
                    return (
                        Response::err(id, "no compiled paged document is active"),
                        Vec::new(),
                        false,
                    );
                };
                match location_to_spans(&self.world, doc, &params.file, params.line, params.column)
                {
                    Ok(spans) => {
                        let mut resp = Response::success(id);
                        resp.spans = Some(spans);
                        (resp, Vec::new(), false)
                    }
                    Err(err) => (Response::err(id, err), Vec::new(), false),
                }
            }
            RequestMethod::PointToLocation(params) => {
                let Some(doc) = self.last_paged.as_ref() else {
                    return (
                        Response::err(id, "no compiled paged document is active"),
                        Vec::new(),
                        false,
                    );
                };
                let loc = point_to_location(&self.world, doc, params.page, params.x_pt, params.y_pt);
                let mut resp = Response::success(id);
                resp.source_location = loc;
                (resp, Vec::new(), false)
            }
            RequestMethod::Compile(params) => match self.compile(params, body) {
                Ok((compile_res, payload)) => {
                    let mut resp = Response::success(id);
                    resp.payload_bytes = payload.len();
                    if include_base64 && !payload.is_empty() {
                        resp.payload_base64 = Some(encode_base64(&payload));
                    }
                    resp.compile = Some(compile_res);
                    let rss_exceeded = self.enforce_rss_ceiling();
                    resp.stats = Some(self.stats());
                    (resp, payload, rss_exceeded)
                }
                Err(err) => (Response::err(id, err), Vec::new(), false),
            },
        }
    }

    fn enforce_rss_ceiling(&mut self) -> bool {
        let Some(limit) = self.max_rss_bytes else {
            return false;
        };
        if current_rss_bytes().is_none_or(|rss| rss <= limit) {
            return false;
        }
        comemo::evict(0);
        current_rss_bytes().is_some_and(|rss| rss > limit)
    }

    pub fn stats(&self) -> ServiceStats {
        ServiceStats {
            protocol_version: PROTOCOL_VERSION,
            typst_version: TYPST_CRATE_VERSION,
            compile_count: self.compile_count,
            max_cache_age: self.max_cache_age,
            font_families: self.world.font_families_count(),
            overlay_entries: self.world.loader().overlay_len(),
            last_page_count: self.last_page_hashes.len(),
            rss_bytes: current_rss_bytes(),
        }
    }

    fn apply_overlays(&self, entries: &[VfsOverlayEntry]) -> Result<(), String> {
        for entry in entries {
            let vpath = self.world.loader().resolve_to_vpath(&entry.path)?;
            if entry.remove {
                self.world.loader().remove_overlay(&vpath);
                continue;
            }
            if let Some(text) = &entry.content {
                self.world
                    .loader()
                    .insert_overlay(vpath, Bytes::from_string(text.clone()));
            } else if let Some(b64) = &entry.content_base64 {
                let raw = decode_base64(b64)?;
                self.world.loader().insert_overlay(vpath, Bytes::new(raw));
            }
        }
        Ok(())
    }

    pub fn compile(
        &mut self,
        params: CompileParams,
        body: Option<Vec<u8>>,
    ) -> Result<(CompileResult, Vec<u8>), String> {
        let total_t0 = Instant::now();
        let vfs_t0 = Instant::now();

        if let Some(root) = &params.root {
            self.world.set_root(PathBuf::from(root));
        }
        if params.clear_unspecified_overlays {
            self.world.loader().clear_overlay();
        }
        self.apply_overlays(&params.vfs_overlays)?;
        let main_vpath = self.world.set_main(&params.main_path)?;
        if let Some(raw_body) = body.filter(|b| !b.is_empty()) {
            self.world
                .loader()
                .insert_overlay(main_vpath, Bytes::new(raw_body));
        } else if let Some(text) = params.source_text {
            self.world
                .loader()
                .insert_overlay(main_vpath, Bytes::from_string(text));
        }
        self.world.reset_files();
        let vfs_sync_ms = vfs_t0.elapsed().as_secs_f64() * 1000.0;

        self.compile_count += 1;

        let include_span_map = params.include_span_map;
        let out = match params.target {
            CompileTarget::Pages => {
                self.compile_pages(vfs_sync_ms, total_t0, params.tagged_pdf, include_span_map, false)?
            }
            CompileTarget::Document => self.compile_document(
                vfs_sync_ms,
                total_t0,
                params.fallback_to_pages_if_ignored,
                params.tagged_pdf,
                include_span_map,
            )?,
        };

        // Enforce bounded comemo memoization memory ceiling after every compile.
        comemo::evict(self.max_cache_age);
        Ok(out)
    }

    fn compile_pages(
        &mut self,
        vfs_sync_ms: f64,
        total_t0: Instant,
        tagged_pdf: bool,
        include_span_map: bool,
        fell_back_from_document: bool,
    ) -> Result<(CompileResult, Vec<u8>), String> {
        let compile_t0 = Instant::now();
        let warned = typst::compile::<PagedDocument>(&self.world);
        let typst_compile_ms = compile_t0.elapsed().as_secs_f64() * 1000.0;
        let deps = self.world.snapshot_disk_deps();

        let (warnings, mut errors, ignored, mut diagnostics) =
            self.collect_diagnostics(&warned.warnings, &[]);

        match warned.output {
            Ok(doc) => {
                let hash_t0 = Instant::now();
                let new_hashes = compute_page_hashes(&doc);
                let (first_changed_page, changed_pages) =
                    diff_page_hashes(&self.last_page_hashes, &new_hashes);
                let page_hash_ms = hash_t0.elapsed().as_secs_f64() * 1000.0;

                let export_t0 = Instant::now();
                let pdf_opts = PdfOptions {
                    tagged: tagged_pdf,
                    ..PdfOptions::default()
                };
                let pdf_bytes = typst_pdf::pdf(&doc, &pdf_opts).map_err(|errs| {
                    errs.iter()
                        .map(|e| e.message.to_string())
                        .collect::<Vec<_>>()
                        .join("\n")
                })?;
                let export_ms = export_t0.elapsed().as_secs_f64() * 1000.0;
                let page_count = doc.pages().len();
                let span_map = if include_span_map {
                    extract_span_map(&self.world, &doc)
                } else {
                    Vec::new()
                };

                self.last_page_hashes = new_hashes.clone();
                self.last_paged = Some(doc);

                let total_ms = total_t0.elapsed().as_secs_f64() * 1000.0;
                Ok((
                    CompileResult {
                        kind: "pages",
                        fell_back_from_document,
                        warnings,
                        errors,
                        ignored,
                        diagnostics,
                        page_count,
                        page_hashes: new_hashes,
                        first_changed_page,
                        changed_pages,
                        deps,
                        span_map,
                        timings: CompileTimings {
                            vfs_sync_ms,
                            typst_compile_ms,
                            export_ms,
                            page_hash_ms,
                            total_ms,
                        },
                    },
                    pdf_bytes,
                ))
            }
            Err(err_list) => {
                let (_, e_msgs, _, e_diags) = self.collect_diagnostics(&[], &err_list);
                errors.extend(e_msgs);
                diagnostics.extend(e_diags);
                let total_ms = total_t0.elapsed().as_secs_f64() * 1000.0;
                Ok((
                    CompileResult {
                        kind: "pages",
                        fell_back_from_document,
                        warnings,
                        errors,
                        ignored,
                        diagnostics,
                        page_count: 0,
                        page_hashes: Vec::new(),
                        first_changed_page: None,
                        changed_pages: Vec::new(),
                        deps,
                        span_map: Vec::new(),
                        timings: CompileTimings {
                            vfs_sync_ms,
                            typst_compile_ms,
                            export_ms: 0.0,
                            page_hash_ms: 0.0,
                            total_ms,
                        },
                    },
                    Vec::new(),
                ))
            }
        }
    }

    fn compile_document(
        &mut self,
        vfs_sync_ms: f64,
        total_t0: Instant,
        fallback_to_pages_if_ignored: bool,
        tagged_pdf: bool,
        include_span_map: bool,
    ) -> Result<(CompileResult, Vec<u8>), String> {
        let compile_t0 = Instant::now();
        let html_world = self.world.as_html_world();
        let warned = typst::compile::<HtmlDocument>(&html_world);
        let typst_compile_ms = compile_t0.elapsed().as_secs_f64() * 1000.0;

        let (warnings, mut errors, ignored, mut diagnostics) =
            self.collect_diagnostics(&warned.warnings, &[]);

        if fallback_to_pages_if_ignored && (!ignored.is_empty() || warned.output.is_err()) {
            // Re-run on the same warm ServiceWorld & font/comemo cache to
            // produce PDF pages instead of emitting broken/incomplete HTML.
            return self.compile_pages(vfs_sync_ms, total_t0, tagged_pdf, include_span_map, true);
        }
        let deps = self.world.snapshot_disk_deps();

        match warned.output {
            Ok(doc) => {
                let export_t0 = Instant::now();
                let html_str = typst_html::html(&doc, &HtmlOptions::default()).map_err(|errs| {
                    errs.iter()
                        .map(|e| e.message.to_string())
                        .collect::<Vec<_>>()
                        .join("\n")
                })?;
                let export_ms = export_t0.elapsed().as_secs_f64() * 1000.0;
                let total_ms = total_t0.elapsed().as_secs_f64() * 1000.0;
                Ok((
                    CompileResult {
                        kind: "document",
                        fell_back_from_document: false,
                        warnings,
                        errors,
                        ignored,
                        diagnostics,
                        page_count: 0,
                        page_hashes: Vec::new(),
                        first_changed_page: None,
                        changed_pages: Vec::new(),
                        deps,
                        span_map: Vec::new(),
                        timings: CompileTimings {
                            vfs_sync_ms,
                            typst_compile_ms,
                            export_ms,
                            page_hash_ms: 0.0,
                            total_ms,
                        },
                    },
                    html_str.into_bytes(),
                ))
            }
            Err(err_list) => {
                let (_, e_msgs, _, e_diags) = self.collect_diagnostics(&[], &err_list);
                errors.extend(e_msgs);
                diagnostics.extend(e_diags);
                let total_ms = total_t0.elapsed().as_secs_f64() * 1000.0;
                Ok((
                    CompileResult {
                        kind: "document",
                        fell_back_from_document: false,
                        warnings,
                        errors,
                        ignored,
                        diagnostics,
                        page_count: 0,
                        page_hashes: Vec::new(),
                        first_changed_page: None,
                        changed_pages: Vec::new(),
                        deps,
                        span_map: Vec::new(),
                        timings: CompileTimings {
                            vfs_sync_ms,
                            typst_compile_ms,
                            export_ms: 0.0,
                            page_hash_ms: 0.0,
                            total_ms,
                        },
                    },
                    Vec::new(),
                ))
            }
        }
    }

    fn collect_diagnostics(
        &self,
        warnings: &[SourceDiagnostic],
        errors: &[SourceDiagnostic],
    ) -> (Vec<String>, Vec<String>, Vec<String>, Vec<DiagnosticInfo>) {
        let mut warn_msgs = Vec::new();
        let mut err_msgs = Vec::new();
        let mut ignored = Vec::new();
        let mut infos = Vec::new();

        for diag in warnings.iter().chain(errors.iter()) {
            let msg = diag.message.to_string();
            if diag.severity == Severity::Warning
                && msg.starts_with("html export is under active development")
            {
                continue;
            }
            if let Some(name) = msg.strip_suffix(" was ignored during HTML export") {
                ignored.push(name.to_owned());
            }

            let loc = self.world.resolve_diag_span_location(diag.span);
            let formatted = if let Some(ref l) = loc {
                format!("{}:{}:{}: {msg}", l.file, l.line, l.column)
            } else {
                msg.clone()
            };

            match diag.severity {
                Severity::Warning => warn_msgs.push(formatted),
                Severity::Error => err_msgs.push(formatted),
            }

            infos.push(DiagnosticInfo {
                severity: match diag.severity {
                    Severity::Warning => "warning",
                    Severity::Error => "error",
                },
                message: msg,
                file: loc.as_ref().map(|l| l.file.clone()),
                line: loc.as_ref().map(|l| l.line),
                column: loc.as_ref().map(|l| l.column),
                hints: diag.hints.iter().map(|h| h.v.to_string()).collect(),
            });
        }

        (warn_msgs, err_msgs, ignored, infos)
    }
}

#[cfg(target_os = "windows")]
fn current_rss_bytes() -> Option<u64> {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessMemoryCounters {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }
    let mut counters = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        PageFaultCount: 0,
        PeakWorkingSetSize: 0,
        WorkingSetSize: 0,
        QuotaPeakPagedPoolUsage: 0,
        QuotaPagedPoolUsage: 0,
        QuotaPeakNonPagedPoolUsage: 0,
        QuotaNonPagedPoolUsage: 0,
        PagefileUsage: 0,
        PeakPagefileUsage: 0,
    };
    let ok = unsafe {
        K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb)
    };
    (ok != 0).then_some(counters.WorkingSetSize as u64)
}

#[cfg(target_os = "linux")]
fn current_rss_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * 4096)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn current_rss_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mdraft_typst_service_{name}_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn large_20p_source(marker: &str) -> String {
        let mut s = String::from(
            "#set page(paper: \"a4\")\n#set text(size: 10.5pt)\n#show heading: set block(below: 0.6em)\n= MDraft Typst 20-Page Benchmark\n\n",
        );
        for i in 1..=20 {
            s.push_str(&format!("== Section {i}\n\n"));
            s.push_str("#lorem(120)\n\n");
            s.push_str(&format!(
                "#table(columns: 3, [Item], [Section], [Metric], [Alpha {i}], [{i}], [98.{i}%], [Beta {i}], [{i}], [99.{i}%])\n\n"
            ));
            s.push_str(&format!(
                "Inline math benchmark expression: $E_{i} = m c^2 + sum_(k=1)^({i}) k^2$.\n\n"
            ));
            if i < 20 {
                s.push_str("#pagebreak()\n\n");
            }
        }
        s.push_str(&format!("\nTail probe marker: `{marker}`.\n"));
        s
    }

    #[test]
    fn vfs_overlay_compiles_without_disk_writes_and_keeps_prefix_hashes_stable() {
        let root = temp_workspace("vfs_and_hashes");
        let mut engine = ServiceEngine::new(ServiceConfig {
            root: root.clone(),
            load_system_fonts: false,
            enable_local_packages: false,
            max_cache_age: 30,
            max_rss_mb: 0,
        });

        let src1 = large_20p_source("probe-one");
        let (r1, pdf1) = engine
            .compile(
                CompileParams {
                    main_path: "virtual-doc.typ".into(),
                    target: CompileTarget::Pages,
                    source_text: Some(src1),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(r1.errors.is_empty(), "errors: {:?}", r1.errors);
        assert!(pdf1.starts_with(b"%PDF-"));
        assert_eq!(r1.page_count, 20);
        assert_eq!(r1.page_hashes.len(), 20);
        // Zero temp files written on disk!
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);

        // Tail-only edit: only page 20 should change!
        let src2 = large_20p_source("probe-two-updated");
        let (r2, pdf2) = engine
            .compile(
                CompileParams {
                    main_path: "virtual-doc.typ".into(),
                    target: CompileTarget::Pages,
                    source_text: Some(src2),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(r2.errors.is_empty(), "errors: {:?}", r2.errors);
        assert!(pdf2.starts_with(b"%PDF-"));
        assert_eq!(r2.page_count, 20);
        assert_eq!(r2.first_changed_page, Some(20), "changed: {:?}", r2.changed_pages);
        assert_eq!(r2.changed_pages, vec![20]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn root_containment_blocks_escape_attempts() {
        let root = temp_workspace("root_escape");
        let outside = temp_workspace("root_outside");
        fs::write(outside.join("secret.typ"), "= Secret").unwrap();

        let mut engine = ServiceEngine::new(ServiceConfig {
            root: root.clone(),
            load_system_fonts: false,
            enable_local_packages: false,
            max_cache_age: 30,
            max_rss_mb: 0,
        });

        let escaped = engine.compile(
            CompileParams {
                main_path: "../root_outside/secret.typ".into(),
                target: CompileTarget::Pages,
                source_text: None,
                ..Default::default()
            },
            None,
        );
        assert!(escaped.is_err());

        // Also reject `#include "../..."` inside document source.
        let (inc_res, _) = engine
            .compile(
                CompileParams {
                    main_path: "main.typ".into(),
                    target: CompileTarget::Pages,
                    source_text: Some("#include \"../root_outside/secret.typ\"".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(!inc_res.errors.is_empty());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn document_html_and_warm_fallback_work_on_same_world() {
        let root = temp_workspace("html_fallback");
        let mut engine = ServiceEngine::new(ServiceConfig {
            root: root.clone(),
            load_system_fonts: false,
            enable_local_packages: false,
            max_cache_age: 30,
            max_rss_mb: 0,
        });

        let (html_res, html_bytes) = engine
            .compile(
                CompileParams {
                    main_path: "simple.typ".into(),
                    target: CompileTarget::Document,
                    source_text: Some("= Heading\n\nHello *Typst* HTML!".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(html_res.kind, "document");
        assert!(!html_res.fell_back_from_document);
        let html_text = String::from_utf8(html_bytes).unwrap();
        assert!(html_text.contains("Hello"));

        // Document that triggers an HTML-ignored construct (`#page` / `#place`)
        // seamlessly falls back to PDF pages on the warm World.
        let (fb_res, fb_bytes) = engine
            .compile(
                CompileParams {
                    main_path: "layout.typ".into(),
                    target: CompileTarget::Document,
                    source_text: Some("= Header\n\n#place(top + right)[Note]\nBody text.".into()),
                    fallback_to_pages_if_ignored: true,
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(fb_res.kind, "pages");
        assert!(fb_res.fell_back_from_document);
        assert!(fb_bytes.starts_with(b"%PDF-"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bidirectional_span_lookup_resolves_source_and_pdf_coords() {
        let root = temp_workspace("span_lookup");
        let mut engine = ServiceEngine::new(ServiceConfig {
            root: root.clone(),
            load_system_fonts: false,
            enable_local_packages: false,
            max_cache_age: 30,
            max_rss_mb: 0,
        });

        let src = "= Title\n\nFirst paragraph.\n\nSecond paragraph target.";
        let (res, _) = engine
            .compile(
                CompileParams {
                    main_path: "doc.typ".into(),
                    target: CompileTarget::Pages,
                    source_text: Some(src.into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(res.errors.is_empty());

        let (boxes, _, _) = engine.handle_request(
            Request {
                id: 1,
                call: RequestMethod::LocationToSpans(crate::protocol::LocationToSpansParams {
                    file: "doc.typ".into(),
                    line: 5,
                    column: 5,
                }),
            },
            None,
            false,
        );
        let spans = boxes.spans.unwrap();
        assert!(!spans.is_empty());
        let first = &spans[0];
        assert_eq!(first.page, 1);

        let (loc_resp, _, _) = engine.handle_request(
            Request {
                id: 2,
                call: RequestMethod::PointToLocation(crate::protocol::PointToLocationParams {
                    page: first.page,
                    x_pt: first.x_pt + first.width_pt * 0.5,
                    y_pt: first.y_pt + first.height_pt * 0.5,
                }),
            },
            None,
            false,
        );
        let resolved = loc_resp.source_location.unwrap();
        assert_eq!(resolved.file, "doc.typ");
        assert_eq!(resolved.line, 5);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn incremental_warm_edit_beats_cold_compile_on_large_20p() {
        let root = temp_workspace("bench_large_20p");
        let t_init = Instant::now();
        let mut engine = ServiceEngine::new(ServiceConfig {
            root: root.clone(),
            load_system_fonts: false,
            enable_local_packages: false,
            max_cache_age: 30,
            max_rss_mb: 0,
        });
        let init_ms = t_init.elapsed().as_secs_f64() * 1000.0;

        let (cold_res, _) = engine
            .compile(
                CompileParams {
                    main_path: "bench20.typ".into(),
                    target: CompileTarget::Pages,
                    source_text: Some(large_20p_source("cold")),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(cold_res.errors.is_empty());

        let mut warm_totals = Vec::new();
        for i in 0..5 {
            let (warm_res, _) = engine
                .compile(
                    CompileParams {
                        main_path: "bench20.typ".into(),
                        target: CompileTarget::Pages,
                        source_text: Some(large_20p_source(&format!("edit-{i}"))),
                        ..Default::default()
                    },
                    None,
                )
                .unwrap();
            assert!(warm_res.errors.is_empty());
            warm_totals.push(warm_res.timings.total_ms);
        }
        eprintln!(
            "20p embedded-fonts service init={:.1}ms cold={:.1}ms warm_samples={:?}",
            init_ms, cold_res.timings.total_ms, warm_totals
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn multi_file_include_populates_deps_and_compact_utf16_span_map() {
        let root = temp_workspace("multifile_span_map");
        let chapters = root.join("chapters");
        fs::create_dir_all(&chapters).unwrap();
        let chapter_src = "= Capítulo Um\n\nA partícula café oscila como pendulum aqui.\n";
        fs::write(chapters.join("ch1.typ"), chapter_src).unwrap();

        let mut engine = ServiceEngine::new(ServiceConfig {
            root: root.clone(),
            load_system_fonts: false,
            enable_local_packages: false,
            max_cache_age: 30,
            max_rss_mb: 512,
        });

        let main_src = "= Índice\n\n#include \"chapters/ch1.typ\"\n";
        let (res, pdf) = engine
            .compile(
                CompileParams {
                    main_path: "main.typ".into(),
                    target: CompileTarget::Pages,
                    source_text: Some(main_src.into()),
                    include_span_map: true,
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(res.errors.is_empty(), "errors: {:?}", res.errors);
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(
            res.deps.iter().any(|d| d.path.ends_with("ch1.typ") && d.size > 0),
            "expected disk dependency ch1.typ in {:?}",
            res.deps
        );
        let ch_spans: Vec<_> = res
            .span_map
            .iter()
            .filter(|s| s.file == "chapters/ch1.typ")
            .collect();
        assert!(
            ch_spans.iter().any(|s| s.line == 3 && s.utf16_end > s.utf16_start),
            "expected chapter line 3 in compact span_map: {ch_spans:?}"
        );
        let target_offset_utf16 = chapter_src.encode_utf16().count();
        assert!(
            ch_spans.iter().all(|s| s.utf16_end <= target_offset_utf16),
            "UTF-16 bounds stayed within chapter string length"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
