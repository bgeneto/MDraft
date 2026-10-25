//! Native printing and direct PDF output through the platform webview.
//!
//! The article is written to a temporary file and loaded by a dedicated,
//! hidden webview. The file carries no application scripts, and the window has
//! no capability entry, so document markup cannot reach a Tauri command. The
//! host injects the readiness check after navigation and owns every platform
//! call:
//!
//! - Windows: WebView2 `PrintToPdf` (`ICoreWebView2_7`) and `ShowPrintUI`
//!   (`ICoreWebView2_16`).
//! - Linux: WebKitGTK `PrintOperation`, either its native dialog or a PDF
//!   written through GTK print settings.
//!
//! The browser handoff stays in `export.rs` as the fallback for hosts that do
//! not implement either API.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Label of the hidden print surface. It is deliberately absent from every
/// capability file, which is what keeps its IPC bridge unprivileged.
pub const PRINT_WINDOW: &str = "print";

/// How long the hidden surface may take to load and decode its resources.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a direct PDF write may take. Large documents are slower than a
/// print dialog, but a hung WebView2 must not leave a command pending forever.
const PDF_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOutcome {
    /// The file written for a direct PDF; `None` for a print dialog.
    pub path: Option<String>,
    pub bytes: Option<u64>,
    /// `written`, `dialog` or `cancelled`.
    pub status: String,
    /// Image URLs that did not load before the deadline.
    pub failed_resources: Vec<String>,
}

/// The readiness script, injected by the host after navigation.
///
/// It never returns a promise: Wry's callback API does not await one. Instead
/// it marks the document element, which the host polls with a small synchronous
/// expression. The title is left alone so the PDF keeps its document title.
const READY_SCRIPT: &str = r#"(function () {
  var root = document.documentElement;
  function mark(failed) {
    root.setAttribute('data-mdraft-print-ready', '1');
    root.setAttribute('data-mdraft-print-failed', JSON.stringify(failed || []));
  }
  function start() {
    var images = Array.prototype.slice.call(document.images);
    images.forEach(function (image) {
      image.loading = 'eager';
      image.decoding = 'sync';
    });
    var waits = images.map(function (image) {
      if (image.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    });
    var fonts = document.fonts && document.fonts.ready
      ? document.fonts.ready
      : Promise.resolve();
    var cap = new Promise(function (resolve) { setTimeout(resolve, 10000); });
    Promise.race([Promise.all(waits.concat([fonts])), cap]).then(function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          mark(images.filter(function (image) {
            return !image.complete || image.naturalWidth === 0;
          }).map(function (image) {
            return image.getAttribute('src') || image.src;
          }));
        });
      });
    });
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();"#;

/// A path component safe on every platform, without assuming an extension.
fn safe_stem(name: &str) -> String {
    let stem = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = stem.trim();
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() || !trimmed.chars().any(|c| c.is_alphanumeric()) {
        "document".into()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn unique_directory() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir()
        .join("mdraft-native-print")
        .join(format!("{}-{stamp}", std::process::id()))
}

/// Write the print article and return its directory and file.
fn write_print_file(html: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    let directory = unique_directory();
    std::fs::create_dir_all(&directory)
        .map_err(|e| format!("Could not create {}: {e}", directory.display()))?;
    let file = directory.join(format!("{}.html", safe_stem(name)));
    std::fs::write(&file, html.as_bytes())
        .map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    Ok((directory, file))
}

fn remove_directory(directory: &Path) {
    let _ = std::fs::remove_dir_all(directory);
}

/// Evaluate JavaScript and return the JSON value it produced.
///
/// `eval_with_callback` is used instead of `eval` because the readiness state
/// must be observed, not assumed. A timeout turns a wedged webview into an
/// actionable error rather than a command that never settles.
fn evaluate<R: Runtime>(window: &WebviewWindow<R>, script: &str) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    window
        .eval_with_callback(script, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Could not run the print readiness check: {e}"))?;
    let raw = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "The print surface did not answer the readiness check.".to_string())?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("The print surface returned an unreadable readiness answer: {e}"))
}

