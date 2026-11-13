use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::layout::{Frame, FrameItem, Point, Size, Transform};
use typst::syntax::{DiagSpan, DiagSpanKind, FileId, RootedPath, Source, Span, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Feature, Features, Library, LibraryExt, World, WorldExt};
use typst_kit::datetime::Time;
use typst_kit::downloader::Downloader;
use typst_kit::files::{FileLoader, FileStore};
use typst_kit::fonts::FontStore;
use typst_kit::packages::{FsPackages, SystemPackages, UniversePackages};
use typst_layout::{Page, PagedDocument};
use typst_library::diag::{FileError, FileResult};

use crate::protocol::{CompactSpanAnchor, DependencyInfo, PdfBoxLocation, SourceLocation};
use crate::security::{
    canonicalize_root, normalize_vpath_key, validate_and_virtualize, verify_realized_within_root,
};

/// Package downloader that refuses network traffic so compilation never silently
/// reaches the network while still serving locally cached Typst packages.
struct OfflineDownloader;

impl Downloader for OfflineDownloader {
    fn stream(
        &self,
        _key: &dyn std::any::Any,
        url: &str,
    ) -> io::Result<(Option<usize>, Box<dyn io::Read>)> {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("offline service blocks automatic network download: {url}"),
        ))
    }
}

/// File loader checking an in-memory VFS overlay before reading from `--root`
/// with symlink-containment verification.
pub struct OverlayFileLoader {
    root: PathBuf,
    canon_root: PathBuf,
    overlay: RwLock<HashMap<String, Bytes>>,
    disk_deps: RwLock<HashSet<PathBuf>>,
    packages: Option<SystemPackages>,
}

