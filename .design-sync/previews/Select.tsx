import "./canvas.module.css";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@uploads/ui";

export function VisibilityPicker() {
  return (
    <Select defaultValue="unlisted" open>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="public">Public</SelectItem>
        <SelectItem value="unlisted">Unlisted</SelectItem>
      </SelectContent>
    </Select>
  );
}
