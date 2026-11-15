//! Application-data backup and restore.
//!
//! The archive format is kept independent of Tauri so the same validation is
//! used for exported archives, restore previews and recovery tests.

mod buffers;
mod format;
pub(crate) mod gate;
mod inbox;
pub(crate) mod inbox_store;
pub(crate) mod jobs;
mod private_fs;
pub(crate) mod restart;
mod restore;
pub(crate) mod snapshot;
mod transaction;
