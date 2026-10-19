/** Delegation keeps copy controls live as public viewer content is replaced. */
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>(
    "[data-public-copy-controls] button[data-copy], button[data-public-copy-button]",
  );
  if (!button) return;
  const status = document.getElementById("copy-status");
  void navigator.clipboard
    .writeText(button.dataset.copy ?? "")
    .then(() => {
      if (status) status.textContent = "Copied";
      const original = button.dataset.copyLabel ?? button.textContent?.trim() ?? "Copy";
      button.dataset.copyLabel = original;
      button.textContent = button.id === "copy-format-btn" ? "Copied" : "copied ✓";
      setTimeout(() => {
        button.textContent = original;
        if (status) status.textContent = "";
      }, 1500);
    })
    .catch(() => {
      /* Clipboard permission can be denied. Keep the control usable. */
    });
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
