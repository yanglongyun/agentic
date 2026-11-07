use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot},
};
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::sync::CancellationToken;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;
struct PendingGuard {
    id: String,
    pending: Pending,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

#[derive(Clone, Default)]
pub struct Browser {
    connection: Arc<Mutex<Option<(String, mpsc::Sender<Value>)>>>,
    pending: Pending,
}

impl Browser {
    pub fn connected(&self) -> bool {
        self.connection.lock().unwrap().is_some()
    }

    pub async fn start(&self, socket: PathBuf, stop: CancellationToken) -> Result<()> {
        crate::private_dir(socket.parent().context("缺少管道目录")?)?;
        if socket.exists() {
            fs::remove_file(&socket)?;
        }
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    incoming = listener.accept() => {
                        if let Ok((stream, _)) = incoming {
                            let bridge = this.clone();
                            let cancel = stop.clone();
                            tokio::spawn(async move { bridge.serve(stream, cancel).await; });
                        }
                    }
                }
            }
            let _ = fs::remove_file(socket);
        });
        Ok(())
    }

    async fn serve(&self, stream: UnixStream, stop: CancellationToken) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::channel::<Value>(32);
        *self.connection.lock().unwrap() = Some((id.clone(), tx));
        let (read, mut write) = stream.into_split();
        let mut read = FramedRead::new(read, LinesCodec::new_with_max_length(8 * 1024 * 1024));
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                message = rx.recv() => {
                    let Some(value) = message else { break; };
                    if write.write_all(format!("{value}\n").as_bytes()).await.is_err() { break; }
                }
                result = read.next() => {
                    let Some(Ok(line)) = result else { break; };
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        let key = value["id"].as_str().unwrap_or_default();
                        if let Some(reply) = self.pending.lock().unwrap().remove(key) {
                            let result = if let Some(error) = value["error"].as_str() { Err(anyhow::anyhow!(error.to_owned())) } else { Ok(value["result"].clone()) };
                            let _ = reply.send(result);
                        }
                    }
                }
            }
        }
        let mut current = self.connection.lock().unwrap();
        if current.as_ref().map(|entry| entry.0.as_str()) == Some(&id) {
            *current = None;
            self.pending.lock().unwrap().clear();
        }
    }

    pub async fn request(&self, action: &str, args: Value) -> Result<Value> {
        let tx = self
            .connection
            .lock()
            .unwrap()
            .as_ref()
            .map(|entry| entry.1.clone())
            .context("浏览器插件未连接，请安装并启用 agentic 插件")?;
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, receive) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), reply);
        let _cleanup = PendingGuard {
            id: id.clone(),
            pending: self.pending.clone(),
        };
        let result = async {
            tx.send(json!({"id":id,"action":action,"args":args}))
                .await
                .context("浏览器已断开")?;
            tokio::time::timeout(std::time::Duration::from_secs(30), receive)
                .await
                .context("浏览器插件响应超时")?
                .context("浏览器已断开")?
        }
        .await;
        self.pending.lock().unwrap().remove(&id);
        result
    }
}

pub fn register(dir: &Path, socket: &Path) -> Result<()> {
    crate::private_dir(dir)?;
    let executable = std::env::current_exe()?;
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let launcher = dir.join("browser-host.sh");
    fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nexec {} --native-host --socket {}\n",
            quote(&executable.to_string_lossy()),
            quote(&socket.to_string_lossy())
        ),
    )?;
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700))?;
    let manifest = json!({"name":"ai.agentic.browser","description":"agentic browser bridge","path":launcher,"type":"stdio","allowed_origins":["chrome-extension://mgiphoedkmmckhdebcmkfceibndnioio/"]});
    let support = crate::home().join("Library/Application Support");
    for browser in [
        "Google/Chrome",
        "Microsoft Edge",
        "Chromium",
        "BraveSoftware/Brave-Browser",
        "Arc/User Data",
    ] {
        let base = support.join(browser);
        if !base.exists() {
            continue;
        }
        let target = base.join("NativeMessagingHosts");
        fs::create_dir_all(&target)?;
        fs::write(
            target.join("ai.agentic.browser.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
    }
    Ok(())
}

pub async fn native_host(socket: &Path) -> Result<()> {
    let stream = UnixStream::connect(socket).await?;
    let (read, mut write) = stream.into_split();
    let from_browser = async {
        let mut stdin = tokio::io::stdin();
        loop {
            let size = match stdin.read_u32_le().await {
                Ok(size) => size,
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(error) => return Err(error.into()),
            };
            if size > 8 * 1024 * 1024 {
                bail!("原生消息过大");
            }
            let mut bytes = vec![0; size as usize];
            stdin.read_exact(&mut bytes).await?;
            let value: Value = serde_json::from_slice(&bytes)?;
            write.write_all(format!("{value}\n").as_bytes()).await?;
        }
    };
    let to_browser = async {
        let mut reader = BufReader::new(read);
        let mut stdout = tokio::io::stdout();
        loop {
            let mut line = String::new();
            if (&mut reader).take(1024 * 1024).read_line(&mut line).await? == 0 {
                return Ok(());
            }
            if !line.ends_with('\n') {
                bail!("浏览器消息过大");
            }
            let bytes = line.trim_end().as_bytes();
            stdout.write_u32_le(bytes.len() as u32).await?;
            stdout.write_all(bytes).await?;
            stdout.flush().await?;
        }
    };
    tokio::select! { result = from_browser => result, result = to_browser => result }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn plugin_socket_roundtrip_and_disconnect() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("browser.sock");
        let browser = Browser::default();
        let stop = CancellationToken::new();
        browser.start(socket.clone(), stop.clone()).await.unwrap();
        let stream = UnixStream::connect(&socket).await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        for _ in 0..100 {
            if browser.connected() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(browser.connected());
        let client = browser.clone();
        let task = tokio::spawn(async move { client.request("tabs", json!({})).await });
        let line = lines.next_line().await.unwrap().unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["action"], "tabs");
        write
            .write_all(
                format!(
                    "{}\n",
                    json!({"id":value["id"],"result":{"tabs":[{"tab":1,"title":"Rust browser"}]}})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        assert_eq!(task.await.unwrap().unwrap()["tabs"][0]["tab"], 1);
        drop(write);
        drop(lines);
        for _ in 0..100 {
            if !browser.connected() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(!browser.connected());
        assert!(browser.request("tabs", json!({})).await.is_err());
        stop.cancel();
    }
}
