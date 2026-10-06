//! Keep simultaneous app instances out of the same WebView2 browser/GPU process.
//! The primary instance retains its existing profile; additional slots persist
//! independently. Never copy a live Chromium database or force software decode.
use std::path::{Path, PathBuf};

pub(crate) fn secondary_directory(base: Option<&Path>, slot: u32) -> Option<PathBuf> {
    if slot == 1 {
        return None;
    }
    Some(match base {
        Some(base) => {
            let mut sibling = base.file_name().unwrap_or(base.as_os_str()).to_os_string();
            sibling.push("-instances");
            base.with_file_name(sibling).join(format!("instance-{slot}"))
        }
        None => PathBuf::from(format!("instances/instance-{slot}")),
    })
}

#[cfg(windows)]
pub(crate) struct ProfileLease {
    pub(crate) slot: u32,
    handle: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProfileLease {
    pub(crate) fn acquire(key: &str) -> Result<Self, String> {
        use std::hash::{Hash, Hasher};
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
                System::Threading::CreateMutexW,
            },
        };
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        key.replace('\\', "/").to_lowercase().hash(&mut hash);
        let key = hash.finish();
        for slot in 1..=32 {
            let name: Vec<u16> = format!("Local\\SeeMyGame-WebViewProfile-{key:x}-{slot}\0")
                .encode_utf16()
                .collect();
            // Existence of the named object reserves the slot. No mutex wait or
            // ownership is needed; closing the last handle releases it after exit.
            let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
                .map_err(|e| e.to_string())?;
            let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            if !existed {
                return Ok(Self { slot, handle });
            }
            let _ = unsafe { CloseHandle(handle) };
        }
        Err("All WebView2 instance profile slots are occupied".into())
    }
}

#[cfg(windows)]
impl Drop for ProfileLease {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_primary_profile_and_separates_secondary_profiles() {
        assert_eq!(secondary_directory(None, 1), None);
        assert_eq!(secondary_directory(Some(Path::new("original")), 1), None);
        assert_eq!(
            secondary_directory(None, 2),
            Some(PathBuf::from("instances/instance-2"))
        );
        assert_eq!(
            secondary_directory(Some(Path::new("original")), 2),
            Some(PathBuf::from("original-instances/instance-2"))
        );
        assert_ne!(secondary_directory(None, 2), secondary_directory(None, 3));
        assert_ne!(
            secondary_directory(Some(Path::new("com.seemygame.app")), 2),
            secondary_directory(Some(Path::new("other.app")), 2)
        );
        assert_eq!(
            secondary_directory(Some(Path::new("root/original/")), 2),
            Some(PathBuf::from("root/original-instances/instance-2"))
        );
    }
    #[cfg(windows)]
    #[test]
    fn reserves_live_slots_and_reuses_only_released_slots() {
        let key = format!(
            "test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        );
        let primary = ProfileLease::acquire(&key).unwrap();
        let secondary = ProfileLease::acquire(&key).unwrap();
        assert_eq!((primary.slot, secondary.slot), (1, 2));
        drop(primary);
        assert_eq!(ProfileLease::acquire(&key).unwrap().slot, 1);
        assert_eq!(
            ProfileLease::acquire(&(key + "-independent")).unwrap().slot,
            1
        );
    }
}
