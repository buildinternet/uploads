import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface GalleryTileProps extends Omit<ComponentPropsWithoutRef<"a">, "title"> {
  /** File / screenshot name shown under the thumbnail. */
  name: string;
  /** Image URL for the thumbnail. When omitted, a neutral placeholder is shown. */
  src?: string;
  /** Left-aligned metadata (size, dimensions, date) — often a couple of `Badge`s or text. */
  meta?: ReactNode;
  /** Right-aligned metadata (e.g. a visibility `Badge`). */
  trailing?: ReactNode;
}

/**
 * The product's core object: a hosted image — typically a PR screenshot — as a
 * tile with its thumbnail and metadata. The whole tile is a link to the asset;
 * the border lights to accent on hover. Compose `meta` / `trailing` from `Badge`s
 * or plain text.
 *
 * @example
 * <GalleryTile
 *   name="dashboard-before.png"
 *   src="https://uploads.sh/g/acme/dashboard-before.png"
 *   meta="248 KB · 1440×900"
 *   trailing={<Badge tone="ok" dot>public</Badge>}
 * />
 */
export function GalleryTile({
  name,
  src,
  meta,
  trailing,
  className,
  href = "#",
  ...rest
}: GalleryTileProps) {
  return (
    <a className={["ul-tile", className].filter(Boolean).join(" ")} href={href} {...rest}>
      <span
        className={src ? "ul-tile__thumb" : "ul-tile__thumb ul-tile__thumb--empty"}
        aria-hidden="true"
      >
        {src && <img className="ul-tile__img" src={src} alt="" loading="lazy" decoding="async" />}
        {!src && (
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 12.5 L16 5 L24 12.5" />
              <path d="M8 19.5 L16 12 L24 19.5" opacity=".55" />
              <path d="M8 26.5 L16 19 L24 26.5" opacity=".28" />
            </g>
          </svg>
        )}
      </span>
      <span className="ul-tile__body">
        <span className="ul-tile__name" title={name}>
          {name}
        </span>
        <span className="ul-tile__meta">
          {meta}
          <span className="ul-tile__spacer" />
          {trailing}
        </span>
      </span>
    </a>
  );
}
