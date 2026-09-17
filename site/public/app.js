const demos = {
  browser: {
    title: "收集资料，整理成报告",
    prompt: "打开产品网页，提取主要功能，帮我整理成一份本地笔记。",
    intro: "我会先查看网页，再把要点整理到你的工作目录。",
    tool: "浏览器 · 读取页面内容",
    toolDetail: "访问网页，提取标题与正文",
    result: "写入 · 产品调研.md",
    resultDetail: "已保存到本地工作目录",
    finish: "笔记整理好了，包含产品定位、主要功能和来源链接。",
    file: "产品调研.md",
    fileType: "MD",
    tab: "产品介绍",
    address: "agentic.iimos.ai",
    eyebrow: "MEET YOUR AGENT",
    docTitle: "从想法，\n到完成。",
    docDesc: "让对话连接行动。\n在你的电脑上，开始下一件事。",
    pointOne: "本地执行",
    pointTwo: "浏览器操作",
    pointThree: "远程对话",
    browserStatus: "页面内容已读取",
    icon: "globe",
  },
  local: {
    title: "整理项目文件",
    prompt: "看看这个项目的文件结构，整理一份开发说明，保存到 README.md。",
    intro: "我会读取目录和主要文件，再整理项目结构与启动方式。",
    tool: "命令 · 查看项目结构",
    toolDetail: "读取目录，检查依赖与运行脚本",
    result: "写入 · README.md",
    resultDetail: "开发说明已保存到项目目录",
    finish: "说明已经整理好，包含目录职责、安装步骤和启动命令。",
    file: "README.md",
    fileType: "MD",
    tab: "项目文档",
    address: "docs.example.com/project",
    eyebrow: "LOCAL WORKSPACE",
    docTitle: "熟悉项目，\n开始工作。",
    docDesc: "读取真实文件。\n让每一步工作，都有具体结果。",
    pointOne: "目录结构",
    pointTwo: "安装与运行",
    pointThree: "开发说明",
    browserStatus: "文档已整理到本地",
    icon: "terminal",
  },
  remote: {
    title: "远程继续对话",
    prompt: "我在另一台设备上。继续刚才的调研，把结果再整理成一份简报。",
    intro: "继续使用这个对话的上下文，在你的电脑上整理简报。",
    tool: "读取 · 产品调研.md",
    toolDetail: "通过远程对话，调用本机工具",
    result: "写入 · 调研简报.md",
    resultDetail: "文件保存在运行 agentic 的电脑上",
    finish: "简报已保存。你可以继续在这里对话，或回到电脑查看文件。",
    file: "调研简报.md",
    fileType: "MD",
    tab: "远程对话",
    address: "专属远程会话链接",
    eyebrow: "PICK UP WHERE YOU LEFT OFF",
    docTitle: "换个设备，\n接着工作。",
    docDesc: "保持桌面客户端运行。\n在另一个地方，继续同一段对话。",
    pointOne: "按对话开启连接",
    pointTwo: "由本机继续执行",
    pointThree: "实时同步结果",
    browserStatus: "远程会话已连接",
    icon: "link",
  },
};

const fields = [
  "title",
  "prompt",
  "intro",
  "tool",
  "toolDetail",
  "result",
  "resultDetail",
  "finish",
  "file",
  "fileType",
  "tab",
  "address",
  "eyebrow",
  "docTitle",
  "docDesc",
  "pointOne",
  "pointTwo",
  "pointThree",
  "browserStatus",
];
const buttons = document.querySelectorAll("[data-demo]");
for (const button of buttons) {
  button.addEventListener("click", () => {
    const demo = demos[button.dataset.demo];
    for (const field of fields) {
      const id = "demo-" + field.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
      document.getElementById(id).textContent = demo[field];
    }
    document.getElementById("demo-doc-title").style.whiteSpace = "pre-line";
    document.getElementById("demo-doc-desc").style.whiteSpace = "pre-line";
    document.querySelector("#demo-tool-icon use").setAttribute("href", "#" + demo.icon);
    document.querySelector("#demo-doc-icon use").setAttribute("href", "#" + demo.icon);
    for (const option of buttons) {
      const selected = option === button;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    }
  });
}
