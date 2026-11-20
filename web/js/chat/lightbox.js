// Full-size view of a picture (user attachments, images in tool results): bus.emit("view-image", { mediaType, data, name? }).
import { h, ibtn } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { bus } from "../core/state.js";

export function openLightbox(image) {
  if (!image?.data) return;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  const overlay = h(
    "div.lightbox",
    { role: "dialog", "aria-modal": "true", "aria-label": image.name || t("Image"), onclick: (event) => event.target === overlay && close() },
    h("img", { src: `data:${image.mediaType || "image/png"};base64,${image.data}`, alt: image.name || t("Image") }),
    ibtn("x", t("Close"), close, { cls: "lightbox-close" }),
  );
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  overlay.querySelector(".lightbox-close")?.focus();
}

bus.on("view-image", openLightbox);