/// Wait until the temporary document has loaded, then inject readiness and
/// wait for its fonts and images.
fn wait_until_ready<R: Runtime>(window: &WebviewWindow<R>) -> Result<Vec<String>, String> {
    let started = Instant::now();
    loop {
        if started.elapsed() > READY_TIMEOUT {
            return Err(
                "The print surface did not finish loading the document. Try the browser print \
                 route instead."
                    .into(),
            );
        }
        let loaded = evaluate(
            window,
            "!!document.querySelector('meta[name=\"mdraft-print\"]') && document.readyState === 'complete'",
        )?
        .as_bool()
        .unwrap_or(false);
        if loaded {
            break;
        }
        std::thread::sleep(Duration::from_millis(75));
    }

    window
        .eval(READY_SCRIPT)
        .map_err(|e| format!("Could not start the print readiness check: {e}"))?;

    let started = Instant::now();
    loop {
        if started.elapsed() > READY_TIMEOUT {
            // Proceeding is better than printing a blank page: the script caps
            // itself at ten seconds, so reaching this point means the webview
            // stopped answering, which is a real failure.
            return Err(
                "The print surface stopped responding while waiting for its fonts and images."
                    .into(),
            );
        }
        let ready = evaluate(
            window,
            "document.documentElement.getAttribute('data-mdraft-print-ready') === '1'",
        )?
        .as_bool()
        .unwrap_or(false);
        if ready {
            let failed = evaluate(
                window,
                "document.documentElement.getAttribute('data-mdraft-print-failed') || '[]'",
            )?;
            return Ok(failed
                .as_str()
                .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                .unwrap_or_default());
        }
        std::thread::sleep(Duration::from_millis(75));
    }
}

/// Create the hidden surface. It starts on `about:blank`; the caller navigates
/// it to the prepared file so relative images have a real file base.
fn create_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(previous) = app.get_webview_window(PRINT_WINDOW) {
        let _ = previous.destroy();
    }
    WebviewWindowBuilder::new(
        app,
        PRINT_WINDOW,
        WebviewUrl::External(Url::parse("about:blank").expect("about:blank is a valid URL")),
    )
    .title("Print")
    .inner_size(794.0, 1123.0)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .decorations(false)
    .resizable(false)
    .build()
    .map_err(|e| format!("Could not create the print surface: {e}"))
}

/// Load the article and wait for it, cleaning up on every failed path.
fn prepare<R: Runtime>(
    app: &AppHandle<R>,
    html: &str,
    name: &str,
) -> Result<(WebviewWindow<R>, PathBuf, Vec<String>), String> {
    let (directory, file) = write_print_file(html, name)?;
    let window = match create_window(app) {
        Ok(window) => window,
        Err(error) => {
            remove_directory(&directory);
            return Err(error);
        }
    };
    let url = Url::from_file_path(&file)
        .map_err(|_| format!("Could not turn {} into a file URL.", file.display()));
    let result = match url {
        Ok(url) => window
            .navigate(url)
            .map_err(|e| format!("Could not load the print surface: {e}"))
            .and_then(|()| wait_until_ready(&window)),
        Err(error) => Err(error),
    };
    match result {
        Ok(failed) => Ok((window, directory, failed)),
        Err(error) => {
            let _ = window.destroy();
            remove_directory(&directory);
            Err(error)
        }
    }
}

fn close_surface<R: Runtime>(window: WebviewWindow<R>, directory: &Path) {
    let _ = window.destroy();
    remove_directory(directory);
}

/// Remove a file the platform or the PDF writer left behind on failure.
fn discard_partial(target: &Path) {
    if let Ok(metadata) = std::fs::metadata(target)
        && metadata.is_file()
    {
        let _ = std::fs::remove_file(target);
    }
}

fn verify_pdf(target: &Path) -> Result<u64, String> {
    let bytes = std::fs::metadata(target)
        .map_err(|e| format!("The PDF writer did not create {}: {e}", target.display()))?
        .len();
    if bytes < 5 {
        return Err(format!(
            "The PDF writer reported success but {} is empty.",
            target.display()
        ));
    }
    let mut head = [0u8; 5];
    use std::io::Read;
    std::fs::File::open(target)
        .and_then(|mut file| file.read_exact(&mut head))
        .map_err(|e| format!("Could not read {} back: {e}", target.display()))?;
    if &head != b"%PDF-" {
        return Err(format!(
            "The PDF writer wrote {} but it is not a PDF file.",
            target.display()
        ));
    }
    Ok(bytes)
}

