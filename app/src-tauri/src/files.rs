use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

struct Upload {
    file: File,
    temp: PathBuf,
    target: PathBuf,
    size: u64,
    received: u64,
    seq: u64,
    overwrite: bool,
}
impl Drop for Upload {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temp);
    }
}
#[derive(Default)]
pub struct Files {
    uploads: HashMap<String, Upload>,
}
fn mtime(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|t| t.as_millis() as u64)
        .unwrap_or(0)
}
fn message(kind: &str, data: Value) -> Value {
    json!({"type":kind,"data":data})
}
fn text<'a>(data: &'a Value, key: &str) -> Result<&'a str> {
    data[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .with_context(|| format!("缺少 {key}"))
}

impl Files {
    pub fn handle(&mut self, kind: &str, data: &Value, client: &str) -> Result<Vec<Value>> {
        let req = text(data, "reqId")?;
        let upload_id = format!("{client}:{req}");
        let payload = match kind {
            "fs.home" => json!({"path":crate::home(),"sep":"/","platform":"darwin"}),
            "fs.list" => {
                let path = data["path"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(crate::home);
                let mut entries = Vec::new();
                for entry in fs::read_dir(&path)? {
                    let entry = entry?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !data["showHidden"].as_bool().unwrap_or(false) && name.starts_with('.') {
                        continue;
                    }
                    let item = match fs::metadata(entry.path()) {
                        Ok(meta) => {
                            json!({"name":name,"type":if meta.is_dir() {"dir"} else if entry.file_type()?.is_symlink() {"link"} else {"file"},"size":meta.len(),"mtime":mtime(&meta)})
                        }
                        Err(_) => json!({"name":name,"type":"unknown","size":0,"mtime":0}),
                    };
                    entries.push(item);
                }
                entries.sort_by_key(|entry| {
                    (
                        entry["type"] != "dir",
                        entry["name"].as_str().unwrap_or_default().to_lowercase(),
                    )
                });
                json!({"path":path,"entries":entries})
            }
            "fs.stat" => {
                let path = text(data, "path")?;
                let meta = fs::metadata(path)?;
                json!({"path":path,"type":if meta.is_dir() {"dir"} else {"file"},"size":meta.len(),"mtime":mtime(&meta)})
            }
            "fs.read" => {
                let path = Path::new(text(data, "path")?);
                let meta = fs::metadata(path)?;
                let limit = data["maxSize"]
                    .as_u64()
                    .unwrap_or(20 * 1024 * 1024)
                    .min(20 * 1024 * 1024);
                if !meta.is_file() || meta.len() > limit {
                    bail!("不是普通文件或文件超过预览大小限制");
                }
                use std::io::Read;
                let mut bytes = Vec::new();
                File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
                if bytes.len() as u64 > limit {
                    bail!("文件超过预览大小限制");
                }
                let mut messages = vec![message(
                    "fs.read.meta",
                    json!({"reqId":req,"name":path.file_name().unwrap_or_default().to_string_lossy(),"size":bytes.len(),"mime":mime_guess::from_path(path).first_or_octet_stream().as_ref()}),
                )];
                if bytes.is_empty() {
                    messages.push(message(
                        "fs.read.chunk",
                        json!({"reqId":req,"seq":0,"data":"","eof":true}),
                    ));
                }
                for (seq, chunk) in bytes.chunks(256 * 1024).enumerate() {
                    messages.push(message("fs.read.chunk",json!({"reqId":req,"seq":seq,"data":STANDARD.encode(chunk),"eof":(seq+1)*256*1024>=bytes.len()})));
                }
                return Ok(messages);
            }
            "fs.mkdir" => {
                let path = text(data, "path")?;
                fs::create_dir_all(path)?;
                json!({"path":path})
            }
            "fs.rename" => {
                let from = text(data, "from")?;
                let to = text(data, "to")?;
                fs::rename(from, to)?;
                json!({"from":from,"to":to})
            }
            "fs.delete" => {
                let path = Path::new(text(data, "path")?);
                // Do not follow a directory symlink when deleting it.
                let meta = fs::symlink_metadata(path)?;
                if meta.is_dir() {
                    if !data["recursive"].as_bool().unwrap_or(false) {
                        bail!("是目录，需 recursive=true");
                    }
                    let canonical = path.canonicalize()?;
                    if canonical == Path::new("/") || canonical == crate::home() {
                        bail!("不能删除根目录或整个用户目录");
                    }
                    fs::remove_dir_all(path)?;
                } else {
                    fs::remove_file(path)?;
                }
                json!({})
            }
            "fs.upload.start" => {
                if self.uploads.len() >= 16 {
                    bail!("同时上传数量超过限制");
                }
                let path = PathBuf::from(text(data, "path")?);
                let size = data["size"].as_u64().context("缺少文件大小")?;
                if size > 1024 * 1024 * 1024 {
                    bail!("单个上传文件不能超过 1GB");
                }
                let overwrite = data["overwrite"].as_bool().unwrap_or(false);
                if !overwrite && path.exists() {
                    bail!("文件已存在");
                }
                fs::create_dir_all(path.parent().context("文件路径无效")?)?;
                let temp = path.with_extension(format!("{}.upload", uuid::Uuid::new_v4()));
                let file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .mode(0o600)
                    .open(&temp)?;
                self.uploads.insert(
                    upload_id,
                    Upload {
                        file,
                        temp,
                        target: path.clone(),
                        size,
                        received: 0,
                        seq: 0,
                        overwrite,
                    },
                );
                json!({"path":path,"ready":true})
            }
            "fs.upload.chunk" => {
                let result = (|| -> Result<Value> {
                    let upload = self.uploads.get_mut(&upload_id).context("上传会话不存在")?;
                    if data["seq"].as_u64() != Some(upload.seq) {
                        bail!("上传块序号错误");
                    }
                    let bytes = STANDARD.decode(data["data"].as_str().unwrap_or_default())?;
                    if bytes.len() > 512 * 1024
                        || upload.received + bytes.len() as u64 > upload.size
                    {
                        bail!("上传数据大小不符合声明");
                    }
                    upload.file.write_all(&bytes)?;
                    upload.received += bytes.len() as u64;
                    upload.seq += 1;
                    if !data["eof"].as_bool().unwrap_or(false) {
                        return Ok(json!({"ack":true,"received":upload.received}));
                    }
                    if upload.received != upload.size {
                        bail!("上传文件不完整");
                    }
                    upload.file.sync_all()?;
                    if upload.overwrite {
                        fs::rename(&upload.temp, &upload.target)?;
                    } else {
                        fs::hard_link(&upload.temp, &upload.target)?;
                    }
                    Ok(json!({"path":upload.target,"received":upload.received,"completed":true}))
                })();
                match result {
                    Ok(value) if value["ack"] == true => {
                        return Ok(vec![message(
                            "fs.upload.ack",
                            json!({"reqId":req,"received":value["received"]}),
                        )])
                    }
                    other => {
                        self.uploads.remove(&upload_id);
                        other?
                    }
                }
            }
            "fs.upload.abort" => {
                self.uploads.remove(&upload_id);
                json!({"aborted":true})
            }
            _ => bail!("未知文件操作：{kind}"),
        };
        let mut payload = payload;
        payload["reqId"] = json!(req);
        payload["ok"] = json!(true);
        Ok(vec![message("fs.result", payload)])
    }
    pub fn clear_uploads(&mut self) {
        self.uploads.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_upload_preserves_existing_file_and_sequences_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "original").unwrap();
        let mut files = Files::default();
        files
            .handle(
                "fs.upload.start",
                &json!({"reqId":"a","path":path,"size":3,"overwrite":true}),
                "client",
            )
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert!(files
            .handle(
                "fs.upload.chunk",
                &json!({"reqId":"a","seq":1,"data":"YWJj","eof":true}),
                "client"
            )
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert!(files.uploads.is_empty());
        files
            .handle(
                "fs.upload.start",
                &json!({"reqId":"b","path":path,"size":3,"overwrite":true}),
                "client",
            )
            .unwrap();
        files
            .handle(
                "fs.upload.chunk",
                &json!({"reqId":"b","seq":0,"data":"YWJj","eof":true}),
                "client",
            )
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "abc");
    }
}
