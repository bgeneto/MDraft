//! Private directories for staging, even when a portable profile is shared.

use std::path::Path;

#[cfg(windows)]
pub fn create_dir(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{
        CreateDirectoryW, GetVolumeInformationW, GetVolumePathNameW,
    };
    use windows::core::{PCWSTR, w};

    const FILE_PERSISTENT_ACLS: u32 = 0x0000_0008;
    let parent = path.parent().ok_or("The private folder has no parent.")?;
    let parent: Vec<u16> = parent
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut volume = vec![0_u16; 32768];
    unsafe { GetVolumePathNameW(PCWSTR(parent.as_ptr()), &mut volume) }
        .map_err(|error| format!("Cannot check private staging permissions: {error}"))?;
    let mut flags = 0;
    unsafe {
        GetVolumeInformationW(
            PCWSTR(volume.as_ptr()),
            None,
            None,
            None,
            Some(&mut flags),
            None,
        )
    }
    .map_err(|error| format!("Cannot check private staging permissions: {error}"))?;
    if flags & FILE_PERSISTENT_ACLS == 0 {
        return Err("The application data volume cannot protect private backup staging. Choose a profile on a volume with access controls.".into());
    }

    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("D:P(A;OICI;FA;;;OW)"),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|error| format!("Cannot prepare private staging permissions: {error}"))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let name: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe { CreateDirectoryW(PCWSTR(name.as_ptr()), Some(&attributes)) };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result.map_err(|error| format!("Cannot create private staging: {error}"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        DACL_SECURITY_INFORMATION, GetFileSecurityW, PSECURITY_DESCRIPTOR,
    };
    use windows::core::{PCWSTR, PWSTR};

    #[test]
    fn private_directory_has_an_owner_only_protected_dacl() {
        let parent = std::env::temp_dir();
        let path = parent.join(format!("mdraft-private-test-{}", std::process::id()));
        create_dir(&path).unwrap();
        let name: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut needed = 0;
        unsafe {
            let _ = GetFileSecurityW(
                PCWSTR(name.as_ptr()),
                DACL_SECURITY_INFORMATION.0,
                None,
                0,
                &mut needed,
            );
        }
        assert!(needed > 0);
        let mut bytes = vec![0_u8; needed as usize];
        let descriptor = PSECURITY_DESCRIPTOR(bytes.as_mut_ptr().cast());
        unsafe {
            GetFileSecurityW(
                PCWSTR(name.as_ptr()),
                DACL_SECURITY_INFORMATION.0,
                Some(descriptor),
                needed,
                &mut needed,
            )
            .ok()
            .unwrap();
        }
        let mut text = PWSTR::null();
        let mut len = 0;
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                Some(&mut len),
            )
            .unwrap();
        }
        let sddl =
            unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text.0, len as usize)) };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        }
        assert!(sddl.starts_with("D:P"), "{sddl}");
        assert_eq!(sddl.matches('(').count(), 1, "{sddl}");
        assert!(
            sddl.contains(";;;OW)") || sddl.contains(";;;S-1-3-4)"),
            "{sddl}"
        );
        if path.parent() == Some(parent.as_path())
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("mdraft-private-test-"))
        {
            std::fs::remove_dir(&path).unwrap();
        }
    }
}

#[cfg(unix)]
pub fn create_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|error| format!("Cannot create private staging: {error}"))
}
