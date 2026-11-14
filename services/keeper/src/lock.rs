//! Exclusive advisory lock next to the checkpoint so two keeper processes can never share one state file.
//! Uses an OS file lock (`flock`): released automatically when the process exits or crashes, so there are no stale locks.
use anyhow::{bail, Context, Result};
use std::{
    fs::{File, OpenOptions, TryLockError},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct StateLock {
    _file: File,
    path: PathBuf,
}

pub fn lock_path(state_file: &Path) -> PathBuf {
    let mut s = state_file.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

impl StateLock {
    pub fn acquire(state_file: &Path) -> Result<StateLock> {
        let path = lock_path(state_file);
        let mut f = OpenOptions::new().create(true).truncate(false).write(true).open(&path).with_context(|| format!("opening lock file {}", path.display()))?;
        match f.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => bail!("checkpoint {} is in use by another keeper process (lock file {})", state_file.display(), path.display()),
            Err(TryLockError::Error(e)) => return Err(e).with_context(|| format!("locking {}", path.display())),
        }
        let _ = f.set_len(0);
        let _ = writeln!(f, "{}", std::process::id());
        Ok(StateLock { _file: f, path })
    }

    pub fn path(&self) -> &Path { &self.path }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_holder_is_refused_until_first_drops() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state.json");
        let a = StateLock::acquire(&state).unwrap();
        assert!(a.path().ends_with("state.json.lock"));
        let err = StateLock::acquire(&state).unwrap_err().to_string();
        assert!(err.contains("in use by another keeper"), "{err}");
        // a different checkpoint is independent
        let _b = StateLock::acquire(&dir.path().join("other.json")).unwrap();
        drop(a);
        StateLock::acquire(&state).unwrap();
    }

    #[test]
    fn lock_file_records_pid() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("s.json");
        let l = StateLock::acquire(&state).unwrap();
        let txt = std::fs::read_to_string(l.path()).unwrap();
        assert_eq!(txt.trim(), std::process::id().to_string());
    }
}
