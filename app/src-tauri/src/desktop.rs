use agentic::{
    config::{self, Config},
    device::{self, DeviceHandle},
};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::watch;

struct State {
    config: Mutex<Option<Config>>,
    device: tokio::sync::Mutex<Option<DeviceHandle>>,
    status: watch::Sender<String>,
}

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("只有本地设置窗口可以调用此功能".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    if url.scheme() != "tauri"
        && !(url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
    {
        return Err("网页无权访问本机配置".into());
    }
    Ok(())
}

#[tauri::command]
fn read_settings(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<State>>,
) -> Result<Option<Config>, String> {
    trusted(&window)?;
    Ok(state.config.lock().unwrap().clone())
}

#[tauri::command]
async fn save_settings(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<State>>,
    mut input: Config,
) -> Result<(), String> {
    trusted(&window)?;
    {
        let current = state.config.lock().unwrap();
        if input.token.trim().is_empty() {
            if let Some(current) = current.as_ref() {
                if input.url.trim().trim_end_matches('/') == current.url {
                    input.token = current.token.clone();
                }
            }
        }
    }
    let saved = tokio::task::spawn_blocking(move || config::save(&agentic::state_dir(), input))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut device = state.device.lock().await;
    if let Some(old) = device.take() {
        old.shutdown().await;
    }
    *state.config.lock().unwrap() = Some(saved.clone());
    *device = Some(device::start(
        saved.clone(),
        agentic::state_dir(),
        state.status.clone(),
        true,
    ));
    // Replace the webview when changing services so the previous origin is never reused.
    if let Some(main) = app.get_webview_window("main") {
        main.destroy().map_err(|e| e.to_string())?;
    }
    show_main(&app, &saved).map_err(|e| e.to_string())?;
    window.hide().map_err(|e| e.to_string())?;
    Ok(())
}

fn settings(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("agentic 连接设置")
        .inner_size(580.0, 800.0)
        .resizable(false)
        .build()?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle, config: &Config) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        return Ok(());
    }
    let url: url::Url = config.url.parse().expect("validated service URL");
    let origin = url.origin();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("agentic")
        .inner_size(1120.0, 820.0)
        .min_inner_size(640.0, 480.0)
        .on_new_window(|url, _| {
            if ["https", "http"].contains(&url.scheme()) {
                let _ = std::process::Command::new("/usr/bin/open")
                    .arg(url.as_str())
                    .spawn();
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            if url.origin() == origin {
                return true;
            }
            if ["https", "http"].contains(&url.scheme()) {
                let _ = std::process::Command::new("/usr/bin/open")
                    .arg(url.as_str())
                    .spawn();
            }
            false
        })
        .build()?;
    Ok(())
}

fn show(app: &tauri::AppHandle) {
    let state = app.state::<Arc<State>>();
    let config = state.config.lock().unwrap().clone();
    let result = if let Some(config) = config {
        show_main(app, &config)
    } else {
        settings(app)
    };
    if let Err(error) = result {
        eprintln!("无法打开窗口：{error}");
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .invoke_handler(tauri::generate_handler![read_settings, save_settings])
        .setup(|app| {
            let (status, mut updates) = watch::channel("未连接".to_owned());
            let config = match config::load(&agentic::state_dir()) {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("连接设置读取失败：{error}");
                    None
                }
            };
            let state = Arc::new(State {
                config: Mutex::new(config.clone()),
                device: tokio::sync::Mutex::new(None),
                status,
            });
            app.manage(state.clone());
            let open = MenuItem::with_id(app, "open", "打开 agentic", true, None::<&str>)?;
            let setting = MenuItem::with_id(app, "settings", "连接设置…", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "重新加载网页", true, None::<&str>)?;
            let extension =
                MenuItem::with_id(app, "extension", "打开浏览器插件文件夹", true, None::<&str>)?;
            let status_item =
                MenuItem::with_id(app, "status", "本机执行端：未连接", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 agentic", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(
                app,
                &[
                    &status_item,
                    &open,
                    &reload,
                    &setting,
                    &extension,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            TrayIconBuilder::with_id("agentic")
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../../../build/trayTemplate.png"
                ))?)
                .icon_as_template(true)
                .tooltip("agentic")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "settings" => {
                        let _ = settings(app);
                    }
                    "reload" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.reload();
                        }
                    }
                    "extension" => {
                        let path = if cfg!(debug_assertions) {
                            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                                .join("../../extension")
                        } else {
                            app.path()
                                .resource_dir()
                                .unwrap_or_default()
                                .join("extension")
                        };
                        let _ = std::process::Command::new("/usr/bin/open")
                            .arg(path)
                            .spawn();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            // Native Edit menu supplies standard keyboard shortcuts in WKWebView.
            let application = Submenu::with_items(
                app,
                "agentic",
                true,
                &[
                    &MenuItem::with_id(app, "settings", "连接设置…", true, Some("CmdOrCtrl+,"))?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit = Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&application, &edit])?)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(config) = config {
                    *state.device.lock().await = Some(device::start(
                        config,
                        agentic::state_dir(),
                        state.status.clone(),
                        true,
                    ));
                }
                while updates.changed().await.is_ok() {
                    let label = format!("本机执行端：{}", updates.borrow().clone());
                    let item = status_item.clone();
                    let _ = handle.run_on_main_thread(move || {
                        let _ = item.set_text(label);
                    });
                }
            });
            show(app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "settings" {
                let _ = settings(app);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动 agentic")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                let state = app.state::<Arc<State>>();
                tauri::async_runtime::block_on(async {
                    if let Some(device) = state.device.lock().await.take() {
                        device.shutdown().await;
                    }
                });
            }
            tauri::RunEvent::Reopen { .. } => show(app),
            _ => {}
        });
}
