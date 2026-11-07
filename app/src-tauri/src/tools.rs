use crate::browser::Browser;
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().with_context(|| format!("缺少 {key}"))
}
fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    let value = string(args, key)?;
    if value.is_empty() {
        bail!("{key} 不能为空");
    }
    Ok(value)
}
fn resolve(workdir: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_owned()
    } else {
        workdir.join(path)
    }
}
fn limit(value: &str, max: usize) -> String {
    let out: String = value.chars().take(max).collect();
    if value.chars().count() > max {
        format!("{out}\n…（输出已截断）")
    } else {
        out
    }
}
fn image_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

pub async fn execute(
    name: &str,
    args: &Value,
    config: &Value,
    browser: &Browser,
    stop: CancellationToken,
) -> Value {
    let result = execute_inner(name, args, config, browser, stop.clone()).await;
    match result {
        Ok(mut value) => {
            if value.get("failed").is_none() {
                value["failed"] = json!(false);
            }
            value
        }
        Err(error) => json!({"text":error.to_string(),"failed":true}),
    }
}

async fn execute_inner(
    name: &str,
    args: &Value,
    config: &Value,
    browser: &Browser,
    stop: CancellationToken,
) -> Result<Value> {
    let workdir = config["workdir"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(crate::home);
    let max = config["max_output"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(30000)
        .min(1_000_000) as usize;
    let timeout = config["timeout"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(120)
        .min(3600);
    if stop.is_cancelled() {
        bail!("执行已取消");
    }
    match name {
        "shell" => {
            shell(
                required(args, "command")?,
                &resolve(&workdir, args["workdir"].as_str().unwrap_or(".")),
                max,
                timeout,
                stop,
            )
            .await
        }
        "read" => {
            let path = resolve(&workdir, required(args, "path")?);
            let meta = tokio::fs::metadata(&path).await?;
            let mime = image_type(&path);
            let bound = if mime.is_some() {
                5 * 1024 * 1024
            } else {
                32 * 1024 * 1024
            };
            if !meta.is_file() || meta.len() > bound {
                bail!("不是普通文件或文件过大");
            }
            let file = tokio::fs::File::open(&path).await?;
            let mut bytes = Vec::new();
            file.take(bound + 1).read_to_end(&mut bytes).await?;
            if bytes.len() as u64 > bound {
                bail!("文件过大");
            }
            if let Some(mime) = mime {
                return Ok(
                    json!({"text":format!("已读取图片 {}",path.display()),"image":{"base64":STANDARD.encode(bytes),"mime":mime}}),
                );
            }
            if bytes.contains(&0) {
                bail!("这是二进制文件");
            }
            let content = String::from_utf8(bytes)?.replace("\r\n", "\n");
            let offset = positive(args, "offset", 1)?;
            let count = positive(args, "limit", 2000)?;
            let lines: Vec<_> = content.lines().collect();
            let output = lines
                .iter()
                .enumerate()
                .skip(offset - 1)
                .take(count)
                .map(|(i, line)| format!("{:6}\t{line}", i + 1))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(json!({"text":limit(&format!("{output}\n\n[共 {} 行]",lines.len()),max)}))
        }
        "write" => {
            let path = resolve(&workdir, required(args, "path")?);
            let content = string(args, "content")?;
            if content.len() > 32 * 1024 * 1024 {
                bail!("写入内容过大");
            }
            tokio::fs::create_dir_all(path.parent().context("路径无效")?).await?;
            tokio::fs::write(&path, content).await?;
            Ok(json!({"text":format!("已写入 {}（{} 字节）",path.display(),content.len())}))
        }
        "edit" => {
            let path = resolve(&workdir, required(args, "path")?);
            let old = required(args, "old_string")?;
            let new = string(args, "new_string")?;
            let meta = tokio::fs::metadata(&path).await?;
            if !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
                bail!("不是普通文件或超过 2MB");
            }
            let content = tokio::fs::read_to_string(&path).await?;
            let count = content.matches(old).count();
            if count == 0 {
                bail!("没有找到 old_string");
            }
            let all = args["replace_all"].as_bool().unwrap_or(false);
            if count > 1 && !all {
                bail!("匹配到 {count} 处，请增加上下文或设置 replace_all");
            }
            let next = if all {
                content.replace(old, new)
            } else {
                content.replacen(old, new, 1)
            };
            tokio::fs::write(&path, next).await?;
            Ok(
                json!({"text":format!("已修改 {}（替换 {} 处）",path.display(),if all{count}else{1})}),
            )
        }
        "browser" => {
            let action = required(args, "action")?;
            if !["tabs", "open", "close", "detach", "cdp", "chrome"].contains(&action) {
                bail!("无效浏览器动作");
            }
            let mut rest = args.clone();
            rest.as_object_mut()
                .context("工具参数必须是对象")?
                .remove("action");
            rest["session"] = json!({"id":config["session_id"],"title":config["session_title"]});
            let result = tokio::select! { result=browser.request(action,rest)=>result?,_=stop.cancelled()=>bail!("执行已取消") };
            if !result["exceptionDetails"].is_null() {
                bail!("页面执行失败：{}", result["exceptionDetails"]);
            }
            if args["method"] == "Page.captureScreenshot" {
                if let Some(data) = result["data"].as_str() {
                    let mime = match args["params"]["format"].as_str() {
                        Some("jpeg") => "image/jpeg",
                        Some("webp") => "image/webp",
                        _ => "image/png",
                    };
                    return Ok(json!({"text":"已截图","image":{"base64":data,"mime":mime}}));
                }
            }
            let text = match action {
                "tabs" => result["tabs"]
                    .as_array()
                    .map(|tabs| {
                        tabs.iter()
                            .map(|tab| {
                                format!(
                                    "[tab {}] {}\n{}",
                                    tab["tab"],
                                    tab["title"].as_str().unwrap_or_default(),
                                    tab["url"].as_str().unwrap_or_default()
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_else(|| result.to_string()),
                _ => serde_json::to_string_pretty(&result)?,
            };
            Ok(json!({"text":limit(&text,max)}))
        }
        _ => bail!("未知设备工具：{name}"),
    }
}

fn positive(args: &Value, key: &str, default: usize) -> Result<usize> {
    if args[key].is_null() {
        return Ok(default);
    }
    match args[key].as_u64() {
        Some(n) if n > 0 && n <= usize::MAX as u64 => Ok(n as usize),
        _ => bail!("{key} 必须是正整数"),
    }
}

struct ProcessGroup(i32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}

async fn drain<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    output: Arc<Mutex<Vec<u8>>>,
    max: usize,
) {
    let mut buffer = [0u8; 8192];
    while let Ok(n) = reader.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        let mut output = output.lock().unwrap();
        let room = max.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..n.min(room)]);
    }
}
async fn shell(
    command: &str,
    cwd: &Path,
    max: usize,
    timeout: u64,
    stop: CancellationToken,
) -> Result<Value> {
    let mut child = Command::new("/bin/bash")
        .args(["-c", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    let group = ProcessGroup(child.id().context("进程未启动")? as i32);
    let output = Arc::new(Mutex::new(Vec::new()));
    let a = tokio::spawn(drain(child.stdout.take().unwrap(), output.clone(), max * 4));
    let b = tokio::spawn(drain(child.stderr.take().unwrap(), output.clone(), max * 4));
    let status = tokio::select! {
        status=tokio::time::timeout(Duration::from_secs(timeout),child.wait())=>Some(status),
        _=stop.cancelled()=>None,
    };
    let timed_out = matches!(status, Some(Err(_)));
    let code = match status {
        Some(Ok(Ok(exit))) => exit.code().unwrap_or(-1),
        _ => -1,
    };
    drop(group);
    let _ = child.wait().await;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = a.await;
        let _ = b.await;
    })
    .await;
    let output = output.lock().unwrap();
    let text = limit(&String::from_utf8_lossy(&output), max);
    Ok(
        json!({"failed":code!=0||timed_out||stop.is_cancelled(),"text":format!("{}{}{}\n\n[退出码 {code}]",if text.is_empty(){"(无输出)"}else{&text},if timed_out{"\n[超时：命令已终止]"}else{""},if stop.is_cancelled(){"\n[已取消]"}else{""})}),
    )
}

pub async fn screenshot() -> Result<Vec<u8>> {
    let file = std::env::temp_dir().join(format!("agentic-screen-{}.png", uuid::Uuid::new_v4()));
    let jpg = file.with_extension("jpg");
    let _cleanup = ScreenshotFiles([file.clone(), jpg.clone()]);
    let result = async {
        let capture = tokio::time::timeout(
            Duration::from_secs(15),
            Command::new("/usr/sbin/screencapture")
                .args(["-x", "-m", "-t", "png"])
                .arg(&file)
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        if !capture.status.success() {
            bail!(
                "截图失败，请在系统设置 → 隐私与安全性 → 屏幕录制中允许 agentic，并重新启动。{}",
                String::from_utf8_lossy(&capture.stderr)
            );
        }
        let resized = tokio::time::timeout(
            Duration::from_secs(15),
            Command::new("/usr/bin/sips")
                .args([
                    "-Z",
                    "1568",
                    "-s",
                    "format",
                    "jpeg",
                    "-s",
                    "formatOptions",
                    "55",
                ])
                .arg(&file)
                .arg("--out")
                .arg(&jpg)
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        if !resized.status.success() {
            bail!("截图压缩失败");
        }
        let bytes = tokio::fs::read(&jpg).await?;
        if !bytes.starts_with(&[0xff, 0xd8, 0xff]) || bytes.len() > 5 * 1024 * 1024 {
            bail!("截图无效或过大");
        }
        Ok(bytes)
    }
    .await;
    let _ = tokio::fs::remove_file(file).await;
    let _ = tokio::fs::remove_file(jpg).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn tool_roundtrip_and_unique_edit() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = json!({"workdir":dir.path()});
        let browser = Browser::default();
        let run = |name: &'static str, args: Value| {
            let cfg = cfg.clone();
            let browser = browser.clone();
            async move { execute(name, &args, &cfg, &browser, CancellationToken::new()).await }
        };
        assert_eq!(
            run("write", json!({"path":"a.txt","content":"hello hello"})).await["failed"],
            false
        );
        assert_eq!(
            run(
                "edit",
                json!({"path":"a.txt","old_string":"hello","new_string":"hi"})
            )
            .await["failed"],
            true
        );
        assert_eq!(
            run(
                "edit",
                json!({"path":"a.txt","old_string":"hello","new_string":"hi","replace_all":true})
            )
            .await["failed"],
            false
        );
        assert!(run("read", json!({"path":"a.txt"})).await["text"]
            .as_str()
            .unwrap()
            .contains("hi hi"));
        let result = run("shell", json!({"command":"printf rust-executor"})).await;
        assert_eq!(result["failed"], false);
        assert!(result["text"].as_str().unwrap().contains("rust-executor"));
    }
    #[tokio::test]
    async fn shell_timeout_kills_process_group() {
        let result = shell("sleep 20", &crate::home(), 100, 1, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result["failed"], true);
        assert!(result["text"].as_str().unwrap().contains("超时"));
    }
}

struct ScreenshotFiles([std::path::PathBuf; 2]);
impl Drop for ScreenshotFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}