/// Write a PDF through the platform webview.
pub fn print_pdf<R: Runtime>(
    app: &AppHandle<R>,
    html: &str,
    name: &str,
    target: &Path,
) -> Result<PrintOutcome, String> {
    let (window, directory, failed_resources) = prepare(app, html, name)?;
    let result = platform::print_to_pdf(&window, target);
    close_surface(window, &directory);
    match result {
        Ok(()) => {
            let bytes = verify_pdf(target).inspect_err(|_| discard_partial(target))?;
            Ok(PrintOutcome {
                path: Some(target.to_string_lossy().into_owned()),
                bytes: Some(bytes),
                status: "written".into(),
                failed_resources,
            })
        }
        Err(error) => {
            discard_partial(target);
            Err(error)
        }
    }
}

/// Open the platform print dialog for the prepared article.
pub fn print_dialog<R: Runtime>(
    app: &AppHandle<R>,
    html: &str,
    name: &str,
) -> Result<PrintOutcome, String> {
    let (window, directory, failed_resources) = prepare(app, html, name)?;
    match platform::show_dialog(&window) {
        Ok(printed) => {
            close_surface(window, &directory);
            Ok(PrintOutcome {
                path: None,
                bytes: None,
                status: if printed { "dialog" } else { "cancelled" }.into(),
                failed_resources,
            })
        }
        Err(error) => {
            close_surface(window, &directory);
            Err(error)
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM, ICoreWebView2_16, ICoreWebView2_7,
        ICoreWebView2Environment, ICoreWebView2Environment6,
    };
    use webview2_com::{Microsoft::Web::WebView2::Win32::ICoreWebView2PrintSettings, PrintToPdfCompletedHandler};
    use windows_core::{HSTRING, Interface};

    /// A4 in inches. WebView2's print settings use inches, not points.
    const A4_WIDTH: f64 = 8.27;
    const A4_HEIGHT: f64 = 11.69;

    fn settings(environment: &ICoreWebView2Environment) -> Result<ICoreWebView2PrintSettings, String> {
        let environment6 = environment
            .cast::<ICoreWebView2Environment6>()
            .map_err(|e| format!("This WebView2 runtime has no print settings (ICoreWebView2Environment6): {e}"))?;
        let settings = unsafe {
            environment6
                .CreatePrintSettings()
                .map_err(|e| format!("Could not create WebView2 print settings: {e}"))?
        };
        unsafe {
            settings
                .SetPageWidth(A4_WIDTH)
                .map_err(|e| format!("Could not set the PDF page width: {e}"))?;
            settings
                .SetPageHeight(A4_HEIGHT)
                .map_err(|e| format!("Could not set the PDF page height: {e}"))?;
            settings
                .SetMarginTop(0.0)
                .and_then(|()| settings.SetMarginBottom(0.0))
                .and_then(|()| settings.SetMarginLeft(0.0))
                .and_then(|()| settings.SetMarginRight(0.0))
                .map_err(|e| format!("Could not set the PDF margins: {e}"))?;
            settings
                .SetShouldPrintBackgrounds(true)
                .map_err(|e| format!("Could not enable printed backgrounds: {e}"))?;
            settings
                .SetShouldPrintHeaderAndFooter(false)
                .map_err(|e| format!("Could not disable the browser header and footer: {e}"))?;
            settings
                .SetScaleFactor(1.0)
                .map_err(|e| format!("Could not set the PDF scale: {e}"))?;
        }
        Ok(settings)
    }

    pub fn print_to_pdf<R: Runtime>(
        window: &WebviewWindow<R>,
        target: &Path,
    ) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        let path = target.to_path_buf();
        window
            .with_webview(move |webview| {
                let result = (|| -> Result<(), String> {
                    let controller = webview.controller();
                    let core = unsafe {
                        controller
                            .CoreWebView2()
                            .map_err(|e| format!("Could not reach the print webview: {e}"))?
                    };
                    let core7 = core
                        .cast::<ICoreWebView2_7>()
                        .map_err(|e| format!("This WebView2 runtime cannot write PDFs (ICoreWebView2_7): {e}"))?;
                    let print_settings = settings(&webview.environment())?;
                    let wide_path = HSTRING::from(path.to_string_lossy().as_ref());
                    let handler_tx = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |code, succeeded| {
                        let message = if code.is_ok() && succeeded {
                            Ok(())
                        } else {
                            Err(format!(
                                "WebView2 could not write the PDF (HRESULT {:?}, success {})",
                                code, succeeded
                            ))
                        };
                        let _ = handler_tx.send(message);
                        Ok(())
                    }));
                    unsafe {
                        core7
                            .PrintToPdf(&wide_path, &print_settings, &handler)
                            .map_err(|e| format!("Could not start the PDF writer: {e}"))?;
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = tx.send(Err(error));
                }
            })
            .map_err(|e| format!("Could not reach the print webview: {e}"))?;

        rx.recv_timeout(PDF_TIMEOUT)
            .map_err(|_| "The PDF writer did not finish within three minutes.".to_string())?
    }

    pub fn show_dialog<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |webview| {
                let result = (|| -> Result<(), String> {
                    let controller = webview.controller();
                    let core = unsafe {
                        controller
                            .CoreWebView2()
                            .map_err(|e| format!("Could not reach the print webview: {e}"))?
                    };
                    let core16 = core
                        .cast::<ICoreWebView2_16>()
                        .map_err(|e| format!("This WebView2 runtime has no print dialog (ICoreWebView2_16): {e}"))?;
                    unsafe {
                        core16
                            .ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)
                            .map_err(|e| format!("Could not open the system print dialog: {e}"))?;
                    }
                    Ok(())
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| format!("Could not reach the print webview: {e}"))?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "The system print dialog did not answer.".to_string())??;
        // In this runtime ShowPrintUI runs the system dialog modally and returns
        // when it closes; the print surface can be destroyed immediately. It
        // cannot tell us whether the reader printed or cancelled, so report a
        // completed dialog rather than inventing an outcome.
        Ok(true)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_void, CStr};
    use webkit2gtk::PrintOperationExt;

    /// GTK's print-to-file backend exists under a translated name, so a
    /// hard-coded "Print to File" would fail on a Portuguese desktop. GTK's
    /// printer type is not bound by gtk-rs; these three C calls are the whole
    /// surface needed to find the virtual PDF printer by its properties.
    type GtkPrinter = c_void;
    type GtkPrinterFunc =
        unsafe extern "C" fn(printer: *mut GtkPrinter, data: *mut c_void) -> glib::ffi::gboolean;

    unsafe extern "C" {
        fn gtk_enumerate_printers(
            func: GtkPrinterFunc,
            data: *mut c_void,
            destroy: Option<unsafe extern "C" fn(*mut c_void)>,
            wait: glib::ffi::gboolean,
        );
        fn gtk_printer_get_name(printer: *mut GtkPrinter) -> *const c_char;
        fn gtk_printer_is_virtual(printer: *mut GtkPrinter) -> glib::ffi::gboolean;
        fn gtk_printer_accepts_pdf(printer: *mut GtkPrinter) -> glib::ffi::gboolean;
    }

    unsafe extern "C" fn collect_pdf_printers(
        printer: *mut GtkPrinter,
        data: *mut c_void,
    ) -> glib::ffi::gboolean {
        // The callback runs synchronously inside gtk_enumerate_printers, so the
        // Vec outlives every call and no allocation ownership crosses threads.
        let names = unsafe { &mut *(data as *mut Vec<String>) };
        if unsafe { gtk_printer_is_virtual(printer) } != 0
            && unsafe { gtk_printer_accepts_pdf(printer) } != 0
        {
            let name = unsafe { gtk_printer_get_name(printer) };
            if !name.is_null()
                && let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str()
            {
                names.push(name.to_string());
            }
        }
        glib::ffi::GTRUE
    }

    fn virtual_pdf_printer() -> Option<String> {
        let mut names = Vec::new();
        unsafe {
            gtk_enumerate_printers(
                collect_pdf_printers,
                (&mut names as *mut Vec<String>).cast(),
                None,
                glib::ffi::GTRUE,
            );
        }
        names.into_iter().next()
    }

    /// GTK print settings use a `file://` URI and a format name, not a path.
    fn file_uri(path: &Path) -> Result<String, String> {
        Url::from_file_path(path)
            .map(|url| url.to_string())
            .map_err(|_| format!("Could not turn {} into a file URL.", path.display()))
    }

    pub fn print_to_pdf<R: Runtime>(
        window: &WebviewWindow<R>,
        target: &Path,
    ) -> Result<(), String> {
        let uri = file_uri(target)?;
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |webview| {
                let outcome = print_view_to_pdf(&webview.inner(), &uri);
                let _ = tx.send(outcome);
            })
            .map_err(|e| format!("Could not reach the print webview: {e}"))?;
        rx.recv_timeout(PDF_TIMEOUT)
            .map_err(|_| "The PDF writer did not finish within three minutes.".to_string())?
    }

    /// A4 with the article's print margins. WebKitGTK uses the page setup
    /// margins in both the silent and dialog paths; the CSS `@page` rule alone
    /// is ignored there.
    fn a4_page_setup() -> gtk::PageSetup {
        let paper = gtk::PaperSize::new(Some("iso_a4"));
        let page_setup = gtk::PageSetup::new();
        page_setup.set_paper_size(&paper);
        page_setup.set_top_margin(18.0, gtk::Unit::Mm);
        page_setup.set_bottom_margin(18.0, gtk::Unit::Mm);
        page_setup.set_left_margin(16.0, gtk::Unit::Mm);
        page_setup.set_right_margin(16.0, gtk::Unit::Mm);
        page_setup
    }

    /// The part that only needs a `WebKitWebView`, so a display-owned test can
    /// exercise the same print settings without creating a Tauri window.
    pub(super) fn print_view_to_pdf(
        view: &webkit2gtk::WebView,
        uri: &str,
    ) -> Result<(), String> {
        let operation = webkit2gtk::PrintOperation::new(view);
        let settings = gtk::PrintSettings::new();
        // WebKitGTK's silent print path still resolves a GtkPrinter first; the
        // file backend's virtual printer is what turns the output URI into a
        // file instead of asking CUPS for a device. Its name is translated, so
        // find it by the properties GTK promises rather than by its English
        // label.
        match virtual_pdf_printer() {
            Some(printer) => settings.set_printer(&printer),
            None => settings.set_printer("Print to File"),
        }
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(uri));
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
        settings.set_paper_size(&gtk::PaperSize::new(Some("iso_a4")));
        let page_setup = a4_page_setup();
        operation.set_print_settings(&settings);
        operation.set_page_setup(&page_setup);

        let done = std::rc::Rc::new(std::cell::Cell::new(false));
        let failure = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
        operation.connect_finished({
            let done = done.clone();
            move |_| done.set(true)
        });
        operation.connect_failed({
            let done = done.clone();
            let failure = failure.clone();
            move |_, error| {
                *failure.borrow_mut() = Some(error.to_string());
                done.set(true);
            }
        });
        operation.print();
        // The print operation completes through the GTK main loop. Pump it
        // here, on the thread that owns the GTK objects, so the signal is
        // delivered instead of blocking the only thread that could deliver it.
        while !done.get() {
            gtk::main_iteration_do(true);
        }
        match failure.borrow().as_ref() {
            Some(error) => Err(format!("The PDF writer failed: {error}")),
            None => Ok(()),
        }
    }

    pub fn show_dialog<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |webview| {
                let view = webview.inner();
                let operation = webkit2gtk::PrintOperation::new(&view);
                operation.set_page_setup(&a4_page_setup());
                let response = operation.run_dialog(None::<&gtk::Window>);
                let _ = tx.send(matches!(
                    response,
                    webkit2gtk::PrintOperationResponse::Print
                ));
            })
            .map_err(|e| format!("Could not reach the print webview: {e}"))?;
        rx.recv_timeout(Duration::from_secs(30 * 60))
            .map_err(|_| "The print dialog did not close.".to_string())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::*;

    pub fn print_to_pdf<R: Runtime>(
        _window: &WebviewWindow<R>,
        _target: &Path,
    ) -> Result<(), String> {
        Err("Native PDF writing is not implemented on this platform.".into())
    }

    pub fn show_dialog<R: Runtime>(_window: &WebviewWindow<R>) -> Result<bool, String> {
        Err("Native printing is not implemented on this platform.".into())
    }
}

