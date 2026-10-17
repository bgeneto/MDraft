fn main() {
    // The host cfg is the right one here: Linux builds run on Linux (Tauri
    // cannot cross-compile webkit), so the build script and the binary agree.
    #[cfg(target_os = "linux")]
    {
        // Dynamic link only. The dictionaries stay in /usr/share/hunspell and
        // are passed to Hunspell_create by absolute path, which is what lets an
        // AppImage see the host's word lists instead of an empty prefix inside
        // the image.
        if let Err(error) = pkg_config::Config::new().probe("hunspell") {
            println!("cargo:warning=libhunspell was not found ({error}); install libhunspell-dev");
            // Fail the build rather than emit a binary whose spellcheck commands
            // are unlinked. A missing .pc file is a setup error, not a runtime one.
            panic!("libhunspell not found. On Debian/Ubuntu: sudo apt install libhunspell-dev");
        }
    }
    tauri_build::build()
}
