use crate::{browser::Browser, config::Config, files::Files, terminal::Terminals};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use tokio_util::sync::CancellationToken;

pub struct DeviceHandle {
    pub stop: CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
}
impl DeviceHandle {
    pub async fn shutdown(mut self) {
        self.stop.cancel();
        if tokio::time::timeout(Duration::from_secs(8), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
        }
    }
}

pub fn start(
    config: Config,
    directory: std::path::PathBuf,
    status: watch::Sender<String>,
    register_browser: bool,
) -> DeviceHandle {
    let stop = CancellationToken::new();
    let cancel = stop.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = run(config, directory, status.clone(), cancel, register_browser).await {
            let _ = status.send(format!("启动失败：{error}"));
        }
    });
    DeviceHandle { stop, task }
}

pub fn device_id(directory: &Path) -> Result<String> {
    crate::private_dir(directory)?;
    let file = directory.join("device.json");
    if file.exists() {
        let value: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
        return Ok(value["id"].as_str().context("设备 ID 无效")?.to_owned());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    crate::config::atomic_write(
        &file,
        &serde_json::to_vec(&json!({"id":id,"createdAt":crate::now()}))?,
    )?;
    Ok(id)
}

fn envelope(kind: &str, target: &str, data: Value) -> Value {
    json!({"type":kind,"to":target,"data":data})
}
async fn send(tx: &mpsc::Sender<Value>, kind: &str, target: &str, data: Value) {
    let _ = tx.send(envelope(kind, target, data)).await;
}

async fn run(
    config: Config,
    directory: std::path::PathBuf,
    status: watch::Sender<String>,
    stop: CancellationToken,
    register_browser: bool,
) -> Result<()> {
    // Choose the TLS provider explicitly when desktop dependencies also enable another backend.
    let _ = rustls::crypto::ring::default_provider().install_default();
    crate::private_dir(&directory)?;
    let _instance = RunLock::acquire(&directory)?;
    let id = device_id(&directory)?;
    let browser = Browser::default();
    if register_browser {
        let socket = directory.join("browser.sock");
        browser.start(socket.clone(), stop.clone()).await?;
        if let Err(error) = crate::browser::register(&directory.join("native-host"), &socket) {
            eprintln!("登记浏览器宿主失败：{error}");
        }
    }
    let (tx, mut outbound) = mpsc::channel::<Value>(256);
    let terminals = Terminals::new(tx.clone());
    let _cleanup = Cleanup {
        terminals: terminals.clone(),
        stop: stop.clone(),
    };
    let _ = terminals.create(&json!({}));
    let files = Arc::new(Mutex::new(Files::default()));
    let slots = Arc::new(Semaphore::new(16));
    let screens = crate::screen::Screens::default();
    let mut replaced = false;
    let mut retry = 1;
    while !stop.is_cancelled() {
        let _ = status.send("连接中".into());
        let origin = url::Url::parse(&config.url)?;
        let scheme = if origin.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        let mut url = origin.clone();
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("无效 WebSocket 地址"))?;
        url.set_path("/ws");
        url.query_pairs_mut()
            .append_pair("device", "desktop")
            .append_pair("device_id", &id);
        let mut request = url.as_str().into_client_request()?;
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {}", config.token).parse()?);
        let connecting = tokio::time::timeout(Duration::from_secs(20), connect_async(request));
        tokio::pin!(connecting);
        let connection = loop {
            tokio::select! {
                _=stop.cancelled()=>break None,
                result=&mut connecting=>break Some(result),
                _=outbound.recv()=>{},
            }
        };
        let Some(connection) = connection else {
            break;
        };
        if let Ok(Ok((socket, _))) = connection {
            retry = 1;
            let _ = status.send("已连接".into());
            let (mut writer, mut reader) = socket.split();
            writer
                .send(Message::Text(
                    report(&config, &id, &browser).to_string().into(),
                ))
                .await?;
            for message in terminals.snapshot("web") {
                writer
                    .send(Message::Text(message.to_string().into()))
                    .await?;
            }
            let session = stop.child_token();
            let (incoming_tx, mut incoming_rx) = mpsc::channel::<Value>(128);
            let actor_tx = tx.clone();
            let actor_terminals = terminals.clone();
            let actor_files = files.clone();
            let actor_browser = browser.clone();
            let actor_stop = session.clone();
            let actor_slots = slots.clone();
            let actor_screens = screens.clone();
            let calls: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>> =
                Default::default();
            let actor = tokio::spawn(async move {
                while let Some(message) =
                    tokio::select! {_=actor_stop.cancelled()=>None,value=incoming_rx.recv()=>value}
                {
                    let kind = message["type"].as_str().unwrap_or_default().to_owned();
                    let data = message["data"].clone();
                    let client = message["meta"]["clientId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned();
                    let target = if client.is_empty() {
                        "web".into()
                    } else {
                        format!("web:{client}")
                    };
                    if kind == "connection.ping" {
                        send(&actor_tx, "connection.pong", "server", json!({})).await;
                        continue;
                    }
                    if kind == "web.left" {
                        if let Some(client) = data["clientId"].as_str() {
                            actor_screens.release(&format!("web:{client}"));
                        }
                        continue;
                    }
                    if kind == "screen.request"
                        && (client.is_empty()
                            || !data["reqId"]
                                .as_str()
                                .map(|id| !id.is_empty() && id.len() <= 100)
                                .unwrap_or(false))
                    {
                        continue;
                    }
                    if kind == "screen.cancel" {
                        actor_screens.cancel(
                            &format!("web:{client}"),
                            data["reqId"].as_str().unwrap_or_default(),
                        );
                        continue;
                    }
                    if kind == "tool.cancel" {
                        if let Some(cancel) = calls
                            .lock()
                            .unwrap()
                            .get(data["call_id"].as_str().unwrap_or_default())
                        {
                            cancel.cancel();
                        }
                        continue;
                    }
                    if kind == "web.joined" {
                        let target =
                            format!("web:{}", data["clientId"].as_str().unwrap_or_default());
                        for item in actor_terminals.snapshot(&target) {
                            let _ = actor_tx.send(item).await;
                        }
                        continue;
                    }
                    if kind.starts_with("terminal.")
                        || kind.starts_with("data.")
                        || kind.starts_with("system.")
                    {
                        match actor_terminals.handle(&kind, &data) {
                            Ok(messages) => {
                                for item in messages {
                                    let _ = actor_tx.send(item).await;
                                }
                            }
                            Err(error) => send(
                                &actor_tx,
                                "terminal.error",
                                &target,
                                json!({"terminalId":data["terminalId"],"error":error.to_string()}),
                            )
                            .await,
                        }
                    } else if kind.starts_with("fs.") {
                        let files = actor_files.clone();
                        let operation = kind.clone();
                        let args = data.clone();
                        let client_id = client.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            files.lock().unwrap().handle(&operation, &args, &client_id)
                        })
                        .await;
                        match result {
                            Ok(Ok(messages)) => {
                                for mut item in messages {
                                    item["to"] = json!(target);
                                    let _ = actor_tx.send(item).await;
                                }
                            }
                            other => {
                                let error = match other {
                                    Ok(Err(e)) => e.to_string(),
                                    Err(e) => e.to_string(),
                                    _ => unreachable!(),
                                };
                                send(
                                    &actor_tx,
                                    "fs.result",
                                    &target,
                                    json!({"reqId":data["reqId"],"ok":false,"error":error}),
                                )
                                .await;
                            }
                        }
                    } else if kind == "tool.call"
                        || kind == "screen.request"
                        || kind == "status.request"
                    {
                        let permit = match actor_slots.clone().try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                if kind == "tool.call" {
                                    send(&actor_tx,"tool.result","server",json!({"call_id":data["call_id"],"result":{"failed":true,"text":"设备当前执行任务过多，请稍后重试"}})).await;
                                }
                                continue;
                            }
                        };
                        let tx = actor_tx.clone();
                        let browser = actor_browser.clone();
                        let cancel = actor_stop.child_token();
                        let screens = actor_screens.clone();
                        let calls = calls.clone();
                        let call_id = data["call_id"].as_str().unwrap_or_default().to_owned();
                        if kind == "tool.call" {
                            if call_id.is_empty() || calls.lock().unwrap().contains_key(&call_id) {
                                continue;
                            }
                            calls
                                .lock()
                                .unwrap()
                                .insert(call_id.clone(), cancel.clone());
                        }
                        tokio::spawn(async move {
                            let _permit = permit;
                            if kind == "tool.call" {
                                let result = if data["name"] == "computer" {
                                    match screens
                                        .computer(
                                            &data["arguments"],
                                            &data["config"],
                                            cancel.clone(),
                                        )
                                        .await
                                    {
                                        Ok(result) => result,
                                        Err(error) => {
                                            json!({"failed":true,"text":error.to_string()})
                                        }
                                    }
                                } else {
                                    crate::tools::execute(
                                        data["name"].as_str().unwrap_or_default(),
                                        &data["arguments"],
                                        &data["config"],
                                        &browser,
                                        cancel.clone(),
                                    )
                                    .await
                                };
                                calls.lock().unwrap().remove(&call_id);
                                if !cancel.is_cancelled() {
                                    send(
                                        &tx,
                                        "tool.result",
                                        "server",
                                        json!({"call_id":data["call_id"],"result":result}),
                                    )
                                    .await;
                                }
                            } else if kind == "screen.request" {
                                if client.is_empty() {
                                    return;
                                }
                                let result = screens
                                    .perform(
                                        &format!("web:{client}"),
                                        &data,
                                        false,
                                        false,
                                        cancel.clone(),
                                    )
                                    .await;
                                if !cancel.is_cancelled() {
                                    match result {
                                        Ok(mut payload)=>{payload["reqId"]=data["reqId"].clone();payload["ok"]=json!(true);send(&tx,"screen.result",&target,payload).await;}
                                        Err(error) if error.to_string()!="CANCELLED"=>send(&tx,"screen.result",&target,json!({"reqId":data["reqId"],"ok":false,"error":error.to_string(),"code":crate::screen::error_code(&error)})).await,
                                        _=>{},
                                    }
                                }
                            } else {
                                let req = data["reqId"].clone();
                                let mut payload =
                                    tokio::task::spawn_blocking(snapshot).await.unwrap_or_else(
                                        |_| json!({"ok":false,"error":"读取系统状态失败"}),
                                    );
                                payload["reqId"] = req;
                                send(&tx, "status.result", &target, payload).await;
                            }
                        });
                    }
                }
            });
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
            let mut last_seen = tokio::time::Instant::now();
            let mut browser_state = browser.connected();
            loop {
                tokio::select! {
                    _=stop.cancelled()=>break,
                    _=heartbeat.tick()=>{
                        if last_seen.elapsed()>Duration::from_secs(60){break;}
                        if writer.send(Message::Ping(vec![].into())).await.is_err(){break;}
                        if browser.connected()!=browser_state{browser_state=browser.connected();if writer.send(Message::Text(report(&config,&id,&browser).to_string().into())).await.is_err(){break;}}
                    }
                    item=outbound.recv()=>{if let Some(item)=item{if writer.send(Message::Text(item.to_string().into())).await.is_err(){break;}}}
                    item=reader.next()=>match item{
                        Some(Ok(Message::Text(text)))=>{last_seen=tokio::time::Instant::now();if text.len()<=40*1024*1024{if let Ok(value)=serde_json::from_str::<Value>(&text){if incoming_tx.try_send(value).is_err(){break;}}}},
                        Some(Ok(Message::Ping(bytes)))=>{last_seen=tokio::time::Instant::now();if writer.send(Message::Pong(bytes)).await.is_err(){break;}},
                        Some(Ok(Message::Pong(_)))=>last_seen=tokio::time::Instant::now(),
                        Some(Ok(Message::Close(frame)))=>{if frame.as_ref().map(|frame|u16::from(frame.code))==Some(4002){replaced=true;stop.cancel();}break;},
                    Some(Err(_))|None=>break,
                        _=>{},
                    }
                }
            }
            session.cancel();
            drop(incoming_tx);
            actor.abort();
            let _ = writer.close().await;
            files.lock().unwrap().clear_uploads();
        }
        if stop.is_cancelled() {
            break;
        }
        let _ = status.send("连接断开，正在重连".into());
        let delay = tokio::time::sleep(Duration::from_secs(retry));
        tokio::pin!(delay);
        loop {
            tokio::select! {_=stop.cancelled()=>break,_=&mut delay=>break,_=outbound.recv()=>{}}
        }
        retry = (retry * 2).min(30);
    }
    stop.cancel();
    terminals.shutdown();
    files.lock().unwrap().clear_uploads();
    let _ = status.send(if replaced {
        "另一实例已接入，已停止重连".into()
    } else {
        "已停止".into()
    });
    Ok(())
}

