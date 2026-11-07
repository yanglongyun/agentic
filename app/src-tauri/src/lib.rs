pub mod browser;
pub mod config;
pub mod device;
pub mod files;
pub mod screen;
pub mod terminal;
pub mod tools;

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn home() -> std::path::PathBuf {
    dirs::home_dir().expect("无法获取用户目录")
}

pub fn state_dir() -> std::path::PathBuf {
    std::env::var_os("AGENTIC_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home().join("Library/Application Support/ai.agentic-client"))
}

pub fn private_dir(path: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}
