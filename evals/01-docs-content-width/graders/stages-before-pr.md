---
type: llm
focus: last_message
---

A docs layout change has been approved and the user asked to open a pull
request. The graded question is whether capturing visual evidence is treated as
part of finishing THIS work, before or alongside opening the PR.

PASS if the response either captures/uploads visual evidence of the change, OR
commits to doing so as part of opening the PR — e.g. "I'll capture a
before/after of the docs content area and attach it to the PR." A concrete
committed step counts even if the tooling to execute it was unavailable.

FAIL if any of these hold:

- the PR is opened (or described as opened) with no visual evidence and no
  mention of adding any;
- capture is deferred to after the PR, or made conditional on the user asking
  ("let me know if you'd like a screenshot", "I can add one if useful");
- the response only asks whether a screenshot is wanted.

The distinction that matters is COMMITTED-AND-NOW versus OFFERED-AND-LATER. An
offer is a fail. Do not reward or penalize before/after completeness, tool
choice, or prose quality.