struct Cleanup {
    terminals: Terminals,
    stop: CancellationToken,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.stop.cancel();
        self.terminals.shutdown();
    }
}

fn report(config: &Config, id: &str, browser: &Browser) -> Value {
    let username = std::env::var("USER").unwrap_or_default();
    let arch = if std::env::consts::ARCH == "aarch64" {
        "arm64"
    } else {
        std::env::consts::ARCH
    };
    envelope(
        "device.report",
        "server",
        json!({"id":id,"name":if config.name.is_empty(){format!("{username} 的 Mac")}else{config.name.clone()},"description":config.description,"platform":"darwin","arch":arch,"host":sysinfo::System::host_name(),"username":username,"workdir":crate::home(),"browser":browser.connected()}),
    )
}

fn snapshot() -> Value {
    let mut system = sysinfo::System::new_all();
    std::thread::sleep(Duration::from_millis(250));
    system.refresh_cpu_all();
    system.refresh_memory();
    let total = system.total_memory();
    let free = system.available_memory();
    let used = total.saturating_sub(free);
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let disk=disks.iter().find(|disk|disk.mount_point()==Path::new("/")).map(|disk|{let total=disk.total_space();let free=disk.available_space();json!({"mount":"/","total":total,"free":free,"used":total-free,"percent":100.0*(total-free)as f64/total.max(1)as f64})});
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let network:Vec<Value>=networks.iter().flat_map(|(name,data)|{data.ip_networks().iter().filter_map(move|ip|match ip.addr{std::net::IpAddr::V4(addr)if !addr.is_loopback()=>Some(json!({"name":name,"address":addr.to_string(),"mac":data.mac_address().to_string()})),_=>None})}).collect();
    let load = sysinfo::System::load_average();
    json!({"ok":true,"capturedAt":crate::now(),"host":{"hostname":sysinfo::System::host_name(),"platform":"darwin","release":sysinfo::System::kernel_version(),"arch":if std::env::consts::ARCH=="aarch64"{"arm64"}else{std::env::consts::ARCH},"uptime":sysinfo::System::uptime()},"cpu":{"count":system.cpus().len(),"model":system.cpus().first().map(|cpu|cpu.brand()).unwrap_or_default(),"speed":system.cpus().first().map(|cpu|cpu.frequency()).unwrap_or_default(),"usagePercent":system.global_cpu_usage(),"loadavg":[load.one,load.five,load.fifteen]},"mem":{"total":total,"free":free,"used":used,"percent":100.0*used as f64/total.max(1)as f64},"disk":disk,"network":network})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn native_device_auth_tool_and_terminal_roundtrip() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory = tempfile::tempdir().unwrap();
        let config = Config {
            url: format!("http://127.0.0.1:{port}"),
            token: "device-secret".into(),
            name: "Rust Mac".into(),
            description: String::new(),
        };
        let (status, _) = watch::channel(String::new());
        let device = start(config, directory.path().to_owned(), status, false);
        let test = async {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket=tokio_tungstenite::accept_hdr_async(stream,|request:&tokio_tungstenite::tungstenite::handshake::server::Request,response:tokio_tungstenite::tungstenite::handshake::server::Response|{
                assert_eq!(request.headers()["Authorization"],"Bearer device-secret");
                assert!(request.uri().query().unwrap().contains("device_id="));Ok(response)
            }).await.unwrap();
            let mut report = false;
            let mut terminal = String::new();
            while !report || terminal.is_empty() {
                if let Some(Ok(Message::Text(text))) = socket.next().await {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "device.report" {
                        report = true;
                        assert_eq!(value["data"]["name"], "Rust Mac");
                    }
                    if value["type"] == "terminal.list" {
                        terminal = value["data"]["activeTerminalId"].as_str().unwrap().into();
                    }
                }
            }
            socket.send(Message::Text(json!({"type":"tool.call","data":{"call_id":"rust-tool","name":"shell","arguments":{"command":"printf native-rust-roundtrip"},"config":{}}}).to_string().into())).await.unwrap();
            loop {
                if let Some(Ok(Message::Text(text))) = socket.next().await {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "tool.result" {
                        assert_eq!(value["data"]["call_id"], "rust-tool");
                        assert_eq!(value["data"]["result"]["failed"], false);
                        assert!(value["data"]["result"]["text"]
                            .as_str()
                            .unwrap()
                            .contains("native-rust-roundtrip"));
                        break;
                    }
                }
            }
            socket.send(Message::Text(json!({"type":"data.input","data":{"terminalId":terminal,"input":"printf 'pty-rust-roundtrip\\n'\r"}}).to_string().into())).await.unwrap();
            loop {
                if let Some(Ok(Message::Text(text))) = socket.next().await {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "data.output"
                        && value["data"]["output"]
                            .as_str()
                            .unwrap_or_default()
                            .contains("pty-rust-roundtrip")
                    {
                        break;
                    }
                }
            }
            let pidfile = directory.path().join("cancelled-shell.pid");
            let command = format!("echo $$ > '{}'; sleep 20", pidfile.display());
            socket.send(Message::Text(json!({"type":"tool.call","data":{"call_id":"cancel-this","name":"shell","arguments":{"command":command},"config":{}}}).to_string().into())).await.unwrap();
            let pid = loop {
                if let Ok(text) = tokio::fs::read_to_string(&pidfile).await {
                    if let Ok(pid) = text.trim().parse::<i32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            socket
                .send(Message::Text(
                    json!({"type":"tool.cancel","data":{"call_id":"cancel-this"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while unsafe { libc::kill(pid, 0) } == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("tool.cancel must terminate the running shell");
            socket.close(None).await.unwrap();
        };
        let result = tokio::time::timeout(Duration::from_secs(20), test).await;
        device.shutdown().await;
        assert!(
            rustls::crypto::CryptoProvider::get_default().is_some(),
            "TLS provider must be initialized before connecting"
        );
        assert!(result.is_ok(), "真实设备联调超时");
    }
}

struct RunLock(std::fs::File);
impl RunLock {
    fn acquire(dir: &std::path::Path) -> Result<Self> {
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join("client.lock"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            anyhow::bail!("这台设备的执行端已经运行，请勿重复启动");
        }
        Ok(Self(file))
    }
}
impl Drop for RunLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn instance_lock_is_released_without_unlinking_the_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = RunLock::acquire(dir.path()).unwrap();
        assert!(RunLock::acquire(dir.path()).is_err());
        drop(first);
        assert!(dir.path().join("client.lock").exists());
        assert!(RunLock::acquire(dir.path()).is_ok());
    }
    #[tokio::test]
    async fn superseded_device_stops_reconnecting() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (status, _updates) = watch::channel(String::new());
        let mut device = start(
            Config {
                url: format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port()),
                token: "test".into(),
                ..Default::default()
            },
            dir.path().to_owned(),
            status.clone(),
            false,
        );
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: 4002.into(),
                reason: "replaced".into(),
            }))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), &mut device.task)
            .await
            .expect("replaced instance must stop")
            .unwrap();
        assert!(status.borrow().contains("已停止重连"));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    }
}
