/** Delegation keeps copy controls live as public viewer content is replaced. */
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>(
    "[data-public-copy-controls] button[data-copy], button[data-public-copy-button]",
  );
  if (button) {
    const status = document.getElementById("copy-status");
    void navigator.clipboard
      .writeText(button.dataset.copy ?? "")
      .then(() => {
        if (button.hasAttribute("data-copy-icon")) {
          const copyIcon = button.querySelector(".icon-copy");
          const checkIcon = button.querySelector(".icon-check");
          copyIcon?.classList.add("is-hidden");
          checkIcon?.classList.remove("is-hidden");
          if (status) status.textContent = "Copied";
          setTimeout(() => {
            copyIcon?.classList.remove("is-hidden");
            checkIcon?.classList.add("is-hidden");
            if (status) status.textContent = "";
          }, 1500);
        } else {
          const original = button.dataset.copyLabel ?? button.textContent ?? "Copy";
          button.dataset.copyLabel = original;
          button.textContent = "copied ✓";
          setTimeout(() => {
            button.textContent = original;
          }, 1500);
        }
      })
      .catch(() => {
        /* Clipboard permission can be denied. Keep the control usable. */
      });
    return;
  }
  const snippet = target.closest<HTMLElement>("[data-public-copy-controls] #copy-snippet");
  snippet?.querySelector<HTMLButtonElement>("#copy-format-btn")?.click();
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
  if (valueEl) valueEl.textContent = value;
  if (button) {
    button.dataset.copy = value;
    button.setAttribute("aria-label", `Copy ${option.textContent ?? ""}`);
  }
});
