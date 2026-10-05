/** "Load more" for a cursor list, with its inline failure note. Render only while a next cursor exists. */
export function LoadMoreFooter({
  more,
  onLoadMore,
}: {
  more: "idle" | "loading" | "error";
  onLoadMore: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        className="text-btn text-btn--boxed"
        onClick={onLoadMore}
        disabled={more === "loading"}
      >
        {more === "loading" ? "Loading…" : "Load more"}
      </button>
      {more === "error" && (
        <span role="alert" className="text-[12px] text-muted-foreground">
          Couldn’t load more. Try again.
        </span>
      )}
    </div>
  );
}