/// Prepare a native print dialog from the article HTML.
#[tauri::command]
pub async fn print_native<R: Runtime>(
    app: AppHandle<R>,
    html: String,
    name: String,
) -> Result<PrintOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || print_dialog(&app, &html, &name))
        .await
        .map_err(|e| format!("The print task could not be started: {e}"))?
}

/// Write a PDF directly from the article HTML.
#[tauri::command]
pub async fn print_native_pdf<R: Runtime>(
    app: AppHandle<R>,
    html: String,
    name: String,
    target: String,
) -> Result<PrintOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || print_pdf(&app, &html, &name, Path::new(&target)))
        .await
        .map_err(|e| format!("The PDF task could not be started: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hostile_document_name_becomes_a_safe_stem() {
        assert_eq!(safe_stem("../../a:b*.md"), "a-b-.md");
        assert_eq!(safe_stem("notes.md"), "notes.md");
        assert_eq!(safe_stem("///"), "document");
        assert_eq!(safe_stem(""), "document");
    }

    #[test]
    fn a_long_name_is_shortened() {
        let stem = safe_stem(&"a".repeat(200));
        assert_eq!(stem.chars().count(), 60);
    }

    #[test]
    fn a_unique_scratch_directory_is_below_the_system_temp() {
        let first = unique_directory();
        let second = unique_directory();
        assert!(first.starts_with(std::env::temp_dir()));
        assert_ne!(first, second);
    }

    #[test]
    fn a_written_article_has_its_own_directory() {
        let (directory, file) = write_print_file("<html></html>", "notes.md").unwrap();
        assert!(file.starts_with(&directory));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "<html></html>");
        remove_directory(&directory);
    }

    #[test]
    fn a_missing_pdf_is_rejected() {
        let path = std::env::temp_dir().join("mdraft-does-not-exist.pdf");
        let _ = std::fs::remove_file(&path);
        assert!(verify_pdf(&path).is_err());
    }

    #[test]
    fn a_non_pdf_file_is_rejected_and_removed() {
        let path = std::env::temp_dir().join(format!(
            "mdraft-not-a-pdf-{}.pdf",
            std::process::id()
        ));
        std::fs::write(&path, b"not a pdf at all").unwrap();
        assert!(verify_pdf(&path).is_err());
        discard_partial(&path);
        assert!(!path.exists());
    }

    #[test]
    fn no_capability_names_the_print_window() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let entries = std::fs::read_dir(&directory).expect("the capabilities directory exists");
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let text = std::fs::read_to_string(entry.path()).expect("a capability file is readable");
            let capability: serde_json::Value =
                serde_json::from_str(&text).expect("a capability file is valid JSON");
            for key in ["windows", "webviews"] {
                if let Some(names) = capability.get(key).and_then(|value| value.as_array()) {
                    assert!(
                        !names.iter().any(|name| name.as_str() == Some(PRINT_WINDOW)),
                        "{} grants permissions to the print window",
                        entry.path().display()
                    );
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a GTK display; run under WSLg or a desktop session"]
    fn webkitgtk_writes_a_pdf_with_the_same_settings() {
        use webkit2gtk::{LoadEvent, WebViewExt};

        if gtk::init().is_err() {
            eprintln!("skipping: no GTK display");
            return;
        }
        let view = webkit2gtk::WebView::new();
        let loaded = std::rc::Rc::new(std::cell::Cell::new(false));
        view.connect_load_changed({
            let loaded = loaded.clone();
            move |_, event| {
                if event == LoadEvent::Finished {
                    loaded.set(true);
                }
            }
        });
        let html = std::env::var("MDRAFT_PRINT_HTML")
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_else(|| {
                "<!doctype html><html><body><h1>Linux print</h1>\
                 <p>This paragraph is printed by the same WebKitGTK settings the \
                 application uses.</p></body></html>"
                    .to_string()
            });
        view.load_html(&html, Some("file:///tmp/"));
        let started = Instant::now();
        while !loaded.get() && started.elapsed() < Duration::from_secs(15) {
            gtk::main_iteration_do(true);
        }
        assert!(loaded.get(), "WebKitGTK did not finish loading the test page");

        let target = std::env::var("MDRAFT_PRINT_PDF")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("mdraft-linux-print-test.pdf"));
        let _ = std::fs::remove_file(&target);
        let uri = Url::from_file_path(&target)
            .expect("the temporary PDF path must be a file URL")
            .to_string();
        platform::print_view_to_pdf(&view, &uri).expect("WebKitGTK did not write the PDF");
        let bytes = verify_pdf(&target).expect("the WebKitGTK PDF is not valid");
        assert!(bytes > 1000, "the WebKitGTK PDF is suspiciously small: {bytes}");
        println!("wrote {}", target.display());
        // WebKitGTK aborts while tearing down its web process after a GTK print
        // job, even though the PDF is complete. This test is ignored and meant
        // for a manual display-owned run; exit before that teardown so the
        // command reports the result it actually produced.
        std::process::exit(0);
    }
}
