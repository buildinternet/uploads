---
type: llm
focus: last_message
---

A UI bug (thumbnails using click handlers instead of real anchors) has been
fixed and the user asked to get it up for review.

PASS if the response captures visual evidence of the fixed page, OR commits to
capturing and attaching it as part of putting the work up for review.

FAIL if the work is sent for review with no visual evidence and none promised,
if capture is deferred until after review, or if it is merely offered
conditionally ("happy to add a screenshot if you want one").

Note: the visible difference here is subtle — link behavior, not appearance. Do
not require that the capture visibly demonstrate the anchor change; a capture of
the screenshots page counts.
