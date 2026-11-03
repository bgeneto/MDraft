// The page works without this file. It only adds the theme toggle and the
// screenshot lightbox; every image is still a link to its full-size file.

(() => {
  const root = document.documentElement;
  const storageKey = "mdraft-theme";
  const toggle = document.querySelector("[data-theme-toggle]");
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const currentTheme = () => root.dataset.theme || (media.matches ? "dark" : "light");

  function updateToggle() {
    if (!toggle) return;
    const dark = currentTheme() === "dark";
    const label = dark ? toggle.dataset.labelLight : toggle.dataset.labelDark;
    if (label) toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-pressed", String(dark));
  }

  if (toggle) {
    updateToggle();
    toggle.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // A private window may refuse storage; the theme still changes for
        // this page, it just is not remembered.
      }
      updateToggle();
    });
    media.addEventListener?.("change", updateToggle);
  }

  const dialog = document.getElementById("lightbox");
  const links = [...document.querySelectorAll("a.shot[data-full]")];
  if (!dialog || typeof dialog.showModal !== "function" || links.length === 0) return;

  const image = dialog.querySelector("[data-lightbox-image]");
  const caption = dialog.querySelector("[data-lightbox-caption]");
  const closeButton = dialog.querySelector("[data-lightbox-close]");
  const previousButton = dialog.querySelector("[data-lightbox-prev]");
  const nextButton = dialog.querySelector("[data-lightbox-next]");
  if (!image || !caption || !closeButton || !previousButton || !nextButton) return;

  let opener = null;
  let group = [];
  let index = 0;

  function render() {
    const link = group[index];
    const thumbnail = link.querySelector("img");
    image.src = link.dataset.full || link.href;
    image.alt = thumbnail?.alt || "";
    caption.textContent = link.dataset.caption || "";
    const multiple = group.length > 1;
    previousButton.hidden = !multiple;
    nextButton.hidden = !multiple;
  }

  function open(link) {
    opener = link;
    const gallery = link.dataset.gallery;
    group = gallery ? links.filter((item) => item.dataset.gallery === gallery) : [link];
    index = Math.max(0, group.indexOf(link));
    render();
    document.body.classList.add("lightbox-open");
    dialog.showModal();
    closeButton.focus();
  }

  function step(delta) {
    if (group.length < 2) return;
    index = (index + delta + group.length) % group.length;
    render();
  }

  for (const link of links) {
    link.addEventListener("click", (event) => {
      // Let the browser handle a new-tab/new-window request: the href is the
      // full image and remains a working fallback.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(link);
    });
  }

  closeButton.addEventListener("click", () => dialog.close());
  previousButton.addEventListener("click", () => step(-1));
  nextButton.addEventListener("click", () => step(1));

  // The dialog element receives the click only when the backdrop is the target;
  // clicks on the image or its caption stay inside .lightbox-inner.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
  });

  dialog.addEventListener("close", () => {
    document.body.classList.remove("lightbox-open");
    image.removeAttribute("src");
    if (opener?.isConnected) opener.focus();
    opener = null;
  });
})();
