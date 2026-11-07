use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq)]
pub struct Display {
    id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
pub struct Shot {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
trait Driver: Send + Sync {
    fn display(&self) -> Result<Display>;
    fn status(&self) -> Value;
    fn permission(&self) -> Result<Value>;
    fn input(&self, input: &Value, display: Display) -> Result<()>;
    fn capture(&self) -> BoxFuture<'_, Result<Shot>>;
}
struct Native;
impl Driver for Native {
    fn display(&self) -> Result<Display> {
        native::display()
    }
    fn status(&self) -> Value {
        native::status()
    }
    fn permission(&self) -> Result<Value> {
        native::permission()
    }
    fn input(&self, input: &Value, display: Display) -> Result<()> {
        native::input(input, display)
    }
    fn capture(&self) -> BoxFuture<'_, Result<Shot>> {
        Box::pin(async {
            if !native::screen_access() {
                native::request_screen_access();
                bail!("SCREEN_PERMISSION: 请在这台 Mac 的系统设置中允许 agentic 录制屏幕");
            }
            let bytes = crate::tools::screenshot().await?;
            let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()?
                .into_dimensions()?;
            Ok(Shot {
                bytes,
                width,
                height,
            })
        })
    }
}
struct Frame {
    owner: String,
    display: Display,
    width: u32,
    height: u32,
    at: Instant,
}
#[derive(Clone)]
pub struct Screens {
    driver: Arc<dyn Driver>,
    queue: Arc<tokio::sync::Mutex<()>>,
    frames: Arc<Mutex<HashMap<String, Frame>>>,
    requests: Arc<Mutex<HashMap<String, CancellationToken>>>,
}
impl Default for Screens {
    fn default() -> Self {
        Self::new(Arc::new(Native))
    }
}
struct RequestGuard {
    key: String,
    requests: Arc<Mutex<HashMap<String, CancellationToken>>>,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.requests.lock().unwrap().remove(&self.key);
    }
}
impl Screens {
    fn new(driver: Arc<dyn Driver>) -> Self {
        Self {
            driver,
            queue: Default::default(),
            frames: Default::default(),
            requests: Default::default(),
        }
    }
    pub fn cancel(&self, owner: &str, request: &str) {
        if let Some(stop) = self
            .requests
            .lock()
            .unwrap()
            .get(&format!("{owner}:{request}"))
        {
            stop.cancel();
        }
    }
    pub fn release(&self, owner: &str) {
        for (key, stop) in self.requests.lock().unwrap().iter() {
            if key.starts_with(&format!("{owner}:")) {
                stop.cancel();
            }
        }
        self.frames
            .lock()
            .unwrap()
            .retain(|_, frame| frame.owner != owner);
    }
    pub async fn perform(
        &self,
        owner: &str,
        args: &Value,
        pixels: bool,
        capture_after: bool,
        stop: CancellationToken,
    ) -> Result<Value> {
        let key = format!(
            "{owner}:{}",
            args["reqId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
        );
        let cancel = stop.child_token();
        {
            let mut requests = self.requests.lock().unwrap();
            if requests.len() >= 16 {
                bail!("SCREEN_BUSY: 设备忙，请稍后重试");
            }
            if requests.contains_key(&key) {
                bail!("SCREEN_BUSY: 请求正在执行");
            }
            requests.insert(key.clone(), cancel.clone());
        }
        let _cleanup = RequestGuard {
            key,
            requests: self.requests.clone(),
        };
        let work = async {
            let _queue = self.queue.lock().await;
            if cancel.is_cancelled() {
                bail!("CANCELLED");
            }
            self.frames
                .lock()
                .unwrap()
                .retain(|_, frame| frame.at.elapsed() < Duration::from_secs(60));
            match args["action"].as_str() {
                Some("capture") => self.capture(owner, &cancel).await,
                Some("permission") => Ok(json!({"control":self.driver.permission()?})),
                Some("input") => {
                    let id = args["frameId"]
                        .as_str()
                        .context("STALE_FRAME: 操作前请先截图")?;
                    let (display, width, height) = {
                        let frames = self.frames.lock().unwrap();
                        let frame = frames
                            .get(id)
                            .filter(|frame| frame.owner == owner)
                            .context("STALE_FRAME: 画面已过期，请重新截图")?;
                        (frame.display, frame.width, frame.height)
                    };
                    let mut input = args["input"].clone();
                    if pixels && matches!(input["type"].as_str(), Some("click" | "scroll")) {
                        for (axis, size) in [("x", width), ("y", height)] {
                            let n = input[axis].as_f64().context("INVALID_INPUT: 缺少坐标")?;
                            if !n.is_finite() || n < 0.0 || n >= size as f64 || size <= 1 {
                                bail!("INVALID_INPUT: 操作超出截图范围");
                            }
                            input[axis] = json!(n / (size - 1) as f64);
                        }
                    }
                    validate_input(&input)?;
                    if self.driver.display()? != display {
                        bail!("STALE_FRAME: 屏幕布局已变化，请重新截图");
                    }
                    if cancel.is_cancelled() {
                        bail!("CANCELLED");
                    }
                    self.frames.lock().unwrap().clear();
                    self.driver.input(&input, display)?;
                    if !capture_after {
                        return Ok(json!({}));
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    self.capture(owner,&cancel).await.map_err(|error|anyhow!("ACTION_WITHOUT_FRAME: 操作已执行，但新截图失败：{error}。请重新截图，不要重复操作"))
                }
                _ => bail!("INVALID_INPUT: 屏幕操作无效"),
            }
        };
        tokio::select! {result=work=>result,_=cancel.cancelled()=>bail!("CANCELLED")}
    }
    async fn capture(&self, owner: &str, cancel: &CancellationToken) -> Result<Value> {
        let display = self.driver.display()?;
        let shot = self.driver.capture().await?;
        if cancel.is_cancelled() {
            bail!("CANCELLED");
        }
        if self.driver.display()? != display {
            bail!("STALE_FRAME: 屏幕布局已变化");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = crate::now();
        let mut frames = self.frames.lock().unwrap();
        let mut own: Vec<_> = frames
            .iter()
            .filter(|(_, frame)| frame.owner == owner)
            .map(|(id, frame)| (id.clone(), frame.at))
            .collect();
        own.sort_by_key(|(_, at)| *at);
        let extra = own.len().saturating_sub(3);
        for (id, _) in own.into_iter().take(extra) {
            frames.remove(&id);
        }
        frames.insert(
            id.clone(),
            Frame {
                owner: owner.into(),
                display,
                width: shot.width,
                height: shot.height,
                at: Instant::now(),
            },
        );
        Ok(
            json!({"frameId":id,"width":shot.width,"height":shot.height,"capturedAt":now,"control":self.driver.status(),"mime":"image/jpeg","bytes":shot.bytes.len(),"data":STANDARD.encode(shot.bytes)}),
        )
    }
    pub async fn computer(
        &self,
        args: &Value,
        config: &Value,
        stop: CancellationToken,
    ) -> Result<Value> {
        let session = config["session_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("桌面操作必须属于任务")?;
        let action = args["action"].as_str().context("缺少 action")?;
        let request = if action == "screenshot" {
            json!({"action":"capture"})
        } else {
            let frame = args["frame_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .context("操作前必须截图并提供 frame_id")?;
            let input = match action {
                "click" => {
                    json!({"type":"click","x":args["x"],"y":args["y"],"button":args["button"].as_str().unwrap_or("left"),"count":args["count"].as_u64().unwrap_or(1)})
                }
                "scroll" => {
                    json!({"type":"scroll","x":args["x"],"y":args["y"],"deltaX":args["delta_x"].as_f64().unwrap_or(0.0),"deltaY":args["delta_y"].as_f64().unwrap_or(0.0)})
                }
                "type" => json!({"type":"text","text":args["text"]}),
                "key" => {
                    json!({"type":"key","key":args["key"],"modifiers":args.get("modifiers").cloned().unwrap_or(json!([]))})
                }
                _ => bail!("桌面动作无效"),
            };
            json!({"action":"input","frameId":frame,"input":input})
        };
        let shot = self
            .perform(&format!("task:{session}"), &request, true, true, stop)
            .await?;
        let text=json!({"frame_id":shot["frameId"],"width":shot["width"],"height":shot["height"],"captured_at":shot["capturedAt"],"control":shot["control"],"result":if action=="screenshot"{"已截图"}else{"操作已执行，附操作后的截图"}}).to_string();
        Ok(json!({"text":text,"failed":false,"image":{"base64":shot["data"],"mime":shot["mime"]}}))
    }
}
pub fn error_code(error: &anyhow::Error) -> &str {
    let code = error
        .to_string()
        .split(':')
        .next()
        .unwrap_or_default()
        .to_owned();
    match code.as_str() {
        "INVALID_INPUT" => "INVALID_INPUT",
        "STALE_FRAME" => "STALE_FRAME",
        "SCREEN_BUSY" => "SCREEN_BUSY",
        "CONTROL_PERMISSION" => "CONTROL_PERMISSION",
        "SCREEN_PERMISSION" => "SCREEN_PERMISSION",
        "ACTION_WITHOUT_FRAME" => "ACTION_WITHOUT_FRAME",
        _ => "SCREEN_ERROR",
    }
}
fn key_code(key: &str) -> Option<u16> {
    Some(match key {
        "Enter" => 36,
        "Tab" => 48,
        "Space" => 49,
        "Backspace" => 51,
        "Escape" => 53,
        "Delete" => 117,
        "ArrowLeft" => 123,
        "ArrowRight" => 124,
        "ArrowDown" => 125,
        "ArrowUp" => 126,
        "Home" => 115,
        "End" => 119,
        "PageUp" => 116,
        "PageDown" => 121,
        "a" => 0,
        "c" => 8,
        "v" => 9,
        "x" => 7,
        "z" => 6,
        _ => return None,
    })
}
pub fn validate_input(input: &Value) -> Result<()> {
    match input["type"].as_str() {
        Some("text") => {
            let text = input["text"].as_str().context("INVALID_INPUT: 缺少文字")?;
            if text.is_empty() || text.encode_utf16().count() > 10000 {
                bail!("INVALID_INPUT: 文字长度无效");
            }
        }
        Some("key") => {
            key_code(input["key"].as_str().unwrap_or_default())
                .context("INVALID_INPUT: 按键无效")?;
            let mods = input["modifiers"]
                .as_array()
                .context("INVALID_INPUT: 修饰键无效")?;
            if mods
                .iter()
                .any(|v| !matches!(v.as_str(), Some("meta" | "ctrl" | "alt" | "shift")))
            {
                bail!("INVALID_INPUT: 修饰键无效");
            }
        }
        Some("click" | "scroll") => {
            for axis in ["x", "y"] {
                let value = input[axis].as_f64().context("INVALID_INPUT: 坐标无效")?;
                if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                    bail!("INVALID_INPUT: 坐标无效");
                }
            }
            if input["type"] == "click" {
                if !matches!(input["button"].as_str(), Some("left" | "right"))
                    || !matches!(input["count"].as_u64(), Some(1 | 2))
                {
                    bail!("INVALID_INPUT: 点击方式无效");
                }
            } else {
                for axis in ["deltaX", "deltaY"] {
                    let n = input[axis]
                        .as_f64()
                        .context("INVALID_INPUT: 滚动距离无效")?;
                    if !n.is_finite() || n.abs() > 1200.0 {
                        bail!("INVALID_INPUT: 滚动距离无效");
                    }
                }
            }
        }
        _ => bail!("INVALID_INPUT: 输入无效"),
    }
    Ok(())
}

mod native {
    use super::*;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(id: u32) -> Rect;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGEventCreateMouseEvent(
            source: *const c_void,
            kind: u32,
            point: Point,
            button: u32,
        ) -> *const c_void;
        fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool)
            -> *const c_void;
        fn CGEventKeyboardSetUnicodeString(event: *const c_void, length: usize, text: *const u16);
        fn CGEventSetFlags(event: *const c_void, flags: u64);
        fn CGEventSetIntegerValueField(event: *const c_void, field: u32, value: i64);
        fn CGEventSetLocation(event: *const c_void, point: Point);
        fn CGEventCreateScrollWheelEvent2(
            source: *const c_void,
            units: u32,
            count: u32,
            y: i32,
            x: i32,
            z: i32,
        ) -> *const c_void;
        fn CGEventPost(tap: u32, event: *const c_void);
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
        fn CFDictionaryCreateMutable(
            allocator: *const c_void,
            capacity: isize,
            keys: *const c_void,
            values: *const c_void,
        ) -> *const c_void;
        fn CFDictionarySetValue(dict: *const c_void, key: *const c_void, value: *const c_void);
        static kCFBooleanTrue: *const c_void;
    }
    pub fn request_screen_access() {
        static REQUESTING: std::sync::atomic::AtomicBool =
            std::sync::atomic::AtomicBool::new(false);
        if !REQUESTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
            std::thread::spawn(|| {
                unsafe {
                    CGRequestScreenCaptureAccess();
                }
                REQUESTING.store(false, std::sync::atomic::Ordering::SeqCst);
            });
        }
    }
    pub fn screen_access() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    pub fn display() -> Result<Display> {
        unsafe {
            let id = CGMainDisplayID();
            let rect = CGDisplayBounds(id);
            if rect.size.width <= 1.0 || rect.size.height <= 1.0 {
                bail!("没有可用显示器");
            }
            Ok(Display {
                id,
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
            })
        }
    }
    pub fn status() -> Value {
        json!({"supported":true,"allowed":unsafe{AXIsProcessTrusted()},"platform":"darwin"})
    }
    pub fn permission() -> Result<Value> {
        unsafe {
            let options =
                CFDictionaryCreateMutable(std::ptr::null(), 0, std::ptr::null(), std::ptr::null());
            if options.is_null() {
                bail!("无法请求控制授权");
            }
            CFDictionarySetValue(options, kAXTrustedCheckOptionPrompt, kCFBooleanTrue);
            AXIsProcessTrustedWithOptions(options);
            CFRelease(options);
        }
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()?;
        Ok(status())
    }
    fn deliver(event: *const c_void, configure: impl FnOnce(*const c_void)) -> Result<()> {
        if event.is_null() {
            bail!("无法创建输入事件");
        }
        unsafe {
            configure(event);
            CGEventPost(0, event);
            CFRelease(event);
        }
        Ok(())
    }
    pub fn input(input: &Value, display: Display) -> Result<()> {
        if !unsafe { AXIsProcessTrusted() } {
            bail!("CONTROL_PERMISSION: 请在这台 Mac 系统设置中允许 agentic 控制电脑");
        }
        match input["type"].as_str() {
            Some("key") => {
                let code =
                    key_code(input["key"].as_str().unwrap_or_default()).context("按键无效")?;
                let flags = input["modifiers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .fold(0, |flags, v| {
                        flags
                            | match v.as_str() {
                                Some("shift") => 1 << 17,
                                Some("ctrl") => 1 << 18,
                                Some("alt") => 1 << 19,
                                Some("meta") => 1 << 20,
                                _ => 0,
                            }
                    });
                for down in [true, false] {
                    unsafe {
                        deliver(
                            CGEventCreateKeyboardEvent(std::ptr::null(), code, down),
                            |event| CGEventSetFlags(event, flags),
                        )?;
                    }
                }
            }
            Some("text") => {
                let mut chunk = Vec::<u16>::new();
                for character in input["text"].as_str().unwrap().chars() {
                    let mut bytes = [0; 2];
                    let units = character.encode_utf16(&mut bytes);
                    if chunk.len() + units.len() > 20 {
                        type_chunk(&chunk)?;
                        chunk.clear();
                    }
                    chunk.extend_from_slice(units);
                }
                if !chunk.is_empty() {
                    type_chunk(&chunk)?;
                }
            }
            _ => {
                let point = Point {
                    x: display.x + input["x"].as_f64().unwrap() * (display.width - 1.0),
                    y: display.y + input["y"].as_f64().unwrap() * (display.height - 1.0),
                };
                unsafe {
                    deliver(
                        CGEventCreateMouseEvent(std::ptr::null(), 5, point, 0),
                        |_| {},
                    )?;
                }
                if input["type"] == "scroll" {
                    unsafe {
                        deliver(
                            CGEventCreateScrollWheelEvent2(
                                std::ptr::null(),
                                0,
                                2,
                                -input["deltaY"].as_f64().unwrap().round() as i32,
                                -input["deltaX"].as_f64().unwrap().round() as i32,
                                0,
                            ),
                            |event| CGEventSetLocation(event, point),
                        )?;
                    }
                } else {
                    let right = input["button"] == "right";
                    for count in 1..=input["count"].as_u64().unwrap() {
                        for kind in if right { [3, 4] } else { [1, 2] } {
                            unsafe {
                                deliver(
                                    CGEventCreateMouseEvent(
                                        std::ptr::null(),
                                        kind,
                                        point,
                                        if right { 1 } else { 0 },
                                    ),
                                    |event| CGEventSetIntegerValueField(event, 1, count as i64),
                                )?;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
    fn type_chunk(units: &[u16]) -> Result<()> {
        for down in [true, false] {
            unsafe {
                deliver(
                    CGEventCreateKeyboardEvent(std::ptr::null(), 0, down),
                    |event| CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr()),
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        inputs: Mutex<Vec<Value>>,
        width: std::sync::atomic::AtomicU32,
    }
    impl Driver for Fake {
        fn display(&self) -> Result<Display> {
            Ok(Display {
                id: 1,
                x: 0.0,
                y: 0.0,
                width: 100.0 + self.width.load(std::sync::atomic::Ordering::SeqCst) as f64,
                height: 100.0,
            })
        }
        fn status(&self) -> Value {
            json!({"supported":true,"allowed":true,"platform":"darwin"})
        }
        fn permission(&self) -> Result<Value> {
            Ok(self.status())
        }
        fn input(&self, input: &Value, _: Display) -> Result<()> {
            self.inputs.lock().unwrap().push(input.clone());
            Ok(())
        }
        fn capture(&self) -> BoxFuture<'_, Result<Shot>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(5)).await;
                Ok(Shot {
                    bytes: vec![1, 2, 3],
                    width: 100,
                    height: 100,
                })
            })
        }
    }
    #[tokio::test]
    async fn screen_owner_pixels_and_all_frames_invalidated_after_input() {
        let driver = Arc::new(Fake::default());
        let screen = Screens::new(driver.clone());
        let stop = CancellationToken::new();
        let a = screen
            .perform(
                "web:a",
                &json!({"action":"capture"}),
                false,
                false,
                stop.clone(),
            )
            .await
            .unwrap();
        let b = screen
            .perform(
                "web:b",
                &json!({"action":"capture"}),
                false,
                false,
                stop.clone(),
            )
            .await
            .unwrap();
        let click = json!({"action":"input","frameId":a["frameId"],"input":{"type":"click","x":49.5,"y":49.5,"button":"left","count":1}});
        assert!(screen
            .perform("web:b", &click, true, false, stop.clone())
            .await
            .is_err());
        screen
            .perform("web:a", &click, true, false, stop.clone())
            .await
            .unwrap();
        assert_eq!(driver.inputs.lock().unwrap()[0]["x"], 0.5);
        assert!(screen.perform("web:b",&json!({"action":"input","frameId":b["frameId"],"input":{"type":"key","key":"Enter","modifiers":[]}}),false,false,stop).await.is_err());
    }
    #[tokio::test]
    async fn layouts_expiry_and_cancellation_are_checked() {
        let driver = Arc::new(Fake::default());
        let screen = Screens::new(driver.clone());
        let stop = CancellationToken::new();
        let shot = screen
            .perform(
                "task:a",
                &json!({"action":"capture"}),
                false,
                false,
                stop.clone(),
            )
            .await
            .unwrap();
        driver.width.store(10, std::sync::atomic::Ordering::SeqCst);
        assert!(screen.perform("task:a",&json!({"action":"input","frameId":shot["frameId"],"input":{"type":"text","text":"hello"}}),false,false,stop.clone()).await.is_err());
        let shot = screen
            .perform(
                "task:a",
                &json!({"action":"capture"}),
                false,
                false,
                stop.clone(),
            )
            .await
            .unwrap();
        screen
            .frames
            .lock()
            .unwrap()
            .get_mut(shot["frameId"].as_str().unwrap())
            .unwrap()
            .at = Instant::now() - Duration::from_secs(61);
        assert!(screen.perform("task:a",&json!({"action":"input","frameId":shot["frameId"],"input":{"type":"text","text":"hello"}}),false,false,stop.clone()).await.is_err());
        let lock = screen.queue.lock().await;
        let client = screen.clone();
        let task = tokio::spawn(async move {
            client
                .perform(
                    "web:c",
                    &json!({"reqId":"cancel-me","action":"capture"}),
                    false,
                    false,
                    stop,
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        screen.cancel("web:c", "cancel-me");
        assert!(task.await.unwrap().is_err());
        drop(lock);
        assert!(driver.inputs.lock().unwrap().is_empty());
    }
    #[test]
    fn input_bounds_and_keys() {
        for input in [
            json!({"type":"click","x":-1,"y":0,"button":"left","count":1}),
            json!({"type":"key","key":"Unknown","modifiers":[]}),
            json!({"type":"key","key":"Enter","modifiers":["superuser"]}),
            json!({"type":"text","text":""}),
        ] {
            assert!(validate_input(&input).is_err());
        }
        assert!(validate_input(&json!({"type":"key","key":"Enter","modifiers":["meta"]})).is_ok());
    }
}
