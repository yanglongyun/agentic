use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc::Sender;

struct Terminal {
    meta: Value,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone)]
pub struct Terminals {
    entries: Arc<Mutex<BTreeMap<String, Terminal>>>,
    active: Arc<Mutex<String>>,
    tx: Sender<Value>,
}

impl Terminals {
    pub fn new(tx: Sender<Value>) -> Self {
        Self {
            entries: Default::default(),
            active: Default::default(),
            tx,
        }
    }
    pub fn snapshot(&self, target: &str) -> Vec<Value> {
        let active = self.active.lock().unwrap().clone();
        let entries = self.entries.lock().unwrap();
        let list: Vec<Value> = entries
            .iter()
            .map(|(id, entry)| {
                let mut meta = entry.meta.clone();
                meta["isActive"] = json!(id == &active);
                meta
            })
            .collect();
        let mut messages = vec![
            json!({"type":"terminal.list","to":target,"data":{"terminals":list,"activeTerminalId":active}}),
        ];
        if let Some(entry) = entries.get(&active) {
            messages.push(json!({"type":"system.init","to":target,"data":{"terminalId":active,"cols":entry.meta["cols"],"rows":entry.meta["rows"]}}));
        }
        messages
    }
    pub fn create(&self, args: &Value) -> Result<Vec<Value>> {
        let cwd = args["cwd"].as_str().map(PathBuf::from).unwrap_or_else(|| {
            let desktop = crate::home().join("Desktop");
            if desktop.is_dir() {
                desktop
            } else {
                crate::home()
            }
        });
        if !cwd.is_dir() {
            bail!("终端目录不存在");
        }
        if self.entries.lock().unwrap().len() >= 32 {
            bail!("最多同时打开 32 个终端");
        }
        let id = format!("term-{}", uuid::Uuid::new_v4());
        let cols = dimension(&args["cols"], 80, 1000)?;
        let rows = dimension(&args["rows"], 30, 500)?;
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command =
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
        command.arg("-l");
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let title = args["title"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                cwd.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let meta = json!({"id":id,"title":title,"cwd":cwd,"cols":cols,"rows":rows,"createdAt":crate::now(),"isActive":true});
        self.entries.lock().unwrap().insert(
            id.clone(),
            Terminal {
                meta: meta.clone(),
                master: pair.master,
                writer,
                child,
            },
        );
        *self.active.lock().unwrap() = id.clone();
        let tx = self.tx.clone();
        let entries = self.entries.clone();
        let active = self.active.clone();
        let reader_id = id.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            let mut pending = Vec::new();
            loop {
                let n = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                pending.extend_from_slice(&buffer[..n]);
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(error) if error.error_len().is_none() => error.valid_up_to(),
                    Err(_) => pending.len(),
                };
                if valid == 0 {
                    continue;
                }
                let output = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                if tx.blocking_send(json!({"type":"data.output","to":"web","data":{"terminalId":reader_id,"output":output}})).is_err() { break; }
            }
            let removed = entries.lock().unwrap().remove(&reader_id);
            if let Some(mut entry) = removed {
                let _ = entry.child.wait();
                let next = entries
                    .lock()
                    .unwrap()
                    .keys()
                    .next()
                    .cloned()
                    .unwrap_or_default();
                let active_id = {
                    let mut current = active.lock().unwrap();
                    if *current == reader_id {
                        *current = next;
                    }
                    current.clone()
                };
                let _ = tx.blocking_send(json!({"type":"terminal.closed","to":"web","data":{"terminalId":reader_id,"activeTerminalId":active_id}}));
            }
        });
        Ok(vec![
            json!({"type":"terminal.created","to":"web","data":{"terminal":meta,"activeTerminalId":id}}),
            json!({"type":"system.init","to":"web","data":{"terminalId":id,"cols":cols,"rows":rows}}),
            json!({"type":"terminal.activated","to":"web","data":{"terminalId":id}}),
        ])
    }
    pub fn handle(&self, kind: &str, args: &Value) -> Result<Vec<Value>> {
        if kind == "terminal.create" {
            return self.create(args);
        }
        if kind == "terminal.list" {
            return Ok(self.snapshot("web"));
        }
        let id = args["terminalId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| self.active.lock().unwrap().clone());
        if kind == "terminal.close" {
            if let Some(mut entry) = self.entries.lock().unwrap().remove(&id) {
                let _ = entry.child.kill();
            }
            let next = self
                .entries
                .lock()
                .unwrap()
                .keys()
                .next()
                .cloned()
                .unwrap_or_default();
            *self.active.lock().unwrap() = next.clone();
            let mut messages = vec![
                json!({"type":"terminal.closed","to":"web","data":{"terminalId":id,"activeTerminalId":next}}),
            ];
            if self.entries.lock().unwrap().is_empty() {
                messages.extend(self.create(&json!({}))?);
            }
            return Ok(messages);
        }
        if kind == "system.command" && args["command"] == "restart" {
            let cwd = self
                .entries
                .lock()
                .unwrap()
                .get(&id)
                .map(|entry| entry.meta["cwd"].clone())
                .context("终端不存在")?;
            // Remove the old terminal explicitly; the replacement receives a new identity.
            if let Some(mut entry) = self.entries.lock().unwrap().remove(&id) {
                let _ = entry.child.kill();
            }
            let mut messages =
                vec![json!({"type":"terminal.closed","to":"web","data":{"terminalId":id}})];
            messages.extend(self.create(&json!({"cwd":cwd}))?);
            return Ok(messages);
        }
        let mut entries = self.entries.lock().unwrap();
        let terminal = entries.get_mut(&id).context("终端不存在")?;
        match kind {
            "terminal.activate" => {
                *self.active.lock().unwrap() = id.clone();
                return Ok(vec![
                    json!({"type":"terminal.activated","to":"web","data":{"terminalId":id}}),
                    json!({"type":"system.init","to":"web","data":{"terminalId":id,"cols":terminal.meta["cols"],"rows":terminal.meta["rows"]}}),
                ]);
            }
            "data.input" => {
                terminal
                    .writer
                    .write_all(args["input"].as_str().context("缺少终端输入")?.as_bytes())?;
                terminal.writer.flush()?;
            }
            "system.resize" | "system.init" => {
                let cols = dimension(&args["cols"], 80, 1000)?;
                let rows = dimension(&args["rows"], 30, 500)?;
                terminal.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
                terminal.meta["cols"] = json!(cols);
                terminal.meta["rows"] = json!(rows);
            }
            "system.command" => match args["command"].as_str() {
                Some("ctrl_c") => terminal.writer.write_all(b"\x03")?,
                Some("clear") => {
                    return Ok(vec![
                        json!({"type":"data.output","to":"web","data":{"terminalId":id,"output":"\u{1b}[2J\u{1b}[H"}}),
                    ])
                }
                _ => bail!("未知终端命令"),
            },
            _ => bail!("未知终端操作"),
        }
        Ok(vec![])
    }
    pub fn shutdown(&self) {
        let entries = std::mem::take(&mut *self.entries.lock().unwrap());
        for (_, mut entry) in entries {
            let _ = entry.child.kill();
            let _ = entry.child.wait();
        }
    }
}
fn dimension(value: &Value, default: u16, max: u64) -> Result<u16> {
    if value.is_null() {
        return Ok(default);
    }
    match value.as_u64() {
        Some(n) if n > 0 && n <= max => Ok(n as u16),
        _ => bail!("终端尺寸无效"),
    }
}