impl OverlayFileLoader {
    pub fn new(root: PathBuf, enable_local_packages: bool) -> Self {
        let canon_root = canonicalize_root(&root);
        let packages = if enable_local_packages {
            Some(SystemPackages::from_parts(
                FsPackages::system_data(),
                FsPackages::system_cache(),
                UniversePackages::new(OfflineDownloader),
            ))
        } else {
            None
        };
        Self {
            root,
            canon_root,
            overlay: RwLock::new(HashMap::new()),
            disk_deps: RwLock::new(HashSet::new()),
            packages,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn set_root(&mut self, new_root: PathBuf) {
        self.canon_root = canonicalize_root(&new_root);
        self.root = new_root;
    }

    pub fn overlay_len(&self) -> usize {
        self.overlay.read().map(|g| g.len()).unwrap_or(0)
    }

    pub fn clear_overlay(&self) {
        if let Ok(mut guard) = self.overlay.write() {
            guard.clear();
        }
    }

    pub fn insert_overlay(&self, vpath_key: String, bytes: Bytes) {
        if let Ok(mut guard) = self.overlay.write() {
            guard.insert(normalize_vpath_key(&vpath_key), bytes);
        }
    }

    pub fn remove_overlay(&self, vpath_key: &str) {
        if let Ok(mut guard) = self.overlay.write() {
            guard.remove(&normalize_vpath_key(vpath_key));
        }
    }

    pub fn clear_disk_deps(&self) {
        if let Ok(mut guard) = self.disk_deps.write() {
            guard.clear();
        }
    }

    pub fn snapshot_disk_deps(&self) -> Vec<DependencyInfo> {
        let paths: Vec<PathBuf> = self
            .disk_deps
            .read()
            .map(|g| g.iter().cloned().collect())
            .unwrap_or_default();
        let mut deps: Vec<DependencyInfo> = paths
            .into_iter()
            .filter_map(|path| {
                let meta = fs::metadata(&path).ok()?;
                if !meta.is_file() {
                    return None;
                }
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
                    .unwrap_or(0);
                let raw = path.to_string_lossy();
                let cleaned = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned();
                Some(DependencyInfo {
                    path: cleaned,
                    mtime_ms,
                    size: meta.len(),
                })
            })
            .collect();
        deps.sort_by(|a, b| a.path.cmp(&b.path));
        deps.dedup_by(|a, b| a.path == b.path);
        deps
    }

    pub fn resolve_to_vpath(&self, raw_path: &str) -> Result<String, String> {
        validate_and_virtualize(&self.root, &self.canon_root, Path::new(raw_path))
    }
}

impl FileLoader for OverlayFileLoader {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        match id.root() {
            VirtualRoot::Project => {
                let key = normalize_vpath_key(id.vpath().get_without_slash());
                if let Ok(guard) = self.overlay.read()
                    && let Some(bytes) = guard.get(&key)
                {
                    return Ok(bytes.clone());
                }

                let realized = id.vpath().realize(&self.root)?;
                verify_realized_within_root(&realized, &self.canon_root).map_err(|msg| {
                    FileError::Other(Some(ecow::EcoString::from(msg)))
                })?;

                let map_err = |e| FileError::from_io(e, &realized);
                if fs::metadata(&realized).map_err(map_err)?.is_dir() {
                    Err(FileError::IsDirectory)
                } else {
                    if let Ok(mut deps) = self.disk_deps.write() {
                        deps.insert(realized.clone());
                    }
                    fs::read(&realized).map(Bytes::new).map_err(map_err)
                }
            }
            VirtualRoot::Package(spec) => {
                let Some(packages) = &self.packages else {
                    return Err(FileError::Other(Some(ecow::EcoString::from(
                        "local Typst package resolution is disabled",
                    ))));
                };
                let pkg_root = packages.obtain(spec)?;
                pkg_root.load(id.vpath())
            }
        }
    }
}

/// Persistent Typst compiler world shared across edits within a daemon process.
pub struct ServiceWorld {
    paged_library: LazyHash<Library>,
    html_library: LazyHash<Library>,
    fonts: FontStore,
    font_families_count: usize,
    files: FileStore<OverlayFileLoader>,
    time: Time,
    main_id: FileId,
}

impl ServiceWorld {
    pub fn new(root: PathBuf, load_system_fonts: bool, enable_local_packages: bool) -> Self {
        let mut fonts = FontStore::new();
        fonts.extend(typst_kit::fonts::embedded());
        if load_system_fonts {
            fonts.extend(typst_kit::fonts::system());
        }
        let font_families_count = fonts.book().families().count();

        let paged_library = LazyHash::new(Library::default());
        let html_features: Features = [Feature::Html].into_iter().collect();
        let html_library = LazyHash::new(Library::builder().with_features(html_features).build());

        let main_vpath = VirtualPath::new("main.typ").expect("literal main.typ is valid");
        let main_id = RootedPath::new(VirtualRoot::Project, main_vpath).intern();

        Self {
            paged_library,
            html_library,
            fonts,
            font_families_count,
            files: FileStore::new(OverlayFileLoader::new(root, enable_local_packages)),
            time: Time::system(),
            main_id,
        }
    }

    pub fn set_root(&mut self, new_root: PathBuf) {
        let cur = self.files.loader().root().to_path_buf();
        if cur != new_root {
            self.files.loader_mut().set_root(new_root);
            self.files.loader().clear_overlay();
            self.files.reset();
        }
    }

    pub fn set_main(&mut self, raw_path: &str) -> Result<String, String> {
        let vpath_key = self.files.loader().resolve_to_vpath(raw_path)?;
        let vpath = VirtualPath::new(&vpath_key).map_err(|e| format!("{e:?}"))?;
        self.main_id = RootedPath::new(VirtualRoot::Project, vpath).intern();
        Ok(vpath_key)
    }

    pub fn loader(&self) -> &OverlayFileLoader {
        self.files.loader()
    }

    pub fn reset_files(&mut self) {
        self.files.loader().clear_disk_deps();
        self.files.reset();
    }

    pub fn snapshot_disk_deps(&self) -> Vec<DependencyInfo> {
        self.files.loader().snapshot_disk_deps()
    }

