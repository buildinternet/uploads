import "./canvas.module.css";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@uploads/ui";

export function FileSettings() {
  return (
    <div style={{ width: 360 }}>
      <Accordion openMultiple defaultValue={["visibility"]}>
        <AccordionItem value="visibility">
          <AccordionTrigger>Visibility</AccordionTrigger>
          <AccordionContent>
            This file is shared with anyone who has the link. Workspace members can always view
            it from the file table.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="expiration">
          <AccordionTrigger>Expiration</AccordionTrigger>
          <AccordionContent>
            console-after.png expires 14 days after upload unless promoted to a permanent slug.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="metadata">
          <AccordionTrigger>Metadata</AccordionTrigger>
          <AccordionContent>
            Tagged with gh.pr = 778 and repo = uploads-sh/uploads. Attach context is queryable
            from the CLI with `uploads meta find`.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

export function SingleOpenFAQ() {
  return (
    <div style={{ width: 360 }}>
      <Accordion defaultValue={["billing"]}>
        <AccordionItem value="workspace">
          <AccordionTrigger>What is the Dev demo workspace?</AccordionTrigger>
          <AccordionContent>
            A shared sandbox workspace used for screenshot verification and demo recipes.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="billing">
          <AccordionTrigger>How does plan-aware billing work?</AccordionTrigger>
          <AccordionContent>
            Pro workspaces are billed monthly via Stripe and unlock higher storage and member
            caps than the free tier.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="disabled">
          <AccordionTrigger disabled>Enterprise SSO (coming soon)</AccordionTrigger>
          <AccordionContent>Not yet available.</AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
