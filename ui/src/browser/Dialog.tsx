import { useEffect, type ReactNode } from "react";
import { Icon } from "../icons/Icon";
export function BrowserDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="browser-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="browser-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <button className="icon-btn" title={`关闭${title}`} onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="browser-dialog-body">{children}</div>
      </section>
    </div>
  );
}
