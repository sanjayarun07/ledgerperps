//! Keystore / private-key loading.
use perp_keeper::{config::{Config, RawConfig}, wallet::load_signer};

const ADDR: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// Hardhat dev account #0 (public test key)
const KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY_ADDR: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

fn cfg(edit: impl FnOnce(&mut RawConfig)) -> Config {
    let mut r = RawConfig { rpc_url: Some("http://127.0.0.1:1".into()), exchange: Some(ADDR.into()), ..Default::default() };
    edit(&mut r);
    Config::from_raw(r).unwrap()
}

fn make_keystore(dir: &std::path::Path, password: &str) -> std::path::PathBuf {
    let key = alloy::hex::decode(KEY.trim_start_matches("0x")).unwrap();
    let mut rng = rand::thread_rng();
    alloy::signers::local::PrivateKeySigner::encrypt_keystore(dir, &mut rng, key, password, Some("ks.json")).unwrap();
    dir.join("ks.json")
}

#[test]
fn keystore_roundtrip_with_password_from_the_named_env_var() {
    let dir = tempfile::tempdir().unwrap();
    let path = make_keystore(dir.path(), "correct horse");
    std::env::set_var("KEEPER_TEST_KS_PW_OK", "correct horse");
    let c = cfg(|r| {
        r.keystore_path = Some(path.clone());
        r.keystore_password_env = Some("KEEPER_TEST_KS_PW_OK".into());
    });
    let s = load_signer(&c).unwrap().expect("signer");
    assert_eq!(s.address().to_string(), KEY_ADDR);
    // the password / key never appear in the config's Debug output
    assert!(!format!("{c:?}").contains("correct horse"));
}

#[test]
fn wrong_or_missing_keystore_password_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = make_keystore(dir.path(), "right");
    std::env::set_var("KEEPER_TEST_KS_PW_BAD", "wrong");
    let bad = cfg(|r| {
        r.keystore_path = Some(path.clone());
        r.keystore_password_env = Some("KEEPER_TEST_KS_PW_BAD".into());
    });
    let e = load_signer(&bad).unwrap_err().to_string();
    assert!(e.contains("decrypting keystore"), "{e}");
    std::env::remove_var("KEEPER_TEST_KS_PW_UNSET");
    let unset = cfg(|r| {
        r.keystore_path = Some(path.clone());
        r.keystore_password_env = Some("KEEPER_TEST_KS_PW_UNSET".into());
    });
    assert!(load_signer(&unset).unwrap_err().to_string().contains("KEEPER_TEST_KS_PW_UNSET"));
    let missing = cfg(|r| {
        r.keystore_path = Some(dir.path().join("nope.json"));
        r.keystore_password_env = Some("KEEPER_TEST_KS_PW_BAD".into());
    });
    assert!(load_signer(&missing).is_err());
}

#[test]
fn private_key_from_env_dry_run_and_errors() {
    std::env::set_var("KEEPER_TEST_PK_OK", KEY);
    let s = load_signer(&cfg(|r| r.private_key_env = Some("KEEPER_TEST_PK_OK".into()))).unwrap().unwrap();
    assert_eq!(s.address().to_string(), KEY_ADDR);
    std::env::set_var("KEEPER_TEST_PK_BAD", "not-a-key");
    let e = load_signer(&cfg(|r| r.private_key_env = Some("KEEPER_TEST_PK_BAD".into()))).unwrap_err();
    assert!(!format!("{e:#}").contains("not-a-key"), "never echo key material");
    std::env::remove_var("KEEPER_TEST_PK_NONE");
    let none = |dry| cfg(|r| { r.private_key_env = Some("KEEPER_TEST_PK_NONE".into()); r.dry_run = Some(dry); });
    assert!(load_signer(&none(true)).unwrap().is_none(), "dry-run may run without a key");
    assert!(load_signer(&none(false)).is_err(), "live mode requires a key");
}
