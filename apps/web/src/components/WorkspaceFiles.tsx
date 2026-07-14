import { Button, Field, Input } from "@uploads/ui";
import { useState } from "react";
import { AccountFileBrowser } from "./AccountFileBrowser";
import { MetadataSearchResults } from "./MetadataSearchResults";
import {
  isValidMetaKey,
  isValidMetaValue,
  replaceSearchLocation,
  type MetaFilter,
} from "../lib/workspace-search-url";

interface WorkspaceFilesProps {
  apiOrigin: string;
  workspace: string;
  hasPublicUrl: boolean;
  initialPrefix?: string;
  initialFilters?: MetaFilter[];
  onPrefixChange?: (prefix: string) => void;
}

const EXAMPLE_KEYS = ["gh.repo", "app", "page"];

export function WorkspaceFiles({
  apiOrigin,
  workspace,
  hasPublicUrl,
  initialPrefix = "",
  initialFilters = [],
  onPrefixChange,
}: WorkspaceFilesProps) {
  const [filters, setFilters] = useState<MetaFilter[]>(initialFilters);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: MetaFilter[]) => {
    setFilters(next);
    replaceSearchLocation(workspace, next);
  };

  const addFilter = () => {
    const k = key.trim();
    const v = value.trim();
    if (!isValidMetaKey(k)) {
      setError("Key must be lowercase letters/digits/._- and start with a letter.");
      return;
    }
    if (!isValidMetaValue(v)) {
      setError("Value must be 1–512 printable ASCII characters.");
      return;
    }
    if (filters.some((f) => f.key === k)) {
      setError(`Already filtering on "${k}".`);
      return;
    }
    if (filters.length >= 24) {
      setError("At most 24 filters.");
      return;
    }
    setError(null);
    setKey("");
    setValue("");
    commit([...filters, { key: k, value: v }]);
  };

  const removeFilter = (k: string) => commit(filters.filter((f) => f.key !== k));

  return (
    <div className="ws-files">
      <form
        className="ws-search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          addFilter();
        }}
      >
        <Field>
          <Input
            aria-label="Metadata key"
            placeholder="key (e.g. gh.repo)"
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            list={`ws-search-keys-${workspace}`}
          />
        </Field>
        <Field>
          <Input
            aria-label="Metadata value"
            placeholder="value"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
        </Field>
        <Button type="submit">Add filter</Button>
        <datalist id={`ws-search-keys-${workspace}`}>
          {EXAMPLE_KEYS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </form>
      {error && (
        <p className="ws-search-error" role="alert">
          {error}
        </p>
      )}

      {filters.length === 0 ? (
        <AccountFileBrowser
          apiOrigin={apiOrigin}
          workspace={workspace}
          hasPublicUrl={hasPublicUrl}
          initialPrefix={initialPrefix}
          onPrefixChange={onPrefixChange}
        />
      ) : (
        <MetadataSearchResults
          apiOrigin={apiOrigin}
          workspace={workspace}
          filters={filters}
          onRemoveFilter={removeFilter}
        />
      )}
    </div>
  );
}
