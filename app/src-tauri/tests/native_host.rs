use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};

#[tokio::test]
async fn native_messaging_frames_and_exit_when_app_disconnects() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("browser.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_agentic"))
        .arg("--native-host")
        .arg("--socket")
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let test = async {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let payload = serde_json::to_vec(&json!({"id":"reply","result":{"tabs":[]}})).unwrap();
        stdin.write_u32_le(payload.len() as u32).await.unwrap();
        stdin.write_all(&payload).await.unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["id"], "reply");
        let request = json!({"id":"request","action":"tabs","args":{}});
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let length = stdout.read_u32_le().await.unwrap();
        let mut data = vec![0; length as usize];
        stdout.read_exact(&mut data).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&data).unwrap(), request);
        // Keep stdin open: the native host must still exit when the app goes away.
        drop(write);
        drop(reader);
        let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        drop(stdin);
    };
    tokio::time::timeout(Duration::from_secs(8), test)
        .await
        .unwrap();
}
