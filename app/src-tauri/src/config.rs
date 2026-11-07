use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, os::unix::fs::OpenOptionsExt, path::Path};
use url::Url;

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub url: String,
    #[serde(default, skip_serializing)]
    pub token: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

impl Config {
    pub fn validate(mut self) -> Result<Self> {
        let url = Url::parse(self.url.trim()).context("请输入有效的服务地址")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.scheme() != "https" && !(local && url.scheme() == "http") {
            bail!("服务需要 HTTPS，本地开发可用 HTTP");
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("请输入服务根地址，不包含账号、路径和参数");
        }
        self.url = url.origin().ascii_serialization();
        self.token = self.token.trim().to_owned();
        if self.token.is_empty() || self.token.contains(['\r', '\n']) {
            bail!("请输入有效设备令牌");
        }
        self.name = self.name.trim().chars().take(100).collect();
        self.description = self.description.trim().chars().take(1000).collect();
        Ok(self)
    }
}

const SERVICE: &str = "ai.agentic.client.device-token";

pub fn save(dir: &Path, config: Config) -> Result<Config> {
    let config = config.validate()?;
    crate::private_dir(dir)?;
    // The token never enters the JSON file or remote webview.
    security_framework::passwords::set_generic_password(
        SERVICE,
        &config.url,
        config.token.as_bytes(),
    )
    .context("无法写入 macOS 钥匙串")?;
    atomic_write(
        &dir.join("connection.json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    Ok(config)
}

pub fn load(dir: &Path) -> Result<Option<Config>> {
    let file = dir.join("connection.json");
    if !file.exists() {
        return Ok(None);
    }
    let mut config: Config = serde_json::from_slice(&fs::read(file)?)?;
    config.token = String::from_utf8(
        security_framework::passwords::get_generic_password(SERVICE, &config.url)
            .context("无法读取 macOS 钥匙串，请解锁登录钥匙串")?,
    )?;
    Ok(Some(config.validate()?))
}

pub fn atomic_write(file: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        fs::rename(&tmp, file)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_origin_and_token() {
        for url in [
            "http://example.com",
            "file:///etc/passwd",
            "https://a:b@example.com",
            "https://example.com/path",
            "https://example.com/?key=x",
        ] {
            assert!(Config {
                url: url.into(),
                token: "secret".into(),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        let config = Config {
            url: "http://127.0.0.1:9507".into(),
            token: "secret".into(),
            ..Default::default()
        }
        .validate()
        .unwrap();
        assert!(!serde_json::to_string(&config).unwrap().contains("secret"));
    }
}
