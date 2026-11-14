//! MDraft — a Tauri 2 markdown editor.

mod ai;
mod cancel_registry;
mod clipboard;
mod documents;
mod export;
mod fonts;
mod html_preview;
mod images;
mod latex;
mod latex_native;
mod latex_texmf;
mod latex_texpresso;
mod launch;
#[cfg(target_os = "linux")]
mod linux_webkit_env;
mod menu;
mod print;
mod recovery;
mod settings;
mod speech;
mod spellcheck;
mod tex_fmt;
mod text_encoding;
mod tokens;
mod typst;
mod workspace;

use settings::{AppState, Settings};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything creates a GTK application: WebKitGTK reads its rendering
    // switches while it initialises. See `linux_webkit_env` for the NVIDIA
    // Wayland failure this prevents.
    #[cfg(target_os = "linux")]
    linux_webkit_env::apply_before_gtk_init();

    let mut context = tauri::generate_context!();
    let hidden_test = std::env::var_os("MDRAFT_TEST_HIDDEN").is_some();
    // Automated UI runs must not interrupt the user's active desktop.
    if hidden_test {
        // The test runner checks this embedded marker before starting a binary
        // with --no-build, so an older executable cannot unexpectedly appear.
        eprintln!("MDRAFT_TEST_HIDDEN_ISOLATED_WINDOW_V2");
        if let Ok(identifier) = std::env::var("MDRAFT_TEST_IDENTIFIER")
            && identifier == "io.github.bgeneto.mdraft.test-automation"
        {
            context.config_mut().identifier = identifier;
        }
        for window in &mut context.config_mut().app.windows {
            window.visible = false;
            window.focus = false;
        }
    }

    // Wayland has no window-icon property for GTK3 applications: the
    // compositor resolves the icon by matching the window's app id to a
    // `.desktop` file. GTK derives that id from g_get_prgname(), and the lookup
    // is case-sensitive. The Linux config sets `productName` to `mdraft`, which
    // is at once the installed entry's basename (`mdraft.desktop`), its
    // `StartupWMClass` and this GLib program name — one value, three places.
    // Keep the call even while they agree: it is what makes a future rename
    // fail loudly here instead of silently losing the icon, as it did when the
    // product name was `MDraft` and the entry was `MDraft.desktop`.
    #[cfg(target_os = "linux")]
    {
        let product_name = context.config().product_name.as_deref().unwrap_or("mdraft");
        glib::set_prgname(Some(product_name));
    }

    let app = tauri::Builder::default()
        .manage(html_preview::PreviewStore::default())
        .manage(clipboard::ClipboardStore::new())
        .manage(fonts::FontCatalog::default())
        .manage(launch::LaunchState::default())
        .manage(speech::SpeechState::default())
        .register_asynchronous_uri_scheme_protocol(latex::SCHEME, |context, request, responder| {
            latex::serve(context.app_handle().clone(), request, responder);
        })
        .register_asynchronous_uri_scheme_protocol(
            html_preview::SCHEME,
            |context, request, responder| {
                html_preview::serve(context.app_handle().clone(), request, responder);
            },
        )
        // Must be the first plugin: it has to stop a second process before any
        // other plugin can create a WebView for the same user-data folder.
        .plugin(tauri_plugin_single_instance::init(
            launch::on_second_instance,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The print surface exists only for one operation and is not a
                // document window; remembering its geometry would add a stale
                // entry to the reader's window state.
                .with_denylist(if hidden_test {
                    &[print::PRINT_WINDOW, "main"]
                } else {
                    &[print::PRINT_WINDOW]
                })
                .build(),
        )
        .on_menu_event(menu::on_event)
        .setup(|app| {
            let state = AppState::load(app.handle());
            // The menu is built after the state is managed so its check marks
            // start on the values the user persisted, not on all-unchecked. The
            // builder's own `menu` hook runs before `setup`, which is why it
            // cannot do this.
            let menu_state = state
                .settings
                .lock()
                .map(|settings| menu::MenuState::from_settings(&settings))
                .unwrap_or_else(|_| menu::MenuState::from_settings(&Settings::default()));
            app.manage(state);
            let menu = menu::build(app.handle(), &menu_state)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            latex::latex_status,
            latex::texpresso_status,
            latex::install_texpresso,
            latex::latex_stats,
            latex::install_latex,
            latex::latex_project_snapshot,
            latex::save_compiled_pdf,
            latex::print_compiled_pdf,
            latex::latex_cache_info,
            latex::latex_disable,
            latex::latex_clear_cache,
            latex_native::latex_engine_status,
            latex_native::latex_native_discover,
            latex_native::latex_native_validate,
            latex_native::latex_native_set_enabled,
            latex_native::latex_native_set_engine,
            latex_native::latex_native_wsl_distributions,
            latex_native::latex_native_wsl_look,
            latex_native::latex_native_wsl_validate,
            latex_texmf::latex_texmf_list,
            latex_texmf::latex_texmf_configure,
            latex_texmf::latex_texmf_inspect,
            latex_texmf::latex_texmf_open,
            latex_texmf::latex_texmf_revision,
            latex_native::latex_native_compile,
            latex_native::latex_native_cancel,
            settings::get_settings,
            settings::save_settings,
            settings::add_recent,
            settings::clear_recent,
            settings::add_favorite,
            settings::remove_favorite,
            ai::ai_status,
            ai::ai_set_key,
            ai::ai_clear_key,
            ai::ai_fetch_models,
            ai::ai_test_reasoning,
            ai::ai_complete,
            ai::naming::ai_suggest_filename,
            ai::ai_prompts_status,
            ai::ai_export_prompts,
            ai::ai_cancel,
            ai::ai_cancel_all,
            documents::read_document,
            documents::read_document_as,
            documents::inspect_document_encoding,
            documents::check_encoding_fit,
            documents::write_document,
            documents::write_document_checked,
            documents::fingerprint_document,
            documents::stat_document,
            documents::path_exists,
            workspace::workspace_open,
            workspace::workspace_list,
            workspace::workspace_main_candidates,
            latex::latex_engine_available,
            latex::install_latex_engine,
            documents::resolve_legacy_local_image,
            documents::open_external,
            documents::open_app_folder,
            documents::startup_file,
            launch::startup_files,
            launch::take_forwarded_paths,
            recovery::list_recovery,
            recovery::write_recovery,
            recovery::remove_recovery,
            tokens::count_tokens,
            fonts::system_fonts,
            clipboard::clipboard_read_text,
            clipboard::clipboard_write_text,
            tex_fmt::tex_fmt_wasm,
            speech::speech_status,
            speech::speech_speak,
            speech::speech_stop,
            spellcheck::spellcheck_languages,
            spellcheck::spellcheck_check,
            spellcheck::spellcheck_suggest,
            images::save_clipboard_image,
            images::import_image,
            images::download_image,
            export::pandoc_status,
            export::run_export,
            export::pandoc_list_writers,
            export::run_pandoc_writer,
            export::run_after_export,
            export::install_pandoc,
            export::print_document,
            print::print_native,
            print::print_native_pdf,
            menu::accelerators,
            menu::set_menu_state,
            menu::set_open_tabs,
            menu::menu_state,
            menu::menu_items,
            menu::recent_menu,
            menu::set_export_availability,
            typst::typst_status,
            typst::install_typst,
            typst::typst_download_page,
            typst::render_typst,
            typst::render_typst_binary,
            typst::cancel_typst_preview,
            typst::service::typst_service_status,
            typst::service::install_typst_service,
            typst::service::typst_clear_cache,
            html_preview::set_html_preview,
            html_preview::clear_html_preview,
        ])
        .build(context)
        .expect("error while building the tauri application");

    app.run(|app_handle, event| {
        // The platform clipboard handle must be released while the process is
        // still alive; on X11/Wayland it is the owner of the data.
        // Shut down warm Typst service daemons gracefully on exit as well.
        if let tauri::RunEvent::Exit = event {
            typst::service::shutdown_all_services();
            app_handle.state::<clipboard::ClipboardStore>().release();
        }

        // macOS/Linux desktop environments deliver "open this file" through the
        // platform event loop rather than argv.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            use tauri::Emitter;
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if !paths.is_empty() {
                let _ = app_handle.emit("open-files", paths);
            }
        }

        let _ = (app_handle, event);
    });
}
