import "./canvas.module.css";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@uploads/ui";

const paths = ["/settings", "/settings/billing", "/checkout", "/checkout/success", "/f/console-after"];

export function PathFilter() {
  return (
    <Combobox items={paths} defaultValue="/settings/billing" open>
      <ComboboxInput placeholder="Filter by path…" />
      <ComboboxContent>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>No paths match</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
