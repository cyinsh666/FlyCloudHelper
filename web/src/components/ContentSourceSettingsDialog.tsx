import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 在线内容源详情弹窗使用单个状态对象，操作完成前保留当前内容。 */
interface ContentSourceSettingsDialogState {
  title: string;
  description?: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** 复用控制台弹窗布局，集中展示同步、分类及诊断的详细内容。 */
export function ContentSourceSettingsDialog({ state }: { state: ContentSourceSettingsDialogState }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // 关键变量：键盘事件读取最新操作状态，不因每次刷新重新锁滚动或重置焦点。
  const currentStateRef = useRef(state);
  currentStateRef.current = state;

  /** 保存或检测期间禁止关闭，普通关闭交给调用方丢弃未保存草稿。 */
  function requestClose(): void {
    if (!currentStateRef.current.busy) currentStateRef.current.onClose();
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    /** 将键盘焦点保留在当前弹窗内，避免操作被遮挡的页面控件。 */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!currentStateRef.current.busy) currentStateRef.current.onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      // 关键变量：仅包含可见、可操作的控件，检测和保存期间可能只剩弹窗本身。
      const focusableElements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0);
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const activeElement = document.activeElement;
      if (!dialogRef.current.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (activeElement === first || activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/65 p-3 sm:p-4"
      onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={state.description ? descriptionId : undefined}
        aria-busy={state.busy}
        tabIndex={-1}
        className="relative flex max-h-[90vh] w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">{state.title}</h2>
            {state.description && <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">{state.description}</p>}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label={`关闭${state.title}`}
            disabled={state.busy}
            onClick={requestClose}
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable] sm:p-5">
          {state.children}
        </div>
      </section>
    </div>,
    document.body,
  );
}