    pub fn font_families_count(&self) -> usize {
        self.font_families_count
    }

    pub fn as_html_world(&self) -> HtmlTargetWorld<'_> {
        HtmlTargetWorld(self)
    }

    pub fn resolve_span_location(&self, span: Span) -> Option<SourceLocation> {
        self.resolve_diag_span_location(span.into())
    }

    pub fn resolve_diag_span_location(&self, diag_span: DiagSpan) -> Option<SourceLocation> {
        let (id, range) = match diag_span.get() {
            DiagSpanKind::Detached => return None,
            DiagSpanKind::Number { id, num, sub_range } => {
                let source = self.source(id).ok()?;
                let range = source.range(num, sub_range)?;
                (id, range)
            }
            DiagSpanKind::Range { id, range } => (id, range),
        };
        let source = self.source(id).ok()?;
        let (line, col) = source.lines().byte_to_line_column(range.start)?;
        let file = match id.root() {
            VirtualRoot::Project => id.vpath().get_without_slash().to_owned(),
            VirtualRoot::Package(spec) => {
                format!("{spec}/{}", id.vpath().get_without_slash())
            }
        };
        Some(SourceLocation {
            file,
            line: line + 1,
            column: col + 1,
            byte_offset: range.start,
        })
    }
}

impl World for ServiceWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.paged_library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.main_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.files.source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.time.today(offset)
    }
}

/// Thin `&World` view enabling `Feature::Html` while sharing fonts, files, and
/// `comemo` caches with [`ServiceWorld`].
pub struct HtmlTargetWorld<'a>(pub &'a ServiceWorld);

impl World for HtmlTargetWorld<'_> {
    fn library(&self) -> &LazyHash<Library> {
        &self.0.html_library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.0.book()
    }

    fn main(&self) -> FileId {
        self.0.main()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.0.source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.0.file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.0.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.0.today(offset)
    }
}

struct Sha256Hasher(Sha256);

impl Sha256Hasher {
    fn new() -> Self {
        Self(Sha256::new())
    }

    fn finish_hex(self) -> String {
        let digest = self.0.finalize();
        let mut out = String::with_capacity(64);
        for b in digest {
            let _ = write!(&mut out, "{b:02x}");
        }
        out
    }
}

impl Hasher for Sha256Hasher {
    fn finish(&self) -> u64 {
        0
    }

