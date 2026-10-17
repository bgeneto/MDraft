//! MDraft — a Tauri 2 markdown editor.

mod documents;
mod export;
mod html_preview;
mod images;
mod menu;
mod settings;
mod spellcheck;
mod tokens;
mod typst;

use settings::{AppState, Settings};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(html_preview::PreviewStore::default())
        .register_asynchronous_uri_scheme_protocol(
            html_preview::SCHEME,
            |context, request, responder| {
                html_preview::serve(context.app_handle().clone(), request, responder);
            },
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_menu_event(|app, event| menu::on_event(app, event))
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
            settings::get_settings,
            settings::save_settings,
            settings::add_recent,
            settings::clear_recent,
            documents::read_document,
            documents::write_document,
            documents::stat_document,
            documents::path_exists,
            documents::list_directory,
            documents::startup_file,
            tokens::count_tokens,
            spellcheck::spellcheck_languages,
            spellcheck::spellcheck_check,
            spellcheck::spellcheck_suggest,
            images::save_clipboard_image,
            images::import_image,
            images::download_image,
            export::pandoc_status,
            export::run_export,
            export::run_after_export,
            export::install_pandoc,
            export::print_document,
            menu::accelerators,
            menu::set_menu_state,
            menu::menu_state,
            menu::set_export_availability,
            typst::typst_status,
            typst::install_typst,
            typst::typst_download_page,
            typst::render_typst,
            html_preview::set_html_preview,
            html_preview::clear_html_preview,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the tauri application");

    app.run(|app_handle, event| {
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
