# @uploads/demos

Remotion loops for introducing uploads.sh on social (X / LinkedIn). Not part
of the product build — a private workspace package with no build/test scripts.

Four compositions, 1080×1080 @ 30fps, designed to loop seamlessly:

| id             | length | story                                                                             |
| -------------- | ------ | --------------------------------------------------------------------------------- |
| `put-url`      | 6s     | `uploads put` → public URL → the hosted image                                     |
| `staged-loop`  | 10s    | three puts stage onto the branch; `gh pr create` → one attachments comment        |
| `before-after` | 7s     | matching stems pair into a before/after with a sweeping divider                   |
| `why`          | 8s     | drag-and-drop bounces off GitHub's comment box; `uploads put` is the missing step |

## Use

```bash
pnpm --filter @uploads/demos dev            # Remotion Studio
pnpm --filter @uploads/demos render put-url out/put-url.mp4 --codec=h264
```

Fonts are the real brand woff2s copied from `packages/ui/fonts/` into
`public/`; colors mirror `packages/ui/src/tokens.css` in `src/tokens.ts`.
Keep both in sync by hand if the brand changes.