    fn write(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
}

/// Hash each laid-out [`Page`] deterministically with SHA-256 so untouched pages
/// across incremental compiles keep identical digests.
pub fn compute_page_hashes(doc: &PagedDocument) -> Vec<String> {
    doc.pages().iter().map(hash_page).collect()
}

fn hash_page(page: &Page) -> String {
    let mut h = Sha256Hasher::new();
    page.hash(&mut h);
    h.finish_hex()
}

/// Diff `prev` and `next` page hashes returning 1-based changed page indices and
/// the first changed page (`TypstPdfPreview.splice(pdf, firstPage)` anchor).
pub fn diff_page_hashes(prev: &[String], next: &[String]) -> (Option<usize>, Vec<usize>) {
    if prev.is_empty() {
        let all: Vec<usize> = (1..=next.len()).collect();
        return (if next.is_empty() { None } else { Some(1) }, all);
    }
    let mut changed = Vec::new();
    for (idx, hash) in next.iter().enumerate() {
        if prev.get(idx) != Some(hash) {
            changed.push(idx + 1);
        }
    }
    if prev.len() > next.len() && changed.is_empty() && !next.is_empty() {
        // Tail pages truncated: signal repaint from new final page.
        changed.push(next.len());
    }
    (changed.first().copied(), changed)
}

/// Forward lookup: map a source `(vpath, 1-based line, 1-based col)` to all
/// bounding boxes in the latest laid-out [`PagedDocument`].
pub fn location_to_spans(
    world: &ServiceWorld,
    doc: &PagedDocument,
    raw_file: &str,
    line: usize,
    column: usize,
) -> Result<Vec<PdfBoxLocation>, String> {
    let vpath_key = world.loader().resolve_to_vpath(raw_file)?;
    let vpath = VirtualPath::new(&vpath_key).map_err(|e| format!("{e:?}"))?;
    let target_id = RootedPath::new(VirtualRoot::Project, vpath).intern();
    let source = world
        .source(target_id)
        .map_err(|e| format!("source `{vpath_key}` unavailable: {e:?}"))?;
    let byte = source
        .lines()
        .line_column_to_byte(line.saturating_sub(1), column.saturating_sub(1))
        .ok_or_else(|| format!("line {line}:{column} out of range"))?;

    let mut exact = Vec::new();
    let mut nearest: Option<PdfBoxLocation> = None;

    for (page_idx, page) in doc.pages().iter().enumerate() {
        walk_frame_for_byte(
            world,
            &source,
            target_id,
            byte,
            page_idx + 1,
            &page.frame,
            Transform::identity(),
            &mut exact,
            &mut nearest,
        );
    }

    if !exact.is_empty() {
        return Ok(exact);
    }
    Ok(nearest.into_iter().collect())
}

#[allow(clippy::too_many_arguments)]
fn walk_frame_for_byte(
    world: &ServiceWorld,
    source: &Source,
    target_id: FileId,
    byte: usize,
    page: usize,
    frame: &Frame,
    tf: Transform,
    exact: &mut Vec<PdfBoxLocation>,
    nearest: &mut Option<PdfBoxLocation>,
) {
    for &(pos, ref item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let child_tf = tf
                    .pre_concat(Transform::translate(pos.x, pos.y))
                    .pre_concat(group.transform);
                walk_frame_for_byte(
                    world,
                    source,
                    target_id,
                    byte,
                    page,
                    &group.frame,
                    child_tf,
                    exact,
                    nearest,
                );
            }
            FrameItem::Text(text) => {
                let mut cursor_x = typst::layout::Abs::zero();
                for glyph in &text.glyphs {
                    let advance = glyph.x_advance.at(text.size);
                    let span = glyph.span.0;
                    if span.id() == Some(target_id)
                        && let Some(range) = world.range(span)
                    {
                        let gpos = (pos + Point::new(cursor_x, typst::layout::Abs::zero()))
                            .transform(tf);
                        let height = text.size.to_pt();
                        let width = advance.to_pt().max(1.0);
                        let dist = if byte >= range.start && byte <= range.end {
                            0
                        } else if byte < range.start {
                            range.start - byte
                        } else {
                            byte - range.end
                        };
                        let box_loc = PdfBoxLocation {
                            page,
                            x_pt: gpos.x.to_pt(),
                            y_pt: (gpos.y.to_pt() - height * 0.85).max(0.0),
                            width_pt: width,
                            height_pt: height.max(1.0),
                            distance: dist,
                        };
                        if dist == 0 {
                            exact.push(box_loc);
                        } else if nearest.as_ref().is_none_or(|b| dist < b.distance) {
                            *nearest = Some(box_loc);
                        }
                    }
                    cursor_x += advance;
                }
            }
            FrameItem::Shape(shape, span) => {
                record_sized_span(
                    world,
                    source,
                    target_id,
                    *span,
                    byte,
                    page,
                    pos.transform(tf),
                    shape.geometry.bbox(shape.stroke.as_ref()).size(),
                    exact,
                    nearest,
                );
            }
            FrameItem::Image(_, size, span) => {
                record_sized_span(
                    world,
                    source,
                    target_id,
                    *span,
                    byte,
                    page,
                    pos.transform(tf),
                    *size,
                    exact,
                    nearest,
                );
            }
            FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn record_sized_span(
    world: &ServiceWorld,
    _source: &Source,
    target_id: FileId,
    span: Span,
    byte: usize,
    page: usize,
    pos: Point,
    size: Size,
    exact: &mut Vec<PdfBoxLocation>,
    nearest: &mut Option<PdfBoxLocation>,
) {
    if span.id() != Some(target_id) {
        return;
    }
    let Some(range) = world.range(span) else {
        return;
    };
    let dist = if byte >= range.start && byte <= range.end {
        0
    } else if byte < range.start {
        range.start - byte
    } else {
        byte - range.end
    };
    let box_loc = PdfBoxLocation {
        page,
        x_pt: pos.x.to_pt(),
        y_pt: pos.y.to_pt(),
        width_pt: size.x.to_pt().max(1.0),
        height_pt: size.y.to_pt().max(1.0),
        distance: dist,
    };
    if dist == 0 {
        exact.push(box_loc);
    } else if nearest.as_ref().is_none_or(|b| dist < b.distance) {
        *nearest = Some(box_loc);
    }
}

/// Inverse lookup: map a clicked `(1-based page, x_pt, y_pt)` on the rendered
/// PDF page to the closest compiler AST `Span` source position.
pub fn point_to_location(
    world: &ServiceWorld,
    doc: &PagedDocument,
    page: usize,
    x_pt: f64,
    y_pt: f64,
) -> Option<SourceLocation> {
    let page_obj = doc.pages().get(page.checked_sub(1)?)?;
    let mut best: Option<(f64, Span)> = None;
    walk_frame_for_point(
        &page_obj.frame,
        Transform::identity(),
        x_pt,
        y_pt,
        &mut best,
    );
    let (_, span) = best?;
    world.resolve_span_location(span)
}

fn walk_frame_for_point(
    frame: &Frame,
    tf: Transform,
    target_x: f64,
    target_y: f64,
    best: &mut Option<(f64, Span)>,
) {
    for &(pos, ref item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let child_tf = tf
                    .pre_concat(Transform::translate(pos.x, pos.y))
                    .pre_concat(group.transform);
                walk_frame_for_point(&group.frame, child_tf, target_x, target_y, best);
            }
            FrameItem::Text(text) => {
                let mut cursor_x = typst::layout::Abs::zero();
                let ascent = text.size.to_pt() * 0.8;
                for glyph in &text.glyphs {
                    let advance = glyph.x_advance.at(text.size);
                    let gpos = (pos + Point::new(cursor_x, typst::layout::Abs::zero()))
                        .transform(tf);
                    let cx = gpos.x.to_pt() + advance.to_pt() * 0.5;
                    let cy = gpos.y.to_pt() - ascent * 0.5;
                    let d2 = (cx - target_x).powi(2) + (cy - target_y).powi(2);
                    let span = glyph.span.0;
                    if !span.is_detached() && best.is_none_or(|(b, _)| d2 < b) {
                        *best = Some((d2, span));
                    }
                    cursor_x += advance;
                }
            }
            FrameItem::Shape(shape, span) => {
                if !span.is_detached() {
                    let gpos = pos.transform(tf);
                    let sz = shape.geometry.bbox(shape.stroke.as_ref()).size();
                    let cx = gpos.x.to_pt() + sz.x.to_pt() * 0.5;
                    let cy = gpos.y.to_pt() + sz.y.to_pt() * 0.5;
                    let d2 = (cx - target_x).powi(2) + (cy - target_y).powi(2);
                    if best.is_none_or(|(b, _)| d2 < b) {
                        *best = Some((d2, *span));
                    }
                }
            }
            FrameItem::Image(_, size, span) => {
                if !span.is_detached() {
                    let gpos = pos.transform(tf);
                    let cx = gpos.x.to_pt() + size.x.to_pt() * 0.5;
                    let cy = gpos.y.to_pt() + size.y.to_pt() * 0.5;
                    let d2 = (cx - target_x).powi(2) + (cy - target_y).powi(2);
                    if best.is_none_or(|(b, _)| d2 < b) {
                        *best = Some((d2, *span));
                    }
                }
            }
            FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
        }
    }
}

