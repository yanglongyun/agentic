export interface Download {
  id: string;
  name: string;
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  received: number;
  total: number;
  createdAt: number;
}
export interface BrowserSettings {
  searchEngine: string;
  downloadDirectory: string;
  permissions: Record<string, boolean>;
}
export interface AuthRequest {
  id: string;
  host: string;
  realm: string;
  proxy: boolean;
}
export interface ImportedBookmark {
  title: string;
  url?: string;
  children?: ImportedBookmark[];
}
declare global {
  interface Window {
    agenticDesktop?: {
      onOpenTab(
        callback: (detail: { url: string; background: boolean; openerId?: string }) => void,
      ): () => void;
      onDownload(callback: (detail: Download) => void): () => void;
      onCommand(callback: (detail: { command: string; tabId: string }) => void): () => void;
      onAuth(callback: (detail: AuthRequest) => void): () => void;
      onAuthClosed(callback: (id: string) => void): () => void;
      state(): Promise<{
        settings: BrowserSettings;
        downloads: Download[];
        importSupported: boolean;
      }>;
      visible(value: boolean): Promise<void>;
      register(id: string, contentsId: number | null): Promise<void>;
      openExternal(url: string): Promise<void>;
      downloadAction(
        action: "cancel" | "reveal" | "clear",
        id?: string,
      ): Promise<Download[] | void>;
      pageAction(id: string, action: "print" | "screenshot" | "devtools"): Promise<string | void>;
      saveSettings(
        patch: Partial<Pick<BrowserSettings, "searchEngine" | "downloadDirectory">>,
      ): Promise<BrowserSettings>;
      chooseDirectory(): Promise<string | null>;
      revokePermission(key: string): Promise<BrowserSettings>;
      clearData(kind: "cache" | "logins"): Promise<void>;
      answerAuth(answer: {
        id: string;
        cancel?: boolean;
        username?: string;
        password?: string;
      }): Promise<void>;
      chromeProfiles(): Promise<{ id: string; name: string }[]>;
      importChrome(
        profile: string,
        kind: "bookmarks" | "cookies",
      ): Promise<{ bookmarks?: ImportedBookmark[]; imported?: number; failed?: number }>;
    };
  }
}
