export function browserShortcut(input) {
  if (input.type !== "keyDown") {
    return "";
  }
  const key = input.key.toLowerCase();
  if (input.alt && key === "arrowleft") {
    return "back";
  }
  if (input.alt && key === "arrowright") {
    return "forward";
  }
  if (!(input.meta || input.control)) {
    return "";
  }
  if (key === "l") {
    return "address";
  }
  if (key === "t") {
    return input.shift ? "reopen" : "new";
  }
  if (key === "w") {
    return "close";
  }
  if (key === "r") {
    return "reload";
  }
  if (key === "f") {
    return "find";
  }
  if (key === "p") {
    return "print";
  }
  if (key === "d") {
    return "bookmark";
  }
  if (key === "=" || key === "+") {
    return "zoom-in";
  }
  if (key === "-") {
    return "zoom-out";
  }
  if (key === "0") {
    return "zoom-reset";
  }
  if (key === "tab") {
    return input.shift ? "previous-tab" : "next-tab";
  }
  return "";
}