struct SourceSpanCacheEntry {
    file: String,
    source: Source,
    is_ascii: bool,
    checkpoints: Vec<(usize, usize)>,
}

impl SourceSpanCacheEntry {
    fn from_source(id: FileId, source: Source) -> Option<Self> {
        let VirtualRoot::Project = id.root() else {
            return None;
        };
        let file = normalize_vpath_key(id.vpath().get_without_slash());
        let text = source.text();
        let is_ascii = text.is_ascii();
        let mut checkpoints = Vec::new();
        if !is_ascii {
            let mut utf16 = 0usize;
            for (idx, (byte_idx, ch)) in text.char_indices().enumerate() {
                if idx % 32 == 0 {
                    checkpoints.push((byte_idx, utf16));
                }
                utf16 += ch.len_utf16();
            }
            checkpoints.push((text.len(), utf16));
        }
        Some(Self {
            file,
            source,
            is_ascii,
            checkpoints,
        })
    }

    fn utf8_to_utf16(&self, byte_offset: usize) -> usize {
        let text = self.source.text();
        let target = byte_offset.min(text.len());
        if self.is_ascii {
            return target;
        }
        let pos = self.checkpoints.partition_point(|&(b, _)| b <= target);
        let (start_b, mut utf16) = pos
            .checked_sub(1)
            .and_then(|i| self.checkpoints.get(i).copied())
            .unwrap_or((0, 0));
        if let Some(slice) = text.get(start_b..target) {
            utf16 += slice.encode_utf16().count();
        } else {
            let safe = text[..target.min(text.len())]
                .char_indices()
                .map(|(i, _)| i)
                .next_back()
                .unwrap_or(0);
            utf16 = text[..safe].encode_utf16().count();
        }
        utf16
    }
}

