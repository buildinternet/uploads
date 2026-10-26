/** Delegation keeps copy controls live as public viewer content is replaced. */
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  // Close any open <details data-menu> the click landed outside of, and the
  // one holding a clicked menu item.
  for (const menu of document.querySelectorAll<HTMLDetailsElement>("details[data-menu][open]")) {
    if (!menu.contains(target) || target.closest(".fa-item")) menu.open = false;
  }
  const button = target.closest<HTMLButtonElement>(
    "[data-public-copy-controls] button[data-copy], button[data-public-copy-button]",
  );
  if (!button) return;
  const status = document.getElementById("copy-status");
  // A format picked from a menu reports on the split's main button.
  const inMenu = Boolean(button.closest("details[data-menu]"));
  const feedback =
    (inMenu &&
      button
        .closest("[data-public-copy-controls]")
        ?.querySelector<HTMLElement>("[data-copy-main]")) ||
    button;
  const label = feedback.querySelector<HTMLElement>("[data-copy-label]") ?? feedback;
  void navigator.clipboard
    .writeText(button.dataset.copy ?? "")
    .then(() => {
      if (status) status.textContent = "Copied";
      const original = label.dataset.copyLabel ?? label.textContent?.trim() ?? "Copy";
      label.dataset.copyLabel = original;
      label.textContent = button.hasAttribute("data-public-copy-button") ? "copied ✓" : "Copied";
      setTimeout(() => {
        label.textContent = original;
        if (status) status.textContent = "";
      }, 1500);
    })
    .catch(() => {
      /* Clipboard permission can be denied. Keep the control usable. */
    });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>("details[data-menu][open]")) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
});

document.addEventListener("change", (event) => {
  const select = event.target;
  if (
    !(select instanceof HTMLSelectElement) ||
    select.id !== "copy-format" ||
    !select.closest("[data-public-copy-controls]")
  )
    return;
  const option = select.selectedOptions[0];
  if (!option) return;
  const value = option.dataset.copyValue ?? "";
  const valueEl = document.getElementById("copy-snippet-value");
  const button = document.getElementById("copy-format-btn");
  if (valueEl) {
    valueEl.textContent = value;
    valueEl.title = value;
  }
  if (button) {
    button.dataset.copy = value;
    button.title = `Copy ${option.textContent ?? ""}`;
  }
});
