fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--native-host") {
        let socket = args
            .windows(2)
            .find(|pair| pair[0] == "--socket")
            .map(|pair| std::path::PathBuf::from(&pair[1]));
        let runtime = tokio::runtime::Runtime::new().expect("无法启动运行时");
        let result = socket
            .ok_or_else(|| anyhow::anyhow!("缺少浏览器管道地址"))
            .and_then(|socket| runtime.block_on(agentic::browser::native_host(&socket)));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        // Tokio stdin uses a blocking reader; exit explicitly when the browser pipe closes.
        std::process::exit(0);
    }
    if args.iter().any(|arg| arg == "--headless") {
        let runtime = tokio::runtime::Runtime::new().expect("无法启动运行时");
        runtime.block_on(async {
            let config = agentic::config::Config {
                url: std::env::var("CLOUDFLARE_WORKER_URL").unwrap_or_default(),
                token: std::env::var("DEVICE_TOKEN").unwrap_or_default(),
                name: std::env::var("DEVICE_NAME").unwrap_or_default(),
                description: std::env::var("DEVICE_DESCRIPTION").unwrap_or_default(),
            }
            .validate()
            .expect("设备配置无效");
            let (status, mut updates) = tokio::sync::watch::channel(String::new());
            tokio::spawn(async move {
                while updates.changed().await.is_ok() {
                    eprintln!("{}", *updates.borrow());
                }
            });
            let device = agentic::device::start(
                config,
                agentic::state_dir(),
                status,
                !args.iter().any(|arg| arg == "--no-browser"),
            );
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("无法监听退出信号");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            device.shutdown().await;
        });
        return;
    }
    #[cfg(feature = "desktop")]
    desktop::run();
    #[cfg(not(feature = "desktop"))]
    {
        eprintln!("此构建只支持 --headless / --native-host");
        std::process::exit(1);
    }
}

#[cfg(feature = "desktop")]
mod desktop;