/// Extract a compact table of compiler AST `Span` anchors across every active
/// project file (`#include`/`#import`) laid out in `doc`.
pub fn extract_span_map(world: &ServiceWorld, doc: &PagedDocument) -> Vec<CompactSpanAnchor> {
    let mut cache: HashMap<FileId, Option<SourceSpanCacheEntry>> = HashMap::new();
    let mut anchors = Vec::new();
    for (page_idx, page) in doc.pages().iter().enumerate() {
        walk_frame_span_map(
            world,
            page_idx + 1,
            &page.frame,
            Transform::identity(),
            &mut cache,
            &mut anchors,
        );
    }
    anchors
}

fn cache_source<'a>(
    world: &ServiceWorld,
    id: FileId,
    cache: &'a mut HashMap<FileId, Option<SourceSpanCacheEntry>>,
) -> Option<&'a SourceSpanCacheEntry> {
    cache
        .entry(id)
        .or_insert_with(|| {
            world
                .source(id)
                .ok()
                .and_then(|source| SourceSpanCacheEntry::from_source(id, source))
        })
        .as_ref()
}

fn walk_frame_span_map(
    world: &ServiceWorld,
    page: usize,
    frame: &Frame,
    tf: Transform,
    cache: &mut HashMap<FileId, Option<SourceSpanCacheEntry>>,
    anchors: &mut Vec<CompactSpanAnchor>,
) {
    for &(pos, ref item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let child_tf = tf
                    .pre_concat(Transform::translate(pos.x, pos.y))
                    .pre_concat(group.transform);
                walk_frame_span_map(world, page, &group.frame, child_tf, cache, anchors);
            }
            FrameItem::Text(text) => {
                let mut cursor_x = typst::layout::Abs::zero();
                let height = text.size.to_pt().max(1.0);
                for glyph in &text.glyphs {
                    let advance = glyph.x_advance.at(text.size);
                    let width = advance.to_pt().max(0.5);
                    let span = glyph.span.0;
                    if let Some(id) = span.id()
                        && let Some(range) = world.range(span)
                        && let Some(src) = cache_source(world, id, cache)
                    {
                        let gpos = (pos + Point::new(cursor_x, typst::layout::Abs::zero()))
                            .transform(tf);
                        let x_pt = gpos.x.to_pt();
                        let y_pt = (gpos.y.to_pt() - height * 0.85).max(0.0);

                        let byte_start = (range.start + glyph.span.1 as usize).min(range.end);
                        let byte_end = range.end;
                        let (line_0, col_0) = src
                            .source
                            .lines()
                            .byte_to_line_column(byte_start)
                            .unwrap_or((0, 0));
                        let line = line_0 + 1;
                        let column = col_0 + 1;
                        let utf16_start = src.utf8_to_utf16(byte_start);
                        let utf16_end = src.utf8_to_utf16(byte_end).max(utf16_start);

                        let can_merge = anchors.last().is_some_and(|prev: &CompactSpanAnchor| {
                            prev.page == page
                                && prev.file == src.file
                                && prev.line == line
                                && (prev.y_pt - y_pt).abs() <= height * 0.4
                                && x_pt >= prev.x_pt - 2.0
                                && x_pt - (prev.x_pt + prev.width_pt) <= height * 4.0
                        });

                        if let Some(prev) = anchors.last_mut().filter(|_| can_merge) {
                            let new_right = (x_pt + width).max(prev.x_pt + prev.width_pt);
                            prev.width_pt = new_right - prev.x_pt;
                            prev.height_pt = prev.height_pt.max(height);
                            prev.utf16_start = prev.utf16_start.min(utf16_start);
                            prev.utf16_end = prev.utf16_end.max(utf16_end);
                            prev.byte_offset = prev.byte_offset.min(byte_start);
                        } else {
                            anchors.push(CompactSpanAnchor {
                                file: src.file.clone(),
                                line,
                                column,
                                byte_offset: byte_start,
                                utf16_start,
                                utf16_end,
                                page,
                                x_pt,
                                y_pt,
                                width_pt: width,
                                height_pt: height,
                            });
                        }
                    }
                    cursor_x += advance;
                }
            }
            FrameItem::Shape(shape, span) => {
                if let Some(id) = span.id()
                    && let Some(range) = world.range(*span)
                    && let Some(src) = cache_source(world, id, cache)
                    && let Some((line_0, col_0)) = src.source.lines().byte_to_line_column(range.start)
                {
                    let gpos = pos.transform(tf);
                    let sz = shape.geometry.bbox(shape.stroke.as_ref()).size();
                    let w = sz.x.to_pt().max(1.0);
                    let h = sz.y.to_pt().max(1.0);
                    if w >= 2.0 && h >= 2.0 {
                        anchors.push(CompactSpanAnchor {
                            file: src.file.clone(),
                            line: line_0 + 1,
                            column: col_0 + 1,
                            byte_offset: range.start,
                            utf16_start: src.utf8_to_utf16(range.start),
                            utf16_end: src.utf8_to_utf16(range.end),
                            page,
                            x_pt: gpos.x.to_pt(),
                            y_pt: gpos.y.to_pt(),
                            width_pt: w,
                            height_pt: h,
                        });
                    }
                }
            }
            FrameItem::Image(_, size, span) => {
                if let Some(id) = span.id()
                    && let Some(range) = world.range(*span)
                    && let Some(src) = cache_source(world, id, cache)
                    && let Some((line_0, col_0)) = src.source.lines().byte_to_line_column(range.start)
                {
                    let gpos = pos.transform(tf);
                    anchors.push(CompactSpanAnchor {
                        file: src.file.clone(),
                        line: line_0 + 1,
                        column: col_0 + 1,
                        byte_offset: range.start,
                        utf16_start: src.utf8_to_utf16(range.start),
                        utf16_end: src.utf8_to_utf16(range.end),
                        page,
                        x_pt: gpos.x.to_pt(),
                        y_pt: gpos.y.to_pt(),
                        width_pt: size.x.to_pt().max(1.0),
                        height_pt: size.y.to_pt().max(1.0),
                    });
                }
            }
            FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
        }
    }
}
