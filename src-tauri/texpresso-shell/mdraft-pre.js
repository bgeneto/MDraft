  // MDraft embeds this page as a preview-only frame. Bundle data goes through
  // the app's own origin (`/texpresso-data` in dev, the `mdraft-tex` scheme in
  // the Tauri build), never directly to a third-party host.
  try {
    localStorage.setItem("texpresso.welcomed", "1");
  } catch {}
  // The frame owns no dialogs. A welcome, feedback or settings dialog would
  // cover the preview; leave the app's own modal state untouched but never show
  // it in the embedded frame.
  const __mdraftShowModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...args) {
    if (
      ["welcome-dialog", "feedback-dialog", "projects-dialog", "settings-dialog", "definition-dialog", "zip-dialog"].includes(
        this.id,
      )
    )
      return;
    return __mdraftShowModal.apply(this, args);
  };
try {
  Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined, configurable: true });
} catch {}
