//! MDraft — a Tauri 2 markdown editor.

mod documents;
mod export;
mod images;
mod menu;
mod settings;

use settings::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| menu::on_event(app, event))
        .setup(|app| {
            let state = AppState::load(app.handle());
            app.manage(state);
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
            images::save_clipboard_image,
            images::import_image,
            images::download_image,
            export::pandoc_status,
            export::run_export,
            export::install_pandoc,
            export::print_document,
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
