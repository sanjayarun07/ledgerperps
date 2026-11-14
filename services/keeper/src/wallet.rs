//! Signer loading. Key material is read from the environment or an encrypted keystore and is never logged.
use crate::config::Config;
use alloy::signers::local::PrivateKeySigner;
use anyhow::{anyhow, Context, Result};

pub fn load_signer(cfg: &Config) -> Result<Option<PrivateKeySigner>> {
    if let Some(path) = &cfg.keystore_path {
        let pw = std::env::var(&cfg.keystore_password_env)
            .map_err(|_| anyhow!("keystore_path set but env var {} is empty", cfg.keystore_password_env))?;
        let s = PrivateKeySigner::decrypt_keystore(path, pw).map_err(|e| anyhow!("decrypting keystore {}: {e}", path.display()))?;
        return Ok(Some(s));
    }
    let r: Result<Option<PrivateKeySigner>> = match std::env::var(&cfg.private_key_env) {
        Ok(v) if !v.trim().is_empty() => v
            .trim()
            .parse::<PrivateKeySigner>()
            .map(Some)
            .map_err(|_| anyhow!("env var {} does not hold a valid hex private key", cfg.private_key_env)),
        _ if cfg.dry_run => Ok(None),
        _ => Err(anyhow!("no signing key: set {} or keystore_path (or run with --dry-run)", cfg.private_key_env)),
    };
    r.context("loading keeper signer")
}
