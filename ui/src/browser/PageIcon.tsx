import { useEffect, useState } from "react";
import { Icon } from "../icons/Icon";
export function PageIcon({ icon = "", loading = false }: { icon?: string; loading?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [icon]);
  let content = <Icon name="globe" size={14} />;
  if (icon && !failed) {
    content = <img src={icon} alt="" onError={() => setFailed(true)} />;
  }
  if (loading) {
    content = <span className="browser-spinner" />;
  }
  return <span className="browser-page-icon">{content}</span>;
}
